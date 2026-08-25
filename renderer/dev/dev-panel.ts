import type { TrayColor } from '../../src/ipc-contract.js';

/**
 * The dev-only simulation panel: one button per event that is awkward to
 * reproduce by hand. Builds its own DOM so `config.html` carries no dev markup
 * and this whole file can be dropped from packaged builds.
 */

interface Action {
  label: string;
  hint?: string;
  run(): Promise<unknown>;
  danger?: boolean;
}

interface Group {
  title: string;
  note: string;
  actions: Action[];
}

const TRAY_COLORS: ReadonlyArray<{ label: string; color: TrayColor }> = [
  { label: 'Parado', color: 'stopped' },
  { label: 'Corriendo', color: 'running' },
  { label: 'Warning', color: 'warn' },
  { label: 'Error', color: 'error' },
];

function versionInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'dev-version';
  input.placeholder = 'auto (minor +1)';
  input.setAttribute('aria-label', 'Versión a simular');
  return input;
}

function buildGroups(version: HTMLInputElement, api = window.api): Group[] {
  return [
    {
      title: 'Actualización disponible',
      note: 'Pone el punto rojo en los chips de versión y en el icono de la barra, y habilita el botón de actualizar en «Acerca de». La comprobación automática no lo pisa mientras esté simulada.',
      actions: [
        {
          label: 'Simular actualización',
          run: () => api.dev.simulateUpdate(version.value.trim() || undefined),
        },
        {
          label: 'Limpiar',
          run: () => api.dev.clearUpdate(),
        },
      ],
    },
    {
      title: 'Notificaciones',
      note: 'Los avisos siguen la ruta real: nativa de macOS cuando el sistema la acepta, banner propio si no. En un bundle empaquetado y firmado verás la nativa; en desarrollo, el banner. «Reserva» fuerza el banner propio para poder probarlo también donde la nativa funciona. El de éxito pasa por el ajuste «avisar de acciones completadas», así que sirve para comprobar si está activo.',
      actions: [
        { label: 'Aviso simple', run: () => api.dev.simulateBanner(false) },
        { label: 'Aviso con acción', run: () => api.dev.simulateBanner(true) },
        {
          label: 'Reserva (banner propio)',
          run: () => api.dev.simulateFallbackBanner(false),
        },
        {
          label: 'Reserva con acción',
          run: () => api.dev.simulateFallbackBanner(true),
        },
        {
          label: 'Notificación de éxito',
          run: () => api.dev.simulateSuccess(),
        },
      ],
    },
    {
      title: 'Icono de la barra',
      note: 'Fuerza el color del icono sin tener que arrancar procesos ni provocar errores reales.',
      actions: [
        ...TRAY_COLORS.map(({ label, color }) => ({
          label,
          run: () => api.dev.simulateTrayColor(color),
        })),
        {
          label: 'Soltar',
          run: () => api.dev.simulateTrayColor(null),
        },
      ],
    },
    {
      title: 'Diálogos y avisos',
      note: 'El modal de confirmación de pre-scripts, y los toasts internos (que salen en el desplegable de la barra de menús, no aquí).',
      actions: [
        {
          label: 'Confirmación de pre-script',
          run: () => api.dev.simulatePrescriptConfirm(),
        },
        { label: 'Toast correcto', run: () => api.dev.simulateToast('ok') },
        {
          label: 'Toast de error',
          run: () => api.dev.simulateToast('error'),
          danger: true,
        },
      ],
    },
  ];
}

function buildSection(version: HTMLInputElement): HTMLElement {
  const section = document.createElement('section');
  section.className = 'config-section';
  section.dataset.section = 'dev';

  const title = document.createElement('h1');
  title.className = 'section-title';
  title.textContent = 'Dev';
  section.appendChild(title);

  const intro = document.createElement('p');
  intro.className = 'muted small';
  intro.textContent =
    'Solo en desarrollo. Dispara eventos difíciles de reproducir a mano para poder verlos sin esperar a que ocurran.';
  section.appendChild(intro);

  for (const group of buildGroups(version)) {
    const card = document.createElement('section');
    card.className = 'settings-card';

    const heading = document.createElement('h2');
    heading.textContent = group.title;
    card.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = group.note;
    card.appendChild(note);

    const row = document.createElement('div');
    row.className = 'dev-actions';
    if (group.title === 'Actualización disponible') row.appendChild(version);
    for (const action of group.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.danger ? 'danger' : '';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        button.disabled = true;
        void action
          .run()
          .catch(() => {
            /* handler missing (packaged) — nothing to surface here */
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      row.appendChild(button);
    }
    card.appendChild(row);
    section.appendChild(card);
  }
  return section;
}

function buildNavButton(): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-item';
  button.dataset.target = 'dev';
  button.setAttribute('aria-label', 'Dev');
  const icon = document.createElement('span');
  icon.className = 'nav-ico';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '🧪';
  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = 'Dev';
  button.append(icon, label);
  return button;
}

export interface DevPanelMount {
  navButton: HTMLElement;
  section: HTMLElement;
}

/** Injects the panel and hands its two nodes back for config.ts to register. */
export function mountDevPanel(
  nav: HTMLElement,
  content: HTMLElement,
): DevPanelMount {
  const navButton = buildNavButton();
  const section = buildSection(versionInput());
  nav.appendChild(navButton);
  content.appendChild(section);
  return { navButton, section };
}
