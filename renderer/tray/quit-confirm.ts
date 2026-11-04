/**
 * «¿Salir de DevBar?»: what the popover's power button opens, so one slip of
 * the mouse cannot stop every running service. It is an in-popover `<dialog>`
 * rather than a native one — a native dialog from a menu-bar popover hides
 * the popover and steals focus.
 *
 * Focus lands on «Salir», so Enter confirms; «Cancelar», Escape and a click
 * outside leave everything running and give focus back to the power button;
 * the popover hiding takes the question with it.
 * The note follows state pushes by text alone: the buttons are never rebuilt,
 * so a push cannot reset the hover under the cursor.
 */
import type { GroupState } from '../../src/ipc-contract.js';
import { byId } from '../dom.js';
import { wireModal } from '../modal.js';

/** Room kept around the dialog so it never touches the popover's edges. */
const POPOVER_MARGIN_PX = 16;

/** Services quitting would stop: commands up or on their way up, any group. */
function runningServices(states: readonly GroupState[]): number {
  let running = 0;
  for (const gs of states)
    for (const cs of gs.commands)
      if (cs.status === 'running' || cs.status === 'starting') running++;
  return running;
}

function quitNote(running: number): string {
  if (running === 0) return 'No hay ningún servicio en marcha.';
  if (running === 1) return 'Se parará 1 servicio en marcha.';
  return `Se pararán ${running} servicios en marcha.`;
}

export interface QuitConfirm {
  /** The latest group states: the note's count follows them. */
  update(states: readonly GroupState[]): void;
  /** The popover height the open dialog needs; 0 while it is closed. */
  minHeight(): number;
}

export function wireQuitConfirm(quit: () => void): QuitConfirm {
  const trigger = byId('quit-app', HTMLButtonElement);
  const dialog = byId('quit-dialog', HTMLDialogElement);
  const note = byId('quit-dialog-note', HTMLElement);
  const confirm = byId('quit-confirm', HTMLButtonElement);
  let running = 0;
  /** Closing because «Salir» was pressed, not cancelled. */
  let confirmed = false;

  const paint = (): void => {
    const text = quitNote(running);
    if (note.textContent !== text) note.textContent = text;
  };

  // «Cancelar» and a click outside close it; Escape is handled below.
  wireModal(dialog);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dialog.close();
  });
  trigger.addEventListener('click', () => {
    confirmed = false;
    paint();
    if (!dialog.open) dialog.showModal();
    confirm.focus();
  });
  confirm.addEventListener('click', () => {
    confirmed = true;
    dialog.close();
    quit();
  });
  // The popover hides when it loses focus: the question goes with it rather
  // than greeting the next show.
  window.addEventListener('blur', () => {
    if (dialog.open) dialog.close();
  });
  dialog.addEventListener('close', () => {
    // `close` fires a task after close(). Reopened in that gap, this event is
    // the previous one's: handling it would pull focus out of the dialog.
    if (dialog.open) return;
    if (!confirmed) trigger.focus();
  });

  return {
    update: (states) => {
      running = runningServices(states);
      if (dialog.open) paint();
    },
    minHeight: () =>
      dialog.open ? dialog.offsetHeight + 2 * POPOVER_MARGIN_PX : 0,
  };
}
