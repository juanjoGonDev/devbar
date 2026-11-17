import { wireModal } from '../modal.js';

/**
 * The warning a client's permissions sheet raises before configuration
 * changes may go ahead without the diff dialog: «Sin preguntar» or
 * «Preguntar la primera vez» lets an assistant change what runs on this
 * computer without the user's prior OK. Only the red «Permitir» accepts;
 * «Cancelar», Escape and a click outside answer no, and the sheet puts its
 * previous choice back.
 */

export interface McpWarningElements {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  body: HTMLElement;
  cancel: HTMLButtonElement;
  allow: HTMLButtonElement;
}

type LaxPolicy = 'never' | 'first';

export interface ConfigWarning {
  /** Shows the warning; `done` hears whether the user allowed it. */
  ask(clientName: string, policy: LaxPolicy, done: (ok: boolean) => void): void;
}

const UNDO = 'Cada cambio queda en Actividad y se puede deshacer.';

/** What the warning says about `policy` for this client. */
function warningCopy(
  clientName: string,
  policy: LaxPolicy,
): { title: string; body: string } {
  if (policy === 'never')
    return {
      title: '¿Permitir cambios de configuración sin confirmar?',
      body: `${clientName} podrá cambiar comandos, variables y carpetas —es decir, qué se ejecuta en tu equipo— sin tu aprobación previa. ${UNDO}`,
    };
  return {
    title: '¿Confirmar solo la primera vez?',
    body: `${clientName} solo pedirá tu aprobación la primera vez que cambie cada elemento mientras DevBar siga abierto; después podrá cambiar sus comandos, variables y carpetas sin preguntar. ${UNDO}`,
  };
}

export function createConfigWarning(els: McpWarningElements): ConfigWarning {
  let pending: ((ok: boolean) => void) | null = null;
  let allowed = false;

  const settle = (): void => {
    const done = pending;
    pending = null;
    const ok = allowed;
    allowed = false;
    done?.(ok);
  };

  // «Cancelar» and a click outside close it; Escape is handled below.
  wireModal(els.dialog);
  els.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    els.dialog.close();
  });
  els.allow.addEventListener('click', () => {
    allowed = true;
    els.dialog.close();
  });
  els.dialog.addEventListener('close', () => {
    // `close` fires a task after close(): if the warning opened again in
    // that gap, this event is the previous one's, already settled by `ask`.
    if (els.dialog.open) return;
    settle();
  });

  return {
    ask(clientName, policy, done) {
      settle();
      pending = done;
      const copy = warningCopy(clientName, policy);
      els.title.textContent = copy.title;
      els.body.textContent = copy.body;
      if (!els.dialog.open) els.dialog.showModal();
      els.cancel.focus();
    },
  };
}
