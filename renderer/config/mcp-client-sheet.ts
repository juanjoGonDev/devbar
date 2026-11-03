import type {
  McpClient,
  McpClientPatch,
  McpConfirmPolicy,
  McpMutationResult,
  McpScopes,
  McpState,
} from '../../src/ipc-contract/mcp-api.js';
import { icon, type IconName } from '../icon.js';
import {
  clientInitial,
  connectionLine,
  SCOPE_KEYS,
  SCOPE_LABELS,
} from './mcp-format.js';
import { wireSheetChrome } from './sheet-chrome.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * One client's permissions, in the settings side sheet: a switch and a
 * confirmation policy per scope, the groups it may see, whether secrets are
 * masked, and «Revocar acceso». For a pending (or revoked) client the same
 * sheet is the approval: it opens on the defaults main gave the client and
 * «Permitir» lets it in with what is picked.
 */

export interface McpSheetElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  avatar: HTMLElement;
  title: HTMLElement;
  scopes: HTMLElement;
  groupsAll: HTMLInputElement;
  groupsSome: HTMLInputElement;
  groups: HTMLElement;
  redact: HTMLInputElement;
  connection: HTMLElement;
  revoke: HTMLButtonElement;
  submit: HTMLButtonElement;
  submitLabel: HTMLElement;
  shortcutKey: HTMLElement;
}

export interface McpSheetDeps {
  showToast: ShowToast;
  /** The groups a client can be limited to, as the window knows them. */
  getGroups(): readonly { id: string; name: string }[];
  platform: string;
  /** Main answered a change: the pane repaints from it. */
  onState(state: McpState): void;
}

export interface McpClientSheet {
  open(client: McpClient): void;
}

type ScopeKey = keyof McpScopes;

interface ScopeMeta {
  icon: IconName;
  hint: string;
  /** The confirmation choices; a single one is fixed. */
  policies: readonly [string, string][];
}

const CHOICES: readonly [McpConfirmPolicy, string][] = [
  ['never', 'Sin preguntar'],
  ['first', 'Preguntar la primera vez'],
  ['always', 'Preguntar siempre'],
];

const SCOPES: Readonly<Record<ScopeKey, ScopeMeta>> = {
  read: {
    icon: 'eye',
    hint: 'Estado, puertos, logs y búsqueda en logs.',
    policies: [['never', 'Sin preguntar']],
  },
  control: {
    icon: 'play',
    hint: 'Arrancar, parar y reiniciar comandos; lanzar acciones.',
    policies: CHOICES,
  },
  workflows: {
    icon: 'workflow',
    hint: 'Lanzar, detener y seguir workflows.',
    policies: CHOICES,
  },
  config: {
    icon: 'pencil',
    hint: 'Crear, editar y borrar grupos, comandos, acciones y workflows; importar y exportar.',
    policies: [['always', 'Preguntar siempre con diff']],
  },
};

interface Draft {
  scopes: McpScopes;
  confirm: { control: McpConfirmPolicy; workflows: McpConfirmPolicy };
  groups: 'all' | string[];
  redactSecrets: boolean;
}

function isPolicy(value: string): value is McpConfirmPolicy {
  return value === 'never' || value === 'first' || value === 'always';
}

