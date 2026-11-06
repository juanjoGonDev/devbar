import type { Group } from '../../src/domain-types.js';
import type { GroupStore } from './group-store.js';
import type { ShowToast } from './toast.js';

export interface GroupSettingsDeps {
  store: GroupStore;
  showToast: ShowToast;
  /** The header's copy of the name follows the one typed here. */
  onRename(value: string): void;
  /** The header's folder line follows the one typed here. */
  onPath(value: string): void;
  /** «Visible en la barra y el móvil» — an instant write, not the draft. */
  toggleVisibility(stored: Group, visible: boolean): void;
  remove(group: Group): void;
}

export interface GroupSettingsTab {
  /** Mirrors the name typed in the header. */
  setName(value: string): void;
}

/** A macOS settings card under its uppercase title. */
function card(parent: HTMLElement, title: string, extra = ''): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `settings-group ${extra}`.trim();
  const heading = document.createElement('h2');
  heading.className = 'settings-group-title';
  heading.textContent = title;
  const body = document.createElement('section');
  body.className = 'settings-card settings-group-card';
  wrap.append(heading, body);
  parent.append(wrap);
  return body;
}

/** The label (and optional hint) on the left of a row. */
function rowLabel(text: string, hint?: string, forId?: string): HTMLElement {
  const label = document.createElement(forId ? 'label' : 'span');
  label.className = 'settings-row-label';
  if (forId) (label as HTMLLabelElement).htmlFor = forId;
  label.append(text);
  if (hint) {
    const small = document.createElement('small');
    small.textContent = hint;
    label.append(small);
  }
  return label;
}

function row(label: HTMLElement, ...controls: HTMLElement[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-row';
  const end = document.createElement('div');
  end.className = 'gs-control';
  end.append(...controls);
  el.append(label, end);
  return el;
}

/** A whole-row switch: clicking the label flips it, like General's. */
function switchRow(
  text: string,
  checked: boolean,
  cssClass: string,
  onChange: (checked: boolean) => void,
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = cssClass;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const span = document.createElement('span');
  span.textContent = text;
  label.append(input, span);
  return label;
}

/** A compact switch with its own short label, several to a row. */
function inlineSwitch(
  text: string,
  checked: boolean,
  cssClass: string,
  onChange: (checked: boolean) => void,
): HTMLLabelElement {
  const label = switchRow(text, checked, cssClass, onChange);
  label.className = 'toggle inline gs-inline-switch';
  return label;
}

function textInput(id: string, value: string, label: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.id = id;
  input.className = 'gs-input';
  input.value = value;
  input.setAttribute('aria-label', label);
  return input;
}

/**
 * The «Ajustes» tab: GENERAL (name, folder, mode), COMPORTAMIENTO (startup
 * wait, silencing, visibility) and ZONA DE PELIGRO (delete), each row a
 * label with a short hint on the left and its control on the right.
 */
export function buildGroupSettingsTab(
  group: Group,
  parent: HTMLElement,
  deps: GroupSettingsDeps,
): GroupSettingsTab {
  const { store } = deps;
  const general = card(parent, 'General');

  const name = textInput('grp-name', group.name || '', 'Nombre');
  name.placeholder = 'Nombre del grupo';
  name.addEventListener('input', () => {
    store.mutateDraft((d) => {
      d.name = name.value;
    });
    deps.onRename(name.value);
  });
  general.append(row(rowLabel('Nombre', undefined, name.id), name));

  general.append(buildFolderRow(group, deps));
  general.append(buildModeRow(group, store));

  const behaviour = card(parent, 'Comportamiento');
  const wait = switchRow(
    'Esperar al workflow de arranque',
    group.waitForPipeline,
    'detail-wait-pipeline',
    (on) =>
      store.mutateDraft((d) => {
        d.waitForPipeline = on;
      }),
  );
  // The why lives in the tooltip: the row stays a one-line setting.
  wait.title =
    'Arranca los comandos de este grupo cuando termina todo el workflow de arranque: un bloque de otro grupo puede reiniciar servicios compartidos (p. ej. Docker).';
  behaviour.append(wait);

  behaviour.append(
    row(
      rowLabel('Silenciar en este grupo'),
      inlineSwitch(
        'Warnings',
        group.silenceWarnings,
        'detail-silence-warn',
        (on) =>
          store.mutateDraft((d) => {
            d.silenceWarnings = on;
          }),
      ),
      inlineSwitch('Errores', group.silenceErrors, 'detail-silence-err', (on) =>
        store.mutateDraft((d) => {
          d.silenceErrors = on;
        }),
      ),
    ),
  );

  const stored = store.getGroups().find((g) => g.id === group.id) ?? group;
  behaviour.append(
    switchRow(
      'Visible en la barra y el móvil',
      !stored.hiddenInTray,
      'detail-visible',
      (on) => deps.toggleVisibility(stored, !on),
    ),
  );

  const danger = card(parent, 'Zona de peligro', 'detail-danger-zone');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small-btn danger';
  remove.textContent = 'Borrar grupo…';
  remove.addEventListener('click', () => deps.remove(group));
  danger.append(
    row(
      rowLabel(
        'Borrar grupo',
        'Se borran sus comandos, acciones y pre-scripts.',
      ),
      remove,
    ),
  );

  return {
    setName: (value) => {
      name.value = value;
    },
  };
}

function buildFolderRow(group: Group, deps: GroupSettingsDeps): HTMLElement {
  const input = textInput('grp-path', group.path || '', 'Carpeta');
  input.classList.add('gs-path-input');
  input.placeholder = '/Users/yo/proyecto';
  input.addEventListener('input', () => {
    const value = input.value.trim();
    deps.store.mutateDraft((d) => {
      d.path = value;
    });
    deps.onPath(value);
  });
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.id = 'grp-path-pick';
  pick.className = 'small-btn';
  pick.textContent = 'Elegir…';
  pick.addEventListener('click', async () => {
    const res = await window.api.pickFolder(input.value || undefined);
    if (res.canceled) return;
    if (!res.ok) {
      deps.showToast(`Error: ${res.error || 'desconocido'}`, 'error');
      return;
    }
    if (!res.path) return;
    input.value = res.path;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const el = row(
    rowLabel('Carpeta', 'Directorio de trabajo y repositorio git', input.id),
    input,
    pick,
  );
  el.classList.add('gs-wide');
  return el;
}

/** «Varios | Uno»: a segmented pair of radios over `multi` / `single`. */
function buildModeRow(group: Group, store: GroupStore): HTMLElement {
  const segmented = document.createElement('div');
  segmented.className = 'mode-segmented';
  segmented.setAttribute('role', 'radiogroup');
  segmented.setAttribute('aria-label', 'Modo');
  const options = [
    { value: 'multi', label: 'Varios' },
    { value: 'single', label: 'Uno' },
  ] as const;
  for (const { value, label } of options) {
    const option = document.createElement('label');
    option.className = 'mode-segment';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `mode-${group.id}`;
    radio.value = value;
    radio.checked = (group.mode || 'multi') === value;
    radio.addEventListener('change', () => {
      if (radio.checked)
        store.mutateDraft((d) => {
          d.mode = value;
        });
    });
    const text = document.createElement('span');
    text.textContent = label;
    option.append(radio, text);
    segmented.append(option);
  }
  return row(
    rowLabel('Modo', 'Cuántos comandos pueden correr a la vez'),
    segmented,
  );
}
