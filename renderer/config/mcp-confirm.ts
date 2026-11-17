import type {
  McpConfirmAnswer,
  McpConfirmClosed,
  McpConfirmRequest,
  McpDiffLine,
  McpRisk,
} from '../../src/ipc-contract/mcp-api.js';
import { icon } from '../icon.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «Claude Code quiere cambiar un comando»: the dialog an assistant's risky
 * call waits on. Main opens the settings window for every request; this
 * shows them one at a time («1 de 3»), with the human diff main computed,
 * the assistant's own reason and a countdown to the automatic «no».
 *
 * Everything in a request may come from the assistant, so it is painted as
 * text only, never as markup. «Rechazar» takes the focus, so a stray Enter
 * never applies; Esc, or closing the dialog any other way, rejects.
 * «Borrar» (a destructive request) needs a second, deliberate click.
 *
 * Main pushes `onMcpConfirmClosed` for every ending — this window's answer,
 * another window's, the deadline. One that did not come from here says
 * «Ya se respondió» for a moment before the next request shows.
 */

/** The assistant's reason is cut here: a note, not an essay. */
const REASON_MAX = 300;
/** «Borrar» ignores a second click this soon (a double click is no OK)… */
const ARM_DELAY_MS = 500;
/** …and forgets the first one after this long. */
const ARM_WINDOW_MS = 4000;
/** How long «Ya se respondió» stays before the next request. */
const NOTICE_MS = 1500;

const RISK_LABEL: Record<McpRisk, string> = {
  executes: 'Cambia qué se ejecuta',
  destructive: 'Borra datos',
  cosmetic: 'Cosmético',
};
const KIND_LABEL: Partial<Record<McpDiffLine['kind'], string>> = {
  del: 'Quita',
  add: 'Añade',
};
const APPLY_LABEL = 'Aplicar cambio';
const DELETE_LABEL = 'Borrar';
const DELETE_ARMED_LABEL = 'Pulsa otra vez para borrar';

