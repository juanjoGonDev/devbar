import { DEFAULT_MAX_LOG_LINES } from '../../src/domain-types.js';
import type { ThemePreference } from '../../src/domain-types.js';
import { errorMessage, type ShowToast } from './toast.js';

export interface SettingsPaneElements {
  autostart: HTMLInputElement;
  autostartHint: HTMLElement;
  silenceWarnings: HTMLInputElement;
  silenceErrors: HTMLInputElement;
  maxLogLines: HTMLInputElement;
  notifySuccess: HTMLInputElement;
  notifHint: HTMLElement;
  openNotifSettings: HTMLButtonElement;
  testNotify: HTMLButtonElement;
}

export interface SettingsPane {
  /**
   * Returns true when the settings were applied. On a rejected getSettings()
   * the controls stay BLOCKED (settingsLoaded remains false — persistSettings
   * and the theme clicks all no-op) instead of silently dying: the failure is
   * surfaced, and the window `focus` retry re-runs the load.
   */
  load(): Promise<boolean>;
}

export function createSettingsPane(
  els: SettingsPaneElements,
  showToast: ShowToast,
): SettingsPane {
  let settingsLoaded = false;
  // Theme picker: segmented control, persists on click (same as the other
  // instant-save controls). Main pushes the saved theme on `settings:theme`, so
  // the change propagates to all open windows (and to this one).
  let selectedTheme: ThemePreference = 'auto';
  // Monotonic id per click. Saves are independent promises and can settle out
  // of order, so a rejected OLD save must not roll the control back over a
  // NEWER selection that already succeeded.
  let themeSaveSeq = 0;
  const themeOpts = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.theme-opt'),
  );

  function markThemeOption(): void {
    for (const btn of themeOpts) {
      const on = btn.dataset.themeValue === selectedTheme;
      btn.classList.toggle('is-on', on);
      // The buttons are a radio group: expose the active theme to assistive
      // technology, not just the is-on class.
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  async function loadSettings(): Promise<boolean> {
    // Reset BEFORE the read: a rejection on a retry (e.g. the post-import
    // reload) must re-block the controls and re-arm the focus retry — if a
    // previous load had succeeded, settingsLoaded would still be true and
    // stale controls could persist over the imported settings.
    settingsLoaded = false;
    let s: Awaited<ReturnType<typeof window.api.getSettings>>;
    try {
      s = await window.api.getSettings();
    } catch (err) {
      showToast(
        `No se pudieron cargar los ajustes: ${errorMessage(err)}. Los controles de esta ventana están bloqueados; vuelve a enfocar la ventana para reintentar.`,
        'error',
      );
      return false;
    }
    els.autostart.checked = !!s.autostart;
    selectedTheme = s.theme ?? 'auto';
    markThemeOption();
    els.silenceWarnings.checked = !!s.silenceWarnings;
    els.silenceErrors.checked = !!s.silenceErrors;
    if (els.maxLogLines)
      els.maxLogLines.value = String(
        s.maxLogLines != null ? s.maxLogLines : DEFAULT_MAX_LOG_LINES,
      );
    if (els.notifySuccess)
      els.notifySuccess.checked = s.notifySuccess !== false;
    settingsLoaded = true;
    return true;
  }

  async function persistSettings() {
    // Before loadSettings() resolves the controls still hold their HTML
    // initial values, not the stored ones: persisting now would overwrite
    // autostart/notifications/log settings with those stale values.
    if (!settingsLoaded) return;
    const maxLogLinesRaw = els.maxLogLines ? els.maxLogLines.value : '';
    const maxLogLines =
      maxLogLinesRaw === ''
        ? DEFAULT_MAX_LOG_LINES
        : Number(maxLogLinesRaw) || DEFAULT_MAX_LOG_LINES;
    await window.api.saveSettings({
      autostart: els.autostart.checked,
      theme: selectedTheme,
      silenceWarnings: els.silenceWarnings.checked,
      silenceErrors: els.silenceErrors.checked,
      maxLogLines,
      notifySuccess: els.notifySuccess ? els.notifySuccess.checked : true,
    });
    showToast('Ajustes guardados', 'ok');
  }

  // ── Per-OS copy ──────────────────────────────────────────────────────
  // The static HTML carries OS-neutral fallbacks; this refines the wording —
  // and the settings-link label — for the platform actually running, so a
  // Windows user never reads macOS instructions (and vice versa).
  function adaptOsTexts(): void {
    const platform = window.api.platform;

    if (els.autostartHint) {
      const osMechanism =
        platform === 'win32'
          ? 'el autostart de Windows (clave Run)'
          : platform === 'linux'
            ? 'el autostart de la sesión (XDG)'
            : 'los elementos de inicio de sesión (Login Items)';
      els.autostartHint.textContent = `Registra DevBar en ${osMechanism}. Solo aplica a la app empaquetada/instalada.`;
    }

    if (els.notifHint && els.openNotifSettings) {
      let text: string;
      if (platform === 'darwin') {
        text =
          '¿No se ven las notificaciones? macOS pide permiso una sola vez por app. Compruébalo en ';
        els.openNotifSettings.textContent =
          'Ajustes del sistema → Notificaciones';
      } else if (platform === 'win32') {
        text =
          '¿No se ven las notificaciones? Windows gestiona el permiso por app. Compruébalo en ';
        els.openNotifSettings.textContent =
          'Configuración → Sistema → Notificaciones';
      } else {
        text =
          '¿No se ven las notificaciones? El panel depende de tu escritorio (GNOME: Ajustes → Notificaciones; KDE: Configuración del sistema → Notificaciones). Puedes abrir ';
        els.openNotifSettings.textContent = 'los ajustes del sistema';
      }
      els.notifHint.textContent = text;
      els.notifHint.appendChild(els.openNotifSettings);
      els.notifHint.appendChild(document.createTextNode('.'));
    }
  }

  // Retry path for a failed load: re-enfocando la ventana reintenta la carga.
  window.addEventListener('focus', () => {
    if (!settingsLoaded) void loadSettings();
  });

  if (els.openNotifSettings) {
    els.openNotifSettings.addEventListener('click', async () => {
      const res = await window.api.openNotificationSettings();
      if (!res.ok) {
        // No known panel (or it could not be launched): give the manual
        // route instead of pretending the system panel opened. Per-OS, the
        // same way adaptOsTexts() picks its wording — GNOME/KDE guidance
        // makes no sense on macOS or Windows.
        const manualRoute =
          window.api.platform === 'darwin'
            ? 'en macOS, Ajustes del sistema → Notificaciones'
            : window.api.platform === 'win32'
              ? 'en Windows, Configuración → Sistema → Notificaciones'
              : 'en GNOME, Ajustes → Notificaciones; en KDE, Configuración del sistema → Notificaciones';
        showToast(
          `No se pudo abrir el panel del sistema — búscalo a mano: ${manualRoute}.`,
          'error',
        );
      }
    });
  }

  if (els.testNotify) {
    els.testNotify.addEventListener('click', async () => {
      await window.api.testNotification();
      showToast('Banner de prueba mostrado', 'ok');
    });
  }

  for (const btn of themeOpts)
    btn.addEventListener('click', async () => {
      if (!settingsLoaded) return; // stale-control window: load will win
      const token = ++themeSaveSeq;
      const previous = selectedTheme;
      selectedTheme = (btn.dataset.themeValue ?? 'auto') as ThemePreference;
      markThemeOption();
      // Theme-only patch: persistSettings() would read every control and
      // could persist stale values for the ones the user never touched.
      // A rejected save (electron-store writes synchronously and throws on
      // failure) must not leave the selector on a theme that was never
      // persisted — roll back to the previous one.
      try {
        await window.api.saveSettings({ theme: selectedTheme });
      } catch {
        // A later click already owns the control (and its own save decides the
        // outcome); restoring THIS click's `previous` would silently revert it.
        if (token !== themeSaveSeq) return;
        selectedTheme = previous;
        markThemeOption();
        showToast(
          'No se pudo guardar el tema — se ha restaurado el anterior.',
          'error',
        );
      }
    });

  els.autostart.addEventListener('change', persistSettings);
  els.silenceWarnings.addEventListener('change', persistSettings);
  els.silenceErrors.addEventListener('change', persistSettings);
  if (els.maxLogLines) {
    els.maxLogLines.addEventListener('change', persistSettings);
    els.maxLogLines.addEventListener('blur', persistSettings);
  }
  if (els.notifySuccess)
    els.notifySuccess.addEventListener('change', persistSettings);

  adaptOsTexts();

  return { load: loadSettings };
}
