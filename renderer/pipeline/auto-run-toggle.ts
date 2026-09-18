import type { LatestWins } from '../latest-wins.js';

export interface AutoRunToggleDeps {
  /** The cached stored value the control paints. */
  enabled: boolean;
  /**
   * Whether that cached value has been read at least once. Until it has, the
   * control stays disabled: an early click would be saved and then silently
   * overwritten by the resolving read, leaving the control contradicting the
   * setting it just wrote.
   */
  loaded: boolean;
  /**
   * Ticket for the in-flight save. The toggle writes on every change with
   * nothing serializing the writes, so a rejected OLD save must not roll the
   * control back over a NEWER value that already persisted — the same rule
   * the theme picker in `config.ts` follows.
   */
  saves: LatestWins;
  /** Called with the persisted value once a save this click owns succeeds. */
  onSaved(enabled: boolean): void;
  showToast(message: string, kind?: string): void;
}

/**
 * The global "run the pipeline at login" toggle (a GLOBAL setting, not a
 * per-group one).
 *
 * Paints from the caller's cached state rather than firing its own
 * getSettings() call: it is rebuilt on every render(), and a fresh read each
 * time left the checkbox disabled — dead to clicks — until that call
 * resolved, even for renders that have nothing to do with this setting.
 */
export function buildAutoRunToggle(deps: AutoRunToggleDeps): HTMLElement {
  const section = document.createElement('div');
  section.className = 'detail-section';
  const label = document.createElement('label');
  label.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = deps.enabled;
  input.disabled = !deps.loaded;
  input.addEventListener('change', async () => {
    // Issuing this save retires every older one still in flight.
    deps.saves.invalidate();
    const current = deps.saves.claim();
    try {
      await window.api.saveSettings({ preScriptsAutoRun: input.checked });
      if (!current()) return; // a later click owns the control and its toast
      deps.onSaved(input.checked);
      deps.showToast('Ajustes guardados', 'ok');
    } catch {
      // A later click already owns the control (and its own save decides
      // the outcome); rolling back here would silently revert it.
      if (!current()) return;
      // Put the control back where the stored setting still is, so it
      // never claims a value that was not persisted.
      input.checked = !input.checked;
      deps.showToast('No se pudo guardar el ajuste', 'error');
    }
  });
  label.appendChild(input);
  const span = document.createElement('span');
  span.textContent = 'Ejecutar automáticamente al arrancar el Mac';
  label.appendChild(span);
  const hint = document.createElement('small');
  hint.className = 'muted';
  hint.style.cssText = 'display:block; margin:2px 0 0 42px; font-size:10px;';
  hint.textContent =
    'Solo dispara cuando DevBar abre como Login Item del sistema; no en relanzados manuales.';
  section.append(label, hint);
  return section;
}
