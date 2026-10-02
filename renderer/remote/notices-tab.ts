import type {
  RemoteConfirmView,
  RemoteNotice,
  RemoteNoticeKind,
  RemoteStateView,
} from '../../src/ipc-contract/remote-wire.js';
import { countdownLabels } from './confirm-dialog.js';
import type { PanelContext } from './context.js';
import type { PanelElements } from './elements.js';
import { dayLabel, hourMinute } from './format.js';
import { glyph, type GlyphName } from './glyphs.js';
import { el } from './view.js';

/**
 * «Avisos»: the pending confirmation (answerable right here) and the notice
 * log, grouped by day. What this device has read is its own business: the
 * newest notice time it has seen is kept in localStorage per device, and a
 * browser that refuses storage simply starts every visit unread.
 */

const ICONS: Record<RemoteNoticeKind, GlyphName> = {
  error: 'alert',
  success: 'check',
  scheduled: 'clock',
  update: 'download',
  info: 'info',
};

export interface NoticesTab {
  set(notices: RemoteNotice[]): void;
  add(notice: RemoteNotice): void;
  render(state: RemoteStateView): void;
}

export function createNoticesTab(
  els: PanelElements['notices'],
  tab: { button: HTMLButtonElement; badge: HTMLElement },
  ctx: PanelContext,
  deviceId: string,
): NoticesTab {
  const key = `devbar-remote:read:${deviceId}`;
  let notices: RemoteNotice[] = [];
  let pending: RemoteConfirmView | null = null;
  let readUpTo = readMark();

  function readMark(): number {
    try {
      return Number(ctx.env.storage().getItem(key) ?? 0) || 0;
    } catch {
      return 0;
    }
  }
  function saveMark(): void {
    try {
      ctx.env.storage().setItem(key, String(readUpTo));
    } catch {
      /* no storage: the mark lasts as long as the page */
    }
  }

  function badge(): void {
    const unread =
      notices.filter((notice) => notice.ts > readUpTo).length +
      (pending ? 1 : 0);
    tab.badge.hidden = unread === 0;
    tab.badge.textContent = String(unread);
    tab.button.setAttribute(
      'aria-label',
      unread === 0 ? 'Avisos' : `Avisos, ${unread} sin leer`,
    );
  }

  function item(notice: RemoteNotice): HTMLElement {
    const row = el('div', `notice is-${notice.kind}`);
    row.classList.toggle('is-unread', notice.ts > readUpTo);
    const mark = el('span', 'notice-mark');
    mark.append(glyph(ICONS[notice.kind], 16));
    const body = el('span', 'notice-text');
    const top = el('span', 'notice-top');
    top.append(
      el('span', 'notice-title', notice.title),
      el('span', 'notice-time', hourMinute(notice.ts)),
    );
    body.append(top);
    if (notice.body) body.append(el('span', 'notice-body', notice.body));
    row.append(mark, body);
    return row;
  }

  function paintList(): void {
    const now = ctx.serverNow();
    const sections: HTMLElement[] = [];
    let heading = '';
    let card: HTMLElement | null = null;
    for (const notice of notices) {
      const label = dayLabel(notice.ts, now);
      if (label !== heading || !card) {
        heading = label;
        card = el('div', 'card list notice-list');
        sections.push(el('h3', 'section-title day-title', label), card);
      }
      card.append(item(notice));
    }
    els.list.replaceChildren(...sections);
    els.empty.hidden = notices.length > 0;
    badge();
  }

  function paintCard(): void {
    els.card.hidden = !pending;
    if (!pending) return;
    els.cardGroup.textContent = pending.groupName ?? '';
    els.cardTitle.textContent = `¿Ejecutar «${pending.name}»?`;
    els.cardCommand.textContent = pending.command;
    els.cardNote.textContent = `También aparece en ${ctx.hostName()}. Vale la primera respuesta.`;
    const current = pending;
    const paint = (): void => {
      const labels = countdownLabels(current, ctx.serverNow());
      els.cardRun.textContent = labels.run;
      els.cardCancel.textContent = labels.cancel;
    };
    paint();
    ctx.onTick('notices', [paint]);
  }

  async function answer(decision: 'confirm' | 'cancel'): Promise<void> {
    if (!pending) return;
    els.cardRun.disabled = true;
    els.cardCancel.disabled = true;
    await ctx.answerConfirm(pending.token, decision);
    els.cardRun.disabled = false;
    els.cardCancel.disabled = false;
  }

  els.markRead.addEventListener('click', () => {
    readUpTo = Math.max(readUpTo, ...notices.map((notice) => notice.ts));
    saveMark();
    paintList();
  });
  els.cardRun.addEventListener('click', () => void answer('confirm'));
  els.cardCancel.addEventListener('click', () => void answer('cancel'));

  return {
    set: (next) => {
      notices = next;
      paintList();
    },
    add: (notice) => {
      // Ids restart with DevBar; the time tells two runs' notices apart.
      const same = (n: RemoteNotice) =>
        n.id === notice.id && n.ts === notice.ts;
      notices = [notice, ...notices.filter((n) => !same(n))];
      paintList();
    },
    render: (state) => {
      pending = state.confirms[0] ?? null;
      if (!pending) ctx.onTick('notices', []);
      paintCard();
      badge();
    },
  };
}
