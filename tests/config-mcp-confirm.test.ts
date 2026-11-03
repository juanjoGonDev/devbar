// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import type {
  McpConfirmRequest,
  McpDiffLine,
} from '../src/ipc-contract/mcp-api.js';

/**
 * «Claude Code quiere cambiar un comando» (renderer/config/mcp-confirm.ts):
 * the dialog an assistant's risky call waits on. Main opens the settings
 * window for it; the window shows one request at a time, counts down to the
 * automatic «no», and answers through `answerMcpConfirm`.
 */

const DIFF: McpDiffLine[] = [
  { kind: 'ctx', field: 'nombre', text: 'Normal' },
  { kind: 'del', field: 'comando', text: 'pnpm start:dev' },
  { kind: 'add', field: 'comando', text: 'pnpm start:dev --inspect=9229' },
  { kind: 'ctx', field: 'carpeta', text: '~/workspace/platform-back' },
  {
    kind: 'add',
    field: 'entorno',
    text: 'NODE_OPTIONS=--max-old-space-size=4096',
  },
];

function request(
  id: string,
  extra: Partial<McpConfirmRequest> = {},
): McpConfirmRequest {
  return {
    id,
    clientName: 'Claude Code',
    title: 'Claude Code quiere cambiar un comando',
    subtitle: 'Grupo Back · comando Normal',
    risk: 'executes',
    diff: DIFF,
    expiresAt: Date.now() + 60_000,
    ...extra,
  };
}

const dialog = (): HTMLDialogElement => {
  const found = document.getElementById('mcp-confirm-dialog');
  if (!(found instanceof HTMLDialogElement)) throw new Error('no dialog');
  return found;
};
function part<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = dialog().querySelector<T>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}
/**
 * What a sighted user reads: the text minus hidden parts, screen-reader-only
 * words and icon glyphs.
 */
function visible(node: Element): string {
  const copy = node.cloneNode(true) as Element;
  copy
    .querySelectorAll('[hidden], .sr-only, .icon')
    .forEach((hidden) => hidden.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}
const say = (selector: string): string => visible(part(selector));
const rejectBtn = (): HTMLButtonElement => part('.mcp-confirm-reject');
const applyBtn = (): HTMLButtonElement => part('.mcp-confirm-apply');
const click = (target: Element): void => {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const tab = (shift = false): void => {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    }),
  );
};

/** The config window, with the clock faked and `pending` waiting. */
async function withPending(
  ...pending: ((now: number) => McpConfirmRequest)[]
): Promise<RendererWindow> {
  const win = await openConfigWindow();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  await win.settle(
    'listMcpConfirms',
    pending.map((make) => make(Date.now())),
  );
  return win;
}
const one =
  (id: string, extra: Partial<McpConfirmRequest> = {}) =>
  (): McpConfirmRequest =>
    request(id, extra);

