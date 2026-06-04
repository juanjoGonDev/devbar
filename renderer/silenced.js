import { renderPatternList, wireAddPattern } from './silence-ui.js';

const params = new URLSearchParams(window.location.search);
const groupId = params.get('groupId');
const commandId = params.get('commandId');

let currentCommand = null;
let currentGroup = null;

const warnsEl = document.getElementById('silenced-warns');
const errsEl = document.getElementById('silenced-errs');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');

async function load() {
  if (!groupId || !commandId) {
    titleEl.textContent = 'Parámetros inválidos';
    return;
  }
  const res = await window.api.getSilencedForCommand(groupId, commandId);
  if (!res || !res.ok) {
    titleEl.textContent = 'Comando no encontrado';
    return;
  }
  currentCommand = res.command;
  currentGroup = res.group;
  const name = res.command.name || commandId;
  titleEl.textContent = `Silenciados — ${name}`;
  if (subtitleEl) subtitleEl.textContent = res.group.name || '';
  document.title = `Silenciados — ${name}`;
  render();
}

function render() {
  if (!currentCommand) return;
  const sp = currentCommand.silencedPatterns || { warn: [], error: [] };
  renderPatternList(warnsEl, sp.warn || [], 'warn', {
    onRemove: (pattern) => window.api.removeSilencePattern(groupId, commandId, 'warn', pattern),
  });
  renderPatternList(errsEl, sp.error || [], 'error', {
    onRemove: (pattern) => window.api.removeSilencePattern(groupId, commandId, 'error', pattern),
  });
}

wireAddPattern(
  document.getElementById('add-warn-input'),
  document.getElementById('add-warn-btn'),
  'warn',
  { onAdd: (pattern) => window.api.addSilencePattern(groupId, commandId, 'warn', pattern) }
);

wireAddPattern(
  document.getElementById('add-err-input'),
  document.getElementById('add-err-btn'),
  'error',
  { onAdd: (pattern) => window.api.addSilencePattern(groupId, commandId, 'error', pattern) }
);

// Live updates: re-fetch when groups change anywhere
window.api.onUpdate(async () => {
  await load();
});

// Cmd+W to close the window
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
    e.preventDefault();
    window.close();
  }
});

// Traffic light close button
document.addEventListener('click', (e) => {
  if (e.target && e.target.hasAttribute('data-close')) {
    window.close();
  }
});

load();
