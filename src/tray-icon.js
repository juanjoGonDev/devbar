const { nativeImage } = require('electron');
const path = require('path');

const STATES = ['stopped', 'running', 'warn', 'error'];
const iconCache = {};

function iconPath(state) {
  return path.join(__dirname, '..', 'assets', `icon-${state}.png`);
}

function loadIcon(state) {
  if (iconCache[state]) return iconCache[state];
  const img = nativeImage.createFromPath(iconPath(state));
  // Mark NOT as template so the OS uses our literal colors (the whole
  // point is to show green/yellow/red dots).
  img.setTemplateImage(false);
  iconCache[state] = img;
  return img;
}

function preload() {
  for (const s of STATES) loadIcon(s);
}

// Default icon used when constructing the menubar (before any state is known).
function defaultIcon() {
  return loadIcon('stopped');
}

// Kept for backward compatibility — used to be the emoji shown via setTitle.
// We still set it as a tooltip on the tray so the bullet character isn't
// the only signal.
const STATUS_EMOJI = {
  stopped: '⚫',
  running: '🟢',
  warn: '🟡',
  error: '🔴',
};

const SEVERITY = { stopped: 0, running: 1, warn: 2, error: 3 };

function aggregateColor(states) {
  let worst = 'stopped';
  for (const s of states) {
    const c = s.color || 'stopped';
    if (SEVERITY[c] > SEVERITY[worst]) worst = c;
  }
  return worst;
}

module.exports = {
  loadIcon,
  defaultIcon,
  preload,
  STATUS_EMOJI,
  aggregateColor,
};