describe('renderer/config/mcp-confirm.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
    vi.useRealTimers();
  });

  describe('opening', () => {
    it('stays closed when nothing is waiting', async () => {
      win = await withPending();

      expect(dialog().open).toBe(false);
    });

    it('shows a waiting request as an alert dialog, «Rechazar» focused', async () => {
      win = await withPending(one('r1'));

      expect(dialog().open).toBe(true);
      expect(dialog().getAttribute('role')).toBe('alertdialog');
      expect(say('#mcp-confirm-title')).toBe(
        'Claude Code quiere cambiar un comando',
      );
      expect(dialog().getAttribute('aria-labelledby')).toBe(
        'mcp-confirm-title',
      );
      expect(say('#mcp-confirm-subtitle')).toBe(
        'Grupo Back · comando Normal · vía Claude Code',
      );
      expect(document.activeElement).toBe(rejectBtn());
    });

    it('opens on a request pushed while the window is up', async () => {
      win = await withPending();

      await win.push('onMcpConfirmRequest', request('r1'));

      expect(dialog().open).toBe(true);
      expect(say('#mcp-confirm-title')).toBe(
        'Claude Code quiere cambiar un comando',
      );
    });
  });

  describe('the diff', () => {
    it('lists each line with its field, and counts the fields that change', async () => {
      win = await withPending(one('r1'));

      const lines = [...dialog().querySelectorAll('.mcp-diff-line')];
      expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual([
        'ctx',
        'del',
        'add',
        'ctx',
        'add',
      ]);
      expect(lines.map((line) => visible(line))).toEqual([
        'nombre: Normal',
        'comando: pnpm start:dev',
        'comando: pnpm start:dev --inspect=9229',
        'carpeta: ~/workspace/platform-back',
        'entorno: NODE_OPTIONS=--max-old-space-size=4096',
      ]);
      expect(say('.mcp-diff-count')).toBe('2 campos');
    });

    it('says «1 campo» for a single change', async () => {
      win = await withPending(
        one('r1', { diff: [{ kind: 'add', field: 'icono', text: 'rocket' }] }),
      );

      expect(say('.mcp-diff-count')).toBe('1 campo');
    });

    it('names removals and additions for a screen reader, with no typed marker', async () => {
      win = await withPending(one('r1'));

      const [, del, add] = [...dialog().querySelectorAll('.mcp-diff-line')];
      expect(del?.querySelector('.sr-only')?.textContent).toBe('Quita');
      expect(add?.querySelector('.sr-only')?.textContent).toBe('Añade');
      // The − / + markers are CSS pseudo-content, never typed into the DOM.
      for (const line of dialog().querySelectorAll('.mcp-diff-line'))
        expect(line.textContent).not.toMatch(/\u2212|^\s*[+-]/u);
    });
  });

  describe('the reason', () => {
    it('quotes what the assistant said', async () => {
      win = await withPending(
        one('r1', {
          reason: 'Activar el inspector para depurar la fuga de memoria',
        }),
      );

      expect(say('.mcp-confirm-reason')).toBe(
        'Motivo indicado por el asistente: «Activar el inspector para depurar la fuga de memoria».',
      );
    });

    it('renders untrusted markup as plain text', async () => {
      win = await withPending(
        one('r1', { reason: '<img src=x onerror="alert(1)"><b>hola</b>' }),
      );

      const box = part('.mcp-confirm-reason');
      expect(box.querySelector('img, b')).toBeNull();
      expect(visible(box)).toContain(
        '<img src=x onerror="alert(1)"><b>hola</b>',
      );
    });

    it('cuts a long reason at 300 characters', async () => {
      win = await withPending(one('r1', { reason: 'a'.repeat(1000) }));

      expect(say('.mcp-confirm-reason')).toBe(
        `Motivo indicado por el asistente: «${'a'.repeat(300)}…».`,
      );
    });

    it('folds line breaks and drops invisible direction overrides', async () => {
      win = await withPending(
        one('r1', { reason: 'uno\n\ndos\u202Etres\u2066' }),
      );

      expect(say('.mcp-confirm-reason')).toBe(
        'Motivo indicado por el asistente: «uno dostres».',
      );
    });

    it('hides the box when the assistant gave no reason', async () => {
      win = await withPending(one('r1'));

      expect(part('.mcp-confirm-reason').hidden).toBe(true);
    });
  });

  it('says a copy is kept and where to undo it', async () => {
    win = await withPending(one('r1'));

    expect(say('.mcp-confirm-note')).toBe(
      'Se guarda una copia antes de aplicar. Puedes deshacerlo desde Ajustes › MCP › Actividad.',
    );
  });

  describe('risk', () => {
    it('marks a change to what runs in amber, applied with «Aplicar cambio»', async () => {
      win = await withPending(one('r1', { risk: 'executes' }));

      expect(dialog().dataset.risk).toBe('executes');
      expect(say('.mcp-confirm-risk')).toBe('Cambia qué se ejecuta');
      expect(say('.mcp-confirm-apply')).toBe('Aplicar cambio');
      expect(applyBtn().classList.contains('primary')).toBe(true);
      expect(applyBtn().classList.contains('is-destructive')).toBe(false);
    });

    it('marks a cosmetic change as such', async () => {
      win = await withPending(one('r1', { risk: 'cosmetic' }));

      expect(dialog().dataset.risk).toBe('cosmetic');
      expect(say('.mcp-confirm-risk')).toBe('Cosmético');
      expect(say('.mcp-confirm-apply')).toBe('Aplicar cambio');
    });

    it('asks for «Borrar» twice before deleting', async () => {
      win = await withPending(one('r1', { risk: 'destructive' }));

      expect(dialog().dataset.risk).toBe('destructive');
      expect(say('.mcp-confirm-risk')).toBe('Borra datos');
      expect(say('.mcp-confirm-apply')).toBe('Borrar');
      expect(applyBtn().classList.contains('is-destructive')).toBe(true);

      click(applyBtn());
      expect(win.callCount('answerMcpConfirm')).toBe(0);
      expect(say('.mcp-confirm-apply')).toBe('Pulsa otra vez para borrar');

      vi.advanceTimersByTime(1000);
      click(applyBtn());
      expect(win.argsFor('answerMcpConfirm')).toEqual([['r1', 'apply']]);
    });

    it('ignores a double click on «Borrar»', async () => {
      win = await withPending(one('r1', { risk: 'destructive' }));

      click(applyBtn());
      vi.advanceTimersByTime(200);
      click(applyBtn());

      expect(win.callCount('answerMcpConfirm')).toBe(0);
    });

    it('disarms «Borrar» when the second click does not come', async () => {
      win = await withPending(one('r1', { risk: 'destructive' }));

      click(applyBtn());
      vi.advanceTimersByTime(5000);

      expect(say('.mcp-confirm-apply')).toBe('Borrar');
      click(applyBtn());
      expect(win.callCount('answerMcpConfirm')).toBe(0);
    });
  });

  describe('countdown', () => {
    it('counts down to the automatic rejection, never below zero', async () => {
      win = await withPending(one('r1'));

      expect(say('.mcp-confirm-countdown')).toBe('Se rechaza solo en 60 s');
      vi.advanceTimersByTime(5000);
      expect(say('.mcp-confirm-countdown')).toBe('Se rechaza solo en 55 s');
      vi.advanceTimersByTime(90_000);
      expect(say('.mcp-confirm-countdown')).toBe('Se rechaza solo en 0 s');
    });

    it('counts from each request’s own deadline', async () => {
      win = await withPending(
        (now) => request('r1', { expiresAt: now + 60_000 }),
        (now) => request('r2', { expiresAt: now + 20_000 }),
      );
      vi.advanceTimersByTime(4000);

      click(rejectBtn());
      await win.settle('answerMcpConfirm', { ok: true });

      expect(say('.mcp-confirm-countdown')).toBe('Se rechaza solo en 16 s');
    });
  });

  describe('answering', () => {
    it('applies, then closes once main confirms', async () => {
      win = await withPending(one('r1'));

      click(applyBtn());
      expect(applyBtn().disabled).toBe(true);
      expect(rejectBtn().disabled).toBe(true);
      await win.push('onMcpConfirmClosed', { id: 'r1', outcome: 'applied' });
      await win.settle('answerMcpConfirm', { ok: true });

      expect(win.argsFor('answerMcpConfirm')).toEqual([['r1', 'apply']]);
      expect(dialog().open).toBe(false);
      expect(part('.mcp-confirm-notice').hidden).toBe(true);
    });

    it('rejects on «Rechazar»', async () => {
      win = await withPending(one('r1'));

      click(rejectBtn());
      await win.settle('answerMcpConfirm', { ok: true });

      expect(win.argsFor('answerMcpConfirm')).toEqual([['r1', 'reject']]);
      expect(dialog().open).toBe(false);
    });

    it('says why when main refuses the answer, and moves on', async () => {
      win = await withPending(one('r1'));

      click(applyBtn());
      await win.settle('answerMcpConfirm', {
        ok: false,
        error: 'Esa confirmación ya no está pendiente',
      });

      expect(document.getElementById('toast')?.textContent).toBe(
        'Esa confirmación ya no está pendiente',
      );
      expect(dialog().open).toBe(false);
    });

    it('keeps the request when the answer could not be sent', async () => {
      win = await withPending(one('r1'));

      click(applyBtn());
      await win.fail('answerMcpConfirm', new Error('ipc caído'));

      expect(document.getElementById('toast')?.textContent).toBe(
        'Error: ipc caído',
      );
      expect(dialog().open).toBe(true);
      expect(applyBtn().disabled).toBe(false);
      expect(rejectBtn().disabled).toBe(false);
    });
  });

  describe('keyboard', () => {
    it('treats Escape as «Rechazar»', async () => {
      win = await withPending(one('r1'));

      const cancel = new Event('cancel', { cancelable: true });
      dialog().dispatchEvent(cancel);
      await win.settle('answerMcpConfirm', { ok: true });

      expect(cancel.defaultPrevented).toBe(true);
      expect(win.argsFor('answerMcpConfirm')).toEqual([['r1', 'reject']]);
      expect(dialog().open).toBe(false);
    });

    it('rejects when the dialog is closed some other way', async () => {
      win = await withPending(one('r1'));

      dialog().close();
      await win.settle('answerMcpConfirm', { ok: true });

      expect(win.argsFor('answerMcpConfirm')).toEqual([['r1', 'reject']]);
    });

    it('keeps Tab inside the dialog', async () => {
      win = await withPending(one('r1'));
      const diff = part('.mcp-diff');

      applyBtn().focus();
      tab();
      expect(document.activeElement).toBe(diff);
      tab(true);
      expect(document.activeElement).toBe(applyBtn());
    });
  });

  describe('queue', () => {
    it('shows one request at a time, with its place in the queue', async () => {
      win = await withPending(
        one('r1'),
        one('r2', { title: 'Claude Code quiere borrar un grupo' }),
        one('r3'),
      );

      expect(say('.mcp-confirm-queue')).toBe('1 de 3');
      click(rejectBtn());
      await win.settle('answerMcpConfirm', { ok: true });

      expect(dialog().open).toBe(true);
      expect(say('#mcp-confirm-title')).toBe(
        'Claude Code quiere borrar un grupo',
      );
      expect(say('.mcp-confirm-queue')).toBe('1 de 2');
      expect(document.activeElement).toBe(rejectBtn());
    });

    it('hides the counter for a lone request', async () => {
      win = await withPending(one('r1'));

      expect(part('.mcp-confirm-queue').hidden).toBe(true);
    });

    it('queues a request pushed while another is shown', async () => {
      win = await withPending(one('r1'));

      await win.push('onMcpConfirmRequest', request('r2'));
      await win.push('onMcpConfirmRequest', request('r2'));

      expect(say('.mcp-confirm-queue')).toBe('1 de 2');
    });

    it('does not repeat a pushed request the late list also returns', async () => {
      win = await openConfigWindow();
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

      await win.push('onMcpConfirmRequest', request('r1'));
      await win.settle('listMcpConfirms', [request('r1'), request('r2')]);

      expect(say('.mcp-confirm-queue')).toBe('1 de 2');
    });

    it('skips a listed request that already closed', async () => {
      win = await openConfigWindow();
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

      await win.push('onMcpConfirmClosed', { id: 'r1', outcome: 'expired' });
      await win.settle('listMcpConfirms', [request('r1')]);

      expect(dialog().open).toBe(false);
    });
  });

  describe('closed elsewhere', () => {
    it('says it was already answered, then moves on', async () => {
      win = await withPending(one('r1'), one('r2'));

      await win.push('onMcpConfirmClosed', { id: 'r1', outcome: 'expired' });

      expect(say('.mcp-confirm-notice')).toBe('Ya se respondió');
      expect(applyBtn().disabled).toBe(true);
      expect(rejectBtn().disabled).toBe(true);
      vi.advanceTimersByTime(2000);

      expect(win.callCount('answerMcpConfirm')).toBe(0);
      expect(dialog().open).toBe(true);
      expect(part('.mcp-confirm-notice').hidden).toBe(true);
      expect(part('.mcp-confirm-queue').hidden).toBe(true);
      expect(applyBtn().disabled).toBe(false);
    });

    it('closes after the notice when nothing else waits', async () => {
      win = await withPending(one('r1'));

      await win.push('onMcpConfirmClosed', { id: 'r1', outcome: 'applied' });
      vi.advanceTimersByTime(2000);

      expect(dialog().open).toBe(false);
      expect(win.callCount('answerMcpConfirm')).toBe(0);
    });

    it('drops a queued request quietly', async () => {
      win = await withPending(one('r1'), one('r2'));

      await win.push('onMcpConfirmClosed', { id: 'r2', outcome: 'cancelled' });

      expect(part('.mcp-confirm-queue').hidden).toBe(true);
      expect(part('.mcp-confirm-notice').hidden).toBe(true);
    });
  });
});
