import './report-uncaught.js';
import { renderPatternList, wireAddPattern } from './silence-ui.js';
import { byId } from './dom.js';
import { latestWins } from './latest-wins.js';
import type { SilencedPatterns } from '../src/domain-types.js';
import { installTooltips } from './tooltip.js';
import { initTheme } from './theme.js';
initTheme();
const params = new URLSearchParams(window.location.search);
const groupId = params.get('groupId');
const commandId = params.get('commandId');
// The fake traffic lights imitate macOS window chrome; other platforms draw
// a real titlebar, so they are hidden there (main passes its platform label).
if (params.get('platform') && params.get('platform') !== 'macos') {
  document.body.classList.add('non-mac');
}
let currentCommand: {
  id: string;
  name: string;
  silencedPatterns: SilencedPatterns;
} | null = null;
const warns = byId('silenced-warns', HTMLUListElement);
const errors = byId('silenced-errs', HTMLUListElement);
const title = byId('title', HTMLElement);
const subtitle = byId('subtitle', HTMLElement);
function render(): void {
  if (!currentCommand || !groupId || !commandId) return;
  const patterns = currentCommand.silencedPatterns ?? { warn: [], error: [] };
  renderPatternList(warns, patterns.warn ?? [], 'warn', {
    onRemove: (pattern) =>
      window.api.removeSilencePattern(groupId, commandId, 'warn', pattern),
  });
  renderPatternList(errors, patterns.error ?? [], 'error', {
    onRemove: (pattern) =>
      window.api.removeSilencePattern(groupId, commandId, 'error', pattern),
  });
}
/**
 * Ticket for the in-flight command read. Every `groups:update` re-enters
 * `load()` without waiting for the one already running — and adding or
 * removing a pattern in this very window is what emits that update, so the
 * two overlap on the user's own click. The older answer landing last puts the
 * pattern back on screen after it was removed.
 */
const commandReads = latestWins();

async function load(): Promise<void> {
  if (!groupId || !commandId) {
    title.textContent = 'Parámetros inválidos';
    return;
  }
  // Issuing this read retires every older one still in flight.
  commandReads.invalidate();
  const current = commandReads.claim();
  const result = await window.api.getSilencedForCommand(groupId, commandId);
  if (!current()) return; // a newer read already answered
  if (!result.ok || !result.command) {
    title.textContent = 'Comando no encontrado';
    return;
  }
  currentCommand = result.command;
  const name = result.command.name || commandId;
  title.textContent = `Silenciados — ${name}`;
  subtitle.textContent = result.group?.name ?? '';
  document.title = `Silenciados — ${name}`;
  render();
}
if (groupId && commandId) {
  wireAddPattern(
    byId('add-warn-input', HTMLInputElement),
    byId('add-warn-btn', HTMLButtonElement),
    'warn',
    {
      onAdd: (pattern) =>
        window.api.addSilencePattern(groupId, commandId, 'warn', pattern),
    },
  );
  wireAddPattern(
    byId('add-err-input', HTMLInputElement),
    byId('add-err-btn', HTMLButtonElement),
    'error',
    {
      onAdd: (pattern) =>
        window.api.addSilencePattern(groupId, commandId, 'error', pattern),
    },
  );
}
window.api.onUpdate(() => {
  void load();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'w') {
    event.preventDefault();
    window.close();
  }
});
document.addEventListener('click', (event) => {
  if (
    event.target instanceof HTMLElement &&
    event.target.hasAttribute('data-close')
  )
    window.close();
});
void load();

installTooltips();
