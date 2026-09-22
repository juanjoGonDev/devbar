import { wireModal } from './modal.js';

/**
 * The «Reportar fallo» dialog: explains what is about to happen (the
 * report template is copied to the clipboard, then GitHub opens with the
 * form pre-filled when the URL budget allows it) and offers a copy-only
 * path for whoever prefers to paste the report themselves.
 *
 * The dialog STAYS OPEN after either action: the status line under the
 * buttons is the feedback, and the user may want to copy again or go
 * back. Only Volver, the × button or a backdrop click dismiss it.
 */

let dialog: HTMLDialogElement | null = null;

function build(): HTMLDialogElement {
  const next = document.createElement('dialog');
  next.className = 'modal modal-report';
  next.innerHTML = `
    <header class="modal-header">
      <h2>Reportar fallo</h2>
      <span class="spacer"></span>
      <button type="button" class="modal-close" data-close aria-label="Cerrar">×</button>
    </header>
    <div class="modal-body">
      <p>
        Al continuar se copia al portapapeles la plantilla del informe
        (versión, sistema y últimas líneas de <code>app.log</code>), ya
        limpia de credenciales, y se abre GitHub con el formulario
        pre-relleno cuando la URL no es demasiado larga.
      </p>
      <p class="muted small" data-status role="status"></p>
    </div>
    <div class="modal-actions">
      <button type="button" class="small-btn" data-copy>📋 Copiar reporte</button>
      <button type="button" class="small-btn" data-back>Volver</button>
      <button type="button" class="small-btn primary" data-github>
        Reportar bug en GitHub
      </button>
    </div>`;
  document.body.appendChild(next);
  wireModal(next);
  return next;
}

function setStatus(dlg: HTMLDialogElement, message: string): void {
  const status = dlg.querySelector<HTMLElement>('[data-status]');
  if (status) status.textContent = message;
}

/**
 * GitHub-path feedback. The report is ALWAYS on the clipboard, so every
 * outcome says so: the pre-filled form can still arrive short (the URL
 * budget trims the log excerpt) or not arrive at all (GitHub answers an
 * error page, the browser never opens), and a user who was never told
 * about the clipboard has no way back from any of that.
 */
function githubOutcomeMessage(res: {
  ok: boolean;
  bodyIncluded?: boolean;
  copied?: boolean;
}): string {
  return res.ok
    ? res.bodyIncluded
      ? '✓ Formulario preparado en GitHub — el informe completo sigue en el portapapeles'
      : '✓ Copiado al portapapeles — pégalo en GitHub'
    : res.copied
      ? '✓ Copiado al portapapeles — el navegador no se abrió; pégalo en GitHub'
      : 'No se pudo preparar';
}

async function runAction(
  dlg: HTMLDialogElement,
  action: () => Promise<{
    ok: boolean;
    bodyIncluded?: boolean;
    copied?: boolean;
    error?: string;
  }>,
  success: (res: { ok: boolean }) => string,
  failure: string,
): Promise<void> {
  const buttons = dlg.querySelectorAll<HTMLButtonElement>(
    '.modal-actions button',
  );
  buttons.forEach((b) => (b.disabled = true));
  try {
    setStatus(dlg, success(await action()));
  } catch {
    setStatus(dlg, failure);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

export function openReportModal(): void {
  // A fresh jsdom document (tests, or a re-created window) invalidates the
  // cached element: rebuild rather than resurrect a node from a dead tree.
  if (dialog && !dialog.isConnected) dialog = null;
  const dlg = dialog ?? build();
  dialog = dlg;
  setStatus(dlg, '');
  if (!dlg.open) dlg.showModal();
  const back = dlg.querySelector<HTMLButtonElement>('[data-back]');
  if (back) back.onclick = () => dlg.close();
  const github = dlg.querySelector<HTMLButtonElement>('[data-github]');
  if (github)
    github.onclick = () =>
      void runAction(
        dlg,
        () => window.api.reportIssue(),
        (res) => githubOutcomeMessage(res),
        'No se pudo preparar',
      );
  const copy = dlg.querySelector<HTMLButtonElement>('[data-copy]');
  if (copy)
    copy.onclick = () =>
      void runAction(
        dlg,
        () => window.api.copyReport(),
        (res) =>
          res.ok ? '✓ Informe copiado al portapapeles' : 'No se pudo copiar',
        'No se pudo copiar el informe',
      );
}