/**
 * Line breaks folded and the invisible characters that could reorder or hide
 * what the user reads (controls, bidi overrides and isolates) dropped.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000B-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function cleanReason(raw: string): string {
  const text = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > REASON_MAX
    ? `${chars.slice(0, REASON_MAX).join('')}…`
    : text;
}

function changedFields(diff: readonly McpDiffLine[]): string {
  const count = new Set(
    diff.filter((line) => line.kind !== 'ctx').map((line) => line.field),
  ).size;
  return count === 1 ? '1 campo' : `${count} campos`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function diffLine(line: McpDiffLine, fieldWidth: number): HTMLElement {
  const row = el('div', 'mcp-diff-line');
  row.dataset.kind = line.kind;
  const said = KIND_LABEL[line.kind];
  if (said) row.append(el('span', 'sr-only', said));
  const field = el('span', 'mcp-diff-field', `${line.field}:`);
  field.style.minWidth = `${fieldWidth + 1}ch`;
  row.append(field, ' ', el('span', 'mcp-diff-text', line.text));
  return row;
}

interface Parts {
  dialog: HTMLDialogElement;
  tile: HTMLElement;
  title: HTMLElement;
  subtitle: HTMLElement;
  risk: HTMLElement;
  queue: HTMLElement;
  count: HTMLElement;
  diff: HTMLElement;
  reason: HTMLElement;
  reasonText: HTMLElement;
  countdown: HTMLElement;
  notice: HTMLElement;
  reject: HTMLButtonElement;
  apply: HTMLButtonElement;
}

function build(): Parts {
  const dialog = el('dialog', 'modal mcp-confirm');
  dialog.id = 'mcp-confirm-dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-labelledby', 'mcp-confirm-title');
  dialog.setAttribute('aria-describedby', 'mcp-confirm-subtitle');

  const tile = el('div', 'mcp-confirm-tile');
  tile.append(icon('triangle-alert'));
  const title = el('h2', 'mcp-confirm-title');
  title.id = 'mcp-confirm-title';
  const subtitle = el('p', 'mcp-confirm-subtitle');
  subtitle.id = 'mcp-confirm-subtitle';
  const heading = el('div', 'mcp-confirm-heading');
  heading.append(title, subtitle);
  const queue = el('span', 'mcp-confirm-queue');
  const risk = el('span', 'mcp-confirm-risk');
  const badges = el('div', 'mcp-confirm-badges');
  badges.append(risk, queue);
  const header = el('header', 'mcp-confirm-header');
  header.append(tile, heading, badges);

  const count = el('span', 'mcp-diff-count');
  const diffHead = el('div', 'mcp-diff-head');
  diffHead.append(el('span', 'mcp-diff-label', 'Cambios'), count);
  const diff = el('div', 'mcp-diff');
  // Focusable so a keyboard can scroll a long line or a long list.
  diff.tabIndex = 0;
  diff.setAttribute('role', 'region');
  diff.setAttribute('aria-label', 'Cambios');
  const diffBox = el('div', 'mcp-diff-box');
  diffBox.append(diffHead, diff);

  const reasonText = el('span', 'mcp-confirm-reason-text');
  const reason = el('p', 'mcp-confirm-reason');
  reason.append(icon('info'), reasonText);
  const note = el(
    'p',
    'mcp-confirm-note',
    'Se guarda una copia antes de aplicar. Puedes deshacerlo desde Ajustes › MCP › Actividad.',
  );
  const body = el('div', 'mcp-confirm-body');
  body.append(diffBox, reason, note);

  const countdown = el('span', 'mcp-confirm-countdown');
  const notice = el('span', 'mcp-confirm-notice');
  notice.setAttribute('role', 'status');
  const reject = el('button', 'mcp-confirm-reject', 'Rechazar');
  reject.type = 'button';
  const apply = el('button', 'primary mcp-confirm-apply', APPLY_LABEL);
  apply.type = 'button';
  const footer = el('footer', 'mcp-confirm-footer');
  footer.append(countdown, notice, reject, apply);

  dialog.append(header, body, footer);
  document.body.append(dialog);
  return {
    dialog,
    tile,
    title,
    subtitle,
    risk,
    queue,
    count,
    diff,
    reason,
    reasonText,
    countdown,
    notice,
    reject,
    apply,
  };
}

/** Builds the dialog into the window and starts listening for requests. */
export function mountMcpConfirm(showToast: ShowToast): void {
  const parts = build();
  const { dialog } = parts;
  /** Waiting requests in arrival order; the first is the one shown. */
  const queue: McpConfirmRequest[] = [];
  /** Ended requests, so a late list never brings one back. */
  const ended = new Set<string>();
  /** Answered from here: their closing push is no news. */
  const answered = new Set<string>();
  let shown: McpConfirmRequest | null = null;
  let busy = false;
  /** When the current «Borrar» got its first click; null when unarmed. */
  let armedAt: number | null = null;
  /** While «Ya se respondió» shows: when it goes. */
  let noticeUntil: number | null = null;
  /** Set while this module closes the dialog, so `close` is not an answer. */
  let closing = false;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const setButtons = (enabled: boolean): void => {
    parts.reject.disabled = !enabled;
    parts.apply.disabled = !enabled;
  };

  const paintApply = (): void => {
    if (shown?.risk !== 'destructive') {
      parts.apply.textContent = APPLY_LABEL;
      return;
    }
    parts.apply.textContent =
      armedAt === null ? DELETE_LABEL : DELETE_ARMED_LABEL;
  };

  const tick = (): void => {
    const now = Date.now();
    if (noticeUntil !== null && now >= noticeUntil) {
      noticeUntil = null;
      advance();
      return;
    }
    if (armedAt !== null && now - armedAt >= ARM_WINDOW_MS) {
      armedAt = null;
      paintApply();
    }
    if (!shown) return;
    const seconds = Math.max(0, Math.ceil((shown.expiresAt - now) / 1000));
    parts.countdown.textContent = `Se rechaza solo en ${seconds} s`;
  };

  const stopTicker = (): void => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };

  const closeDialog = (): void => {
    stopTicker();
    if (!dialog.open) return;
    // Chromium fires `close` a task later; the handler clears this.
    closing = true;
    dialog.close();
  };

  function paint(request: McpConfirmRequest): void {
    shown = request;
    busy = false;
    armedAt = null;
    noticeUntil = null;
    dialog.dataset.risk = request.risk;
    parts.title.textContent = request.title;
    parts.subtitle.textContent = `${request.subtitle} · vía ${request.clientName}`;
    parts.risk.textContent = RISK_LABEL[request.risk];
    parts.count.textContent = changedFields(request.diff);
    const width = Math.max(
      0,
      ...request.diff.map((line) => Array.from(line.field).length),
    );
    parts.diff.replaceChildren(
      ...request.diff.map((line) => diffLine(line, width)),
    );
    parts.diff.scrollTop = 0;
    parts.diff.scrollLeft = 0;
    const reason = request.reason ? cleanReason(request.reason) : '';
    parts.reason.hidden = reason === '';
    parts.reasonText.textContent = reason
      ? `Motivo indicado por el asistente: «${reason}».`
      : '';
    parts.apply.classList.toggle(
      'is-destructive',
      request.risk === 'destructive',
    );
    paintApply();
    parts.countdown.hidden = false;
    parts.notice.hidden = true;
    parts.notice.textContent = '';
    setButtons(true);
    paintQueue();
    tick();
    if (ticker === null) ticker = setInterval(tick, 1000);
    if (!dialog.open) dialog.showModal();
    parts.reject.focus();
  }

  function paintQueue(): void {
    parts.queue.hidden = queue.length < 2;
    parts.queue.textContent = queue.length < 2 ? '' : `1 de ${queue.length}`;
  }

  /** Shows the head of the queue, or closes when it is empty. */
  function advance(): void {
    const next = queue[0];
    if (next) paint(next);
    else {
      shown = null;
      closeDialog();
    }
  }

  const drop = (id: string): void => {
    const at = queue.findIndex((request) => request.id === id);
    if (at >= 0) queue.splice(at, 1);
  };

  function enqueue(request: McpConfirmRequest): void {
    if (ended.has(request.id)) return;
    if (queue.some((waiting) => waiting.id === request.id)) return;
    queue.push(request);
    if (shown) paintQueue();
    else advance();
  }

  async function answer(choice: McpConfirmAnswer): Promise<void> {
    const request = shown;
    if (!request || busy || noticeUntil !== null) return;
    busy = true;
    answered.add(request.id);
    setButtons(false);
    let result;
    try {
      result = await window.api.answerMcpConfirm(request.id, choice);
    } catch (err) {
      answered.delete(request.id);
      showToast(`Error: ${errorMessage(err)}`, 'error');
      if (shown === request) {
        busy = false;
        setButtons(true);
        if (!dialog.open) dialog.showModal();
      }
      return;
    }
    // Refused means it is no longer pending: either way it is over here.
    if (!result.ok) showToast(result.error ?? 'No se pudo responder.', 'error');
    ended.add(request.id);
    drop(request.id);
    if (shown === request) advance();
  }

  function closed(event: McpConfirmClosed): void {
    ended.add(event.id);
    const wasShown = shown?.id === event.id;
    drop(event.id);
    if (answered.has(event.id)) return;
    if (!wasShown) {
      paintQueue();
      return;
    }
    // Answered elsewhere, or out of time: say so, then move on.
    armedAt = null;
    paintApply();
    setButtons(false);
    parts.countdown.hidden = true;
    parts.notice.textContent = 'Ya se respondió';
    parts.notice.hidden = false;
    noticeUntil = Date.now() + NOTICE_MS;
    if (ticker === null) ticker = setInterval(tick, 1000);
  }

  parts.reject.addEventListener('click', () => void answer('reject'));
  parts.apply.addEventListener('click', () => {
    if (shown?.risk !== 'destructive') {
      void answer('apply');
      return;
    }
    const now = Date.now();
    if (armedAt === null) {
      armedAt = now;
      paintApply();
      return;
    }
    if (now - armedAt < ARM_DELAY_MS) return;
    void answer('apply');
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (noticeUntil !== null) {
      noticeUntil = null;
      advance();
      return;
    }
    void answer('reject');
  });
  dialog.addEventListener('close', () => {
    if (closing) {
      closing = false;
      return;
    }
    // Reopened for the next request before this (late) event arrived.
    if (dialog.open) return;
    if (noticeUntil !== null) {
      noticeUntil = null;
      advance();
      return;
    }
    void answer('reject');
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const stops = [parts.diff, parts.reject, parts.apply].filter(
      (stop) => !(stop instanceof HTMLButtonElement && stop.disabled),
    );
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const leaving = event.shiftKey
      ? active === first || !stops.includes(active as HTMLElement)
      : active === last;
    if (!leaving) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  });

  window.api.onMcpConfirmRequest(enqueue);
  window.api.onMcpConfirmClosed(closed);
  void window.api
    .listMcpConfirms()
    .then((pending) => {
      for (const request of pending) enqueue(request);
    })
    .catch(() => undefined);
}