export function createMcpClientSheet(
  els: McpSheetElements,
  deps: McpSheetDeps,
): McpClientSheet {
  const switches = {} as Record<ScopeKey, HTMLInputElement>;
  const selects = {} as Record<ScopeKey, HTMLSelectElement>;
  let client: McpClient | null = null;
  let selected = new Set<string>();
  let initial = '';
  let busy = false;

  // The four scope rows are fixed: built once, filled on every open.
  for (const key of SCOPE_KEYS) {
    const meta = SCOPES[key];
    const row = document.createElement('div');
    row.className = 'mcp-scope';
    row.dataset.scope = key;

    const tile = document.createElement('span');
    tile.className = 'mcp-scope-tile';
    tile.append(icon(meta.icon));

    const text = document.createElement('div');
    text.className = 'mcp-scope-text';
    const title = document.createElement('span');
    title.className = 'mcp-scope-title';
    title.textContent = SCOPE_LABELS[key];
    const hint = document.createElement('span');
    hint.className = 'mcp-hint';
    hint.textContent = meta.hint;
    if (key === 'config') {
      const warning = document.createElement('strong');
      warning.className = 'mcp-scope-warning';
      warning.textContent = 'Puede cambiar qué se ejecuta en tu equipo.';
      hint.append(' ', warning);
    }
    text.append(title, hint);

    const select = document.createElement('select');
    select.id = `mcp-confirm-${key}`;
    select.className = 'mcp-select';
    select.setAttribute('aria-label', `Confirmación de ${SCOPE_LABELS[key]}`);
    for (const [value, label] of meta.policies)
      select.append(new Option(label, value));
    select.disabled = meta.policies.length === 1;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = `mcp-scope-${key}`;
    toggle.className = 'remote-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', SCOPE_LABELS[key]);

    row.append(tile, text, select, toggle);
    els.scopes.append(row);
    switches[key] = toggle;
    selects[key] = select;
  }

  function policyOf(key: 'control' | 'workflows'): McpConfirmPolicy {
    const value = selects[key].value;
    return isPolicy(value) ? value : 'always';
  }

  function read(): Draft {
    const scopes = {} as McpScopes;
    for (const key of SCOPE_KEYS) scopes[key] = switches[key].checked;
    const known = deps.getGroups().map((group) => group.id);
    return {
      scopes,
      confirm: {
        control: policyOf('control'),
        workflows: policyOf('workflows'),
      },
      groups: els.groupsAll.checked
        ? 'all'
        : known.filter((id) => selected.has(id)),
      redactSecrets: els.redact.checked,
    };
  }

  function renderChips(): void {
    els.groups.hidden = els.groupsAll.checked;
    const chips = deps.getGroups().map((group) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mcp-group-chip';
      chip.dataset.id = group.id;
      chip.textContent = group.name;
      chip.setAttribute('aria-pressed', String(selected.has(group.id)));
      chip.addEventListener('click', () => {
        if (selected.has(group.id)) selected.delete(group.id);
        else selected.add(group.id);
        chip.setAttribute('aria-pressed', String(selected.has(group.id)));
      });
      return chip;
    });
    els.groups.replaceChildren(...chips);
  }

  const chrome = wireSheetChrome({
    dialog: els.dialog,
    form: els.form,
    firstField: switches.read,
    shortcutHint: els.shortcutKey,
    platform: deps.platform,
    isDirty: () => client !== null && JSON.stringify(read()) !== initial,
    dismissPopover: () => false,
  });

  els.groupsAll.addEventListener('change', renderChips);
  els.groupsSome.addEventListener('change', renderChips);

  /** True when main took it; otherwise says why and keeps the sheet open. */
  async function commit(call: Promise<McpMutationResult>): Promise<boolean> {
    try {
      const result = await call;
      if (!result.ok) {
        deps.showToast(result.error, 'error');
        return false;
      }
      deps.onState(result.state);
      return true;
    } catch (err) {
      deps.showToast(`Error: ${errorMessage(err)}`, 'error');
      return false;
    }
  }

  /** What an approval leaves to a second call: everything but the scopes. */
  function restChanged(current: McpClient, draft: Draft): boolean {
    return (
      current.confirm.control !== draft.confirm.control ||
      current.confirm.workflows !== draft.confirm.workflows ||
      JSON.stringify(current.groups) !== JSON.stringify(draft.groups) ||
      current.redactSecrets !== draft.redactSecrets
    );
  }

  async function save(current: McpClient): Promise<boolean> {
    const draft = read();
    if (current.status === 'allowed') {
      const patch: McpClientPatch = { ...draft };
      return commit(window.api.updateMcpClient(current.id, patch));
    }
    if (!(await commit(window.api.approveMcpClient(current.id, draft.scopes))))
      return false;
    // Approved now: should the second save fail, a retry must not approve again.
    client = { ...current, status: 'allowed', scopes: draft.scopes };
    if (!restChanged(current, draft)) return true;
    return commit(
      window.api.updateMcpClient(current.id, {
        confirm: draft.confirm,
        groups: draft.groups,
        redactSecrets: draft.redactSecrets,
      }),
    );
  }

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!client || busy) return;
    busy = true;
    els.submit.disabled = true;
    try {
      if (await save(client)) els.dialog.close();
    } finally {
      busy = false;
      els.submit.disabled = false;
    }
  });

  els.revoke.addEventListener('click', async () => {
    if (!client) return;
    if (
      !confirm(
        `¿Revocar el acceso de ${client.name}? Perderá todas las herramientas hasta que lo permitas de nuevo.`,
      )
    )
      return;
    els.revoke.disabled = true;
    try {
      if (await commit(window.api.revokeMcpClient(client.id)))
        els.dialog.close();
    } finally {
      els.revoke.disabled = false;
    }
  });

  els.dialog.addEventListener('close', () => {
    client = null;
  });

  return {
    open(next) {
      client = next;
      const approving = next.status !== 'allowed';
      els.avatar.textContent = clientInitial(next.name);
      els.avatar.dataset.kind = next.kind ?? 'other';
      els.title.textContent = next.name;
      els.dialog.setAttribute('aria-label', `Permisos de ${next.name}`);
      for (const key of SCOPE_KEYS) switches[key].checked = next.scopes[key];
      selects.read.value = 'never';
      selects.control.value = next.confirm.control;
      selects.workflows.value = next.confirm.workflows;
      selects.config.value = 'always';
      els.groupsAll.checked = next.groups === 'all';
      els.groupsSome.checked = next.groups !== 'all';
      selected = new Set(next.groups === 'all' ? [] : next.groups);
      renderChips();
      els.redact.checked = next.redactSecrets;
      els.connection.textContent = approving
        ? 'Local (stdio) · todavía sin permiso'
        : connectionLine(next, Date.now());
      els.revoke.hidden = approving;
      els.submitLabel.textContent = approving ? 'Permitir' : 'Guardar';
      initial = JSON.stringify(read());
      chrome.open();
    },
  };
}
