import type {
  McpClientKind,
  McpMutationResult,
  McpState,
} from '../../src/ipc-contract/mcp-api.js';
import { createMcpClientSheet } from './mcp-client-sheet.js';
import { createMcpClientList } from './mcp-clients.js';
import type { McpElements } from './mcp-elements.js';
import { connectSnippet, serverStatus } from './mcp-format.js';
import { errorMessage, type ShowToast } from './toast.js';

/**
 * «MCP»: the server card (switch, status, transport), the ready-to-paste
 * commands that connect an assistant, and the clients with their
 * permissions sheet. Main owns the state; this paints whatever `McpState`
 * it last reported (answers and `mcp:update` pushes alike) and forwards the
 * clicks.
 */

export interface McpPaneDeps {
  showToast: ShowToast;
  getGroups(): readonly { id: string; name: string }[];
  platform: string;
}

/** Repaint cadence, so «Último uso: hace …» keeps counting. */
const USAGE_REFRESH_MS = 30_000;

const KINDS: readonly McpClientKind[] = [
  'claude-code',
  'claude-desktop',
  'cursor',
  'other',
];

function isKind(value: string): value is McpClientKind {
  return (KINDS as readonly string[]).includes(value);
}

export function createMcpPane(els: McpElements, deps: McpPaneDeps): void {
  const { showToast } = deps;
  let state: McpState | null = null;
  let kind: McpClientKind = 'claude-code';

  const sheet = createMcpClientSheet(els.sheet, {
    showToast,
    getGroups: () => deps.getGroups(),
    platform: deps.platform,
    onState: (next) => apply(next),
  });
  const clients = createMcpClientList(els.clients, {
    onReject: (client) => void mutate(window.api.rejectMcpClient(client.id)),
    onAllow: (client) => sheet.open(client),
    onPermissions: (client) => sheet.open(client),
  });

  async function mutate(call: Promise<McpMutationResult>): Promise<void> {
    try {
      const result = await call;
      if (result.ok) apply(result.state);
      else showToast(result.error, 'error');
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
    }
  }

  function renderServer(current: McpState): void {
    const { enabled, status, error } = els.server;
    enabled.checked = current.settings.enabled;
    enabled.disabled = false;
    const line = serverStatus(current);
    status.textContent = line.text;
    status.classList.toggle('is-on', line.tone === 'on');
    status.classList.toggle('is-error', line.tone === 'error');
    error.hidden = !current.error;
    error.textContent = current.error ?? '';
  }

  function renderConnect(current: McpState): void {
    const snippet = connectSnippet(current.connectCommand, kind);
    els.connect.code.textContent = snippet.code;
    els.connect.hint.textContent = snippet.hint;
  }

  function apply(next: McpState): void {
    state = next;
    renderServer(next);
    renderConnect(next);
    clients.render(next.clients, Date.now());
  }

  els.server.enabled.addEventListener('change', async () => {
    const toggle = els.server.enabled;
    toggle.disabled = true;
    try {
      apply(await window.api.setMcpEnabled(toggle.checked));
    } catch (err) {
      showToast(`Error: ${errorMessage(err)}`, 'error');
      if (state) renderServer(state);
      else toggle.checked = !toggle.checked;
    } finally {
      toggle.disabled = false;
    }
  });

  els.connect.kinds.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !isKind(target.value)) return;
    kind = target.value;
    if (state) renderConnect(state);
  });

  els.connect.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.connect.code.textContent);
      showToast('Copiado', 'ok');
    } catch (err) {
      showToast(`No se pudo copiar: ${errorMessage(err)}`, 'error');
    }
  });

  window.api.onMcpUpdate(apply);
  setInterval(() => {
    if (state) clients.render(state.clients, Date.now());
  }, USAGE_REFRESH_MS);
  window.api
    .getMcpState()
    .then(apply)
    .catch((err: unknown) =>
      showToast(`Error al leer el MCP: ${errorMessage(err)}`, 'error'),
    );
}
