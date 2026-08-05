const { nativeImage, nativeTheme } = require('electron');
const { drawDotBGRA } = require('./dot-bitmap');

const STATES = ['stopped', 'running', 'warn', 'error'];

// Core dot colour per state (RGB).
const COLORS = {
  stopped: [152, 152, 157], // neutral grey
  running: [48, 209, 88], // green
  warn: [255, 214, 10], // yellow
  error: [255, 69, 58], // red
};

// Cache keyed by `state:dark?` so a theme flip rebuilds with the right ring.
const iconCache = {};

function ringColor(dark) {
  // Contrasting ring so the dot reads on any menubar background: a light ring
  // on dark appearances, a dark ring on light ones.
  return dark ? [255, 255, 255] : [40, 40, 42];
}

function loadIcon(state) {
  const dark = nativeTheme.shouldUseDarkColors;
  const key = `${state}:${dark ? 'd' : 'l'}`;
  if (iconCache[key]) return iconCache[key];

  const rgb = COLORS[state] || COLORS.stopped;
  const ring = ringColor(dark);
  const img = nativeImage.createFromBitmap(drawDotBGRA(18, rgb, ring), {
    width: 18,
    height: 18,
  });
  img.addRepresentation({
    scaleFactor: 2,
    width: 36,
    height: 36,
    buffer: drawDotBGRA(36, rgb, ring),
  });
  // NOT a template image — we want the literal green/yellow/red colours.
  img.setTemplateImage(false);
  iconCache[key] = img;
  return img;
}

// Drop cached icons so the next loadIcon() rebuilds with the current theme.
function invalidateCache() {
  for (const k of Object.keys(iconCache)) delete iconCache[k];
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
  invalidateCache,
  STATUS_EMOJI,
  aggregateColor,
};
