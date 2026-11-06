import { icon, type IconName } from '../icon.js';
import { wireModal } from '../modal.js';

/**
 * The one confirmation dialog of «Actividad» (`#mcp-activity-dialog`, the
 * red-tile modal family of «¿Revocar el acceso?»): deleting entries, undoing
 * one change or many, and deleting by dates. A red tile and a red button for
 * what cannot be taken back, a blue one for an undo. «Cancelar» takes focus
 * first; it, Escape and a click outside all answer no, and focus goes back
 * to whatever had it before the dialog opened.
 */

export interface McpActivityDialogElements {
  dialog: HTMLDialogElement;
  tile: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  cancel: HTMLButtonElement;
  ok: HTMLButtonElement;
}

interface AskOptions {
  title: string;
  body: readonly Node[];
  ok: string;
  icon: IconName;
  /** `danger` deletes; `info` undoes. */
  tone: 'danger' | 'info';
}

export interface ActivityDialog {
  /** Opens the dialog; true once the user confirms, false otherwise. */
  ask(options: AskOptions): Promise<boolean>;
  /** Replaces what the open dialog says (a live count, say). */
  setBody(nodes: readonly Node[]): void;
  setOk(label: string, disabled: boolean): void;
}

export function createActivityDialog(
  els: McpActivityDialogElements,
): ActivityDialog {
  let answer: ((yes: boolean) => void) | null = null;
  let confirmed = false;
  let back: HTMLElement | null = null;

  wireModal(els.dialog);
  els.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    els.dialog.close();
  });
  els.ok.addEventListener('click', () => {
    if (els.ok.disabled) return;
    confirmed = true;
    els.dialog.close();
  });
  els.dialog.addEventListener('close', () => {
    const settle = answer;
    answer = null;
    const yes = confirmed;
    confirmed = false;
    if (back?.isConnected) back.focus();
    back = null;
    settle?.(yes);
  });

  return {
    ask: (options) => {
      // A dialog already open answers no before the next one replaces it.
      if (els.dialog.open) els.dialog.close();
      const active = document.activeElement;
      back = active instanceof HTMLElement ? active : null;
      els.title.textContent = options.title;
      els.body.replaceChildren(...options.body);
      els.tile.classList.toggle('is-info', options.tone === 'info');
      els.tile.replaceChildren(icon(options.icon));
      els.ok.textContent = options.ok;
      els.ok.className = options.tone === 'danger' ? 'danger' : 'primary';
      els.ok.disabled = false;
      const result = new Promise<boolean>((resolve) => {
        answer = resolve;
      });
      els.dialog.showModal();
      els.cancel.focus();
      return result;
    },
    setBody: (nodes) => els.body.replaceChildren(...nodes),
    setOk: (label, disabled) => {
      els.ok.textContent = label;
      els.ok.disabled = disabled;
    },
  };
}

/** A paragraph of the dialog's body. */
export function para(text: string, className = ''): HTMLParagraphElement {
  const p = document.createElement('p');
  if (className) p.className = className;
  p.textContent = text;
  return p;
}
