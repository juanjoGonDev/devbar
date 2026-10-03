import { wireModal } from './modal.js';
import { hydrateIcons, icon } from './icon.js';

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
      <button type="button" class="modal-close" data-close aria-label="Cerrar"><span class="icon" data-icon="x"></span></button>
    </header>
    <div class="modal-body">
      <p>
        Al continuar se copia al portapapeles la plantilla del informe
        (versión, sistema, errores y avisos recientes y últimas líneas de
        <code>app.log</code>), ya limpia de credenciales, y se abre GitHub
        con el formulario pre-relleno cuando la URL no es demasiado larga.
      </p>
      <p class="small" data-summary></p>
      <details data-preview hidden>
        <summary class="small">Ver el informe</summary>
        <pre class="small report-preview"></pre>
      </details>
      <p class="muted small" data-status role="status"></p>
    </div>
    <div class="modal-actions">
      <button type="button" class="small-btn with-icon" data-copy><span class="icon" data-icon="copy"></span> Copiar reporte</button>
      <button type="button" class="small-btn" data-back>Volver</button>
      <button type="button" class="small-btn primary" data-github>
        Reportar bug en GitHub
      </button>
    </div>`;
  hydrateIcons(next);
  document.body.appendChild(next);
  wireModal(next);
  return next;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** «Se incluirán 3 errores y 5 avisos recientes»: what the report lists. */
function summaryText(errors: number, warnings: number): string {
  if (errors === 0 && warnings === 0)
    return 'No hay errores ni avisos recientes';
  return `Se incluirán ${plural(errors, 'error', 'errores')} y ${plural(warnings, 'aviso', 'avisos')} recientes`;
}

/** Each open asks again; only the newest answer may paint the dialog. */
let previewGeneration = 0;

async function loadPreview(dlg: HTMLDialogElement): Promise<void> {
  const generation = ++previewGeneration;
  const summary = dlg.querySelector<HTMLElement>('[data-summary]');
  const details = dlg.querySelector<HTMLElement>('[data-preview]');
  const pre = details?.querySelector('pre');
  if (summary) summary.textContent = '';
  if (details) details.hidden = true;
  try {
    const res = await window.api.reportPreview();
    if (generation !== previewGeneration || !res.ok) return;
    if (summary)
      summary.textContent = summaryText(res.errors ?? 0, res.warnings ?? 0);
    if (pre) pre.textContent = res.text ?? '';
    if (details) details.hidden = false;
  } catch {
    // No preview is not a failure: the actions below still work.
  }
}

/** A leading check icon marks the outcomes that did what was asked. */
interface Outcome {
  ok: boolean;
  message: string;
}

function setStatus(dlg: HTMLDialogElement, outcome: Outcome | null): void {
  const status = dlg.querySelector<HTMLElement>('[data-status]');
  if (!status) return;
  status.replaceChildren();
  if (!outcome) return;
  if (outcome.ok) status.append(icon('check'), ' ');
  status.append(outcome.message);
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
}): Outcome {
  if (res.ok)
    return {
      ok: true,
      message: res.bodyIncluded
        ? 'Formulario preparado en GitHub — el informe completo sigue en el portapapeles'
        : 'Copiado al portapapeles — pégalo en GitHub',
    };
  return res.copied
    ? {
        ok: true,
        message:
          'Copiado al portapapeles — el navegador no se abrió; pégalo en GitHub',
      }
    : { ok: false, message: 'No se pudo preparar' };
}

async function runAction(
  dlg: HTMLDialogElement,
  action: () => Promise<{
    ok: boolean;
    bodyIncluded?: boolean;
    copied?: boolean;
    error?: string;
  }>,
  success: (res: { ok: boolean }) => Outcome,
  failure: string,
): Promise<void> {
  const buttons = dlg.querySelectorAll<HTMLButtonElement>(
    '.modal-actions button',
  );
  buttons.forEach((b) => (b.disabled = true));
  try {
    setStatus(dlg, success(await action()));
  } catch {
    setStatus(dlg, { ok: false, message: failure });
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
  setStatus(dlg, null);
  void loadPreview(dlg);
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
          res.ok
            ? { ok: true, message: 'Informe copiado al portapapeles' }
            : { ok: false, message: 'No se pudo copiar' },
        'No se pudo copiar el informe',
      );
}
