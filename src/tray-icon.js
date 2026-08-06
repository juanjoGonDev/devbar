const { nativeImage } = require('electron');
const { drawGlyphBGRA } = require('./glyph-bitmap');

const STATES = ['stopped', 'running', 'warn', 'error'];

// Mark colour per state (RGB). The menubar shows the app's ">|" glyph tinted
// with these instead of a plain coloured dot.
const COLORS = {
  stopped: [152, 152, 157], // neutral grey
  running: [48, 209, 88], // green
  warn: [255, 214, 10], // yellow
  error: [255, 69, 58], // red
};

// Cache keyed by state. The glyph colour is theme-independent, so no rebuild on
// appearance change is needed (the tint carries the meaning, not the shape).
const iconCache = {};

function loadIcon(state) {
  if (iconCache[state]) return iconCache[state];

  const rgb = COLORS[state] || COLORS.stopped;
  const img = nativeImage.createFromBitmap(drawGlyphBGRA(18, rgb), {
    width: 18,
    height: 18,
  });
  img.addRepresentation({
    scaleFactor: 2,
    width: 36,
    height: 36,
    buffer: drawGlyphBGRA(36, rgb),
  });
  // NOT a template image — we want the literal green/yellow/red colours.
  img.setTemplateImage(false);
  iconCache[state] = img;
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
