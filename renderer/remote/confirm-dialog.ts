import type { RemoteConfirmView } from '../../src/ipc-contract/remote-wire.js';
import type { PanelContext } from './context.js';
import type { PanelElements } from './elements.js';
import { countdown } from './format.js';
import { closeDialog, openDialog } from './view.js';

/**
 * The phone's copy of renderer/prescript-confirm: whenever a script asks
 * «¿Ejecutar …?» on the computer, this modal asks too, whatever tab is on
 * screen. The countdown sits on the button that wins at the timeout, like the
 * desktop's; the answer that reaches DevBar first counts, and when the
 * computer (or its timer) answers first the modal says so and goes away.
 *
 * A confirmation the user dismissed is not pushed at them again; the banner
 * on «Grupos» and the card on «Avisos» still answer it.
 */

const CLOSE_AFTER_MS = 2500;

/** "Cancelar (42s)" on the button `onTimeout` names; the other plain. */
export function countdownLabels(
  confirm: RemoteConfirmView,
  now: number,
): { run: string; cancel: string } {
  const left =
    confirm.deadline === null ? '' : ` (${countdown(confirm.deadline - now)}s)`;
  return {
    run: `Ejecutar${confirm.onTimeout === 'confirm' ? left : ''}`,
    cancel: `Cancelar${confirm.onTimeout === 'cancel' ? left : ''}`,
  };
}

export interface ConfirmDialog {
  /** The pending list changed (a `confirm` event, or a state push). */
  update(confirms: RemoteConfirmView[]): void;
  /** Opens a pending one on request, dismissed or not. */
  open(token: string): void;
  /** The panel is going away: close, and ask nothing more. */
  stop(): void;
}

export function createConfirmDialog(
  els: PanelElements['confirm'],
  ctx: PanelContext,
): ConfirmDialog {
  let shown: RemoteConfirmView | null = null;
  let answered: string | null = null;
  let pendingList: RemoteConfirmView[] = [];
  const dismissed = new Set<string>();
  /** Answered from here, or gone: never asked about again. */
  const settled = new Set<string>();
  let closer: unknown = null;
  let stopped = false;

  const nextToAsk = (): RemoteConfirmView | undefined =>
    pendingList.find((c) => !dismissed.has(c.token) && !settled.has(c.token));

  const buttons = (enabled: boolean): void => {
    els.run.disabled = !enabled;
    els.cancel.disabled = !enabled;
  };

  const paintCountdown = (): void => {
    if (!shown) return;
    const labels = countdownLabels(shown, ctx.serverNow());
    els.run.textContent = labels.run;
    els.cancel.textContent = labels.cancel;
  };

  function show(confirm: RemoteConfirmView): void {
    if (closer !== null) ctx.env.clearTimeout(closer);
    closer = null;
    shown = confirm;
    answered = null;
    els.group.textContent = confirm.groupName ?? '';
    els.group.hidden = !confirm.groupName;
    els.title.textContent = `¿Ejecutar «${confirm.name}»?`;
    els.command.textContent = confirm.command;
    els.footer.textContent = `También en ${ctx.hostName()} · vale la primera respuesta`;
    els.closed.hidden = true;
    buttons(true);
    paintCountdown();
    ctx.onTick('confirm', [paintCountdown]);
    openDialog(els.dialog);
  }

  /** Says why the modal is going, then closes it after a moment. */
  function settleWith(note: string): void {
    els.closed.textContent = note;
    els.closed.hidden = false;
    buttons(false);
    closer = ctx.env.setTimeout(() => {
      closer = null;
      closeDialog(els.dialog);
    }, CLOSE_AFTER_MS);
  }

  async function answer(decision: 'confirm' | 'cancel'): Promise<void> {
    if (!shown) return;
    const { token } = shown;
    answered = token;
    buttons(false);
    const result = await ctx.answerConfirm(token, decision);
    if (result !== 'error') settled.add(token);
    if (shown?.token !== token) return;
    if (result === 'ok') closeDialog(els.dialog);
    else if (result === 'gone') settleWith('Ya se había respondido.');
    else {
      answered = null;
      buttons(true);
    }
  }

  els.run.addEventListener('click', () => void answer('confirm'));
  els.cancel.addEventListener('click', () => void answer('cancel'));
  els.dialog.addEventListener('close', () => {
    if (closer !== null) ctx.env.clearTimeout(closer);
    closer = null;
    if (shown && !settled.has(shown.token) && answered !== shown.token)
      dismissed.add(shown.token);
    shown = null;
    ctx.onTick('confirm', []);
    // One at a time, like the desktop: the next pending one, if any.
    const next = stopped ? undefined : nextToAsk();
    if (next) show(next);
  });

  return {
    update: (confirms) => {
      pendingList = confirms;
      const current = shown;
      if (current && els.dialog.open) {
        const still = confirms.find((c) => c.token === current.token);
        if (still) {
          shown = still;
          paintCountdown();
        } else {
          settled.add(current.token);
          if (answered === current.token) closeDialog(els.dialog);
          else if (closer === null)
            settleWith(`Se respondió en ${ctx.hostName()}.`);
        }
        return;
      }
      const next = nextToAsk();
      if (next) show(next);
    },
    open: (token) => {
      const confirm = pendingList.find((c) => c.token === token);
      if (confirm) show(confirm);
    },
    stop: () => {
      stopped = true;
      closeDialog(els.dialog);
    },
  };
}
