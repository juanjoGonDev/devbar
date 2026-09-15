import { nativeImage, nativeTheme, type NativeImage } from 'electron';
import { drawGlyphBGRA } from './glyph-bitmap.js';
export type TrayColor = 'stopped' | 'running' | 'warn' | 'error';
const STATES: readonly TrayColor[] = ['stopped', 'running', 'warn', 'error'];
const COLORS: Record<TrayColor, readonly [number, number, number]> = {
  stopped: [152, 152, 157],
  running: [48, 209, 88],
  warn: [255, 214, 10],
  error: [255, 69, 58],
};
// macOS-style "there is something new" red, kept separate from the error tint
// so the badge still reads as a badge on an already-red mark.
const BADGE_RGB: readonly [number, number, number] = [255, 59, 48];
const iconCache: Partial<Record<string, NativeImage>> = {};
function outlineColor(dark: boolean): readonly [number, number, number] {
  return dark ? [235, 235, 240] : [28, 28, 30];
}
/**
 * The number shown for the tray: errors first, warnings when there are no
 * errors, nothing when both are zero. Same rule for the macOS title and
 * the badge drawn into the win/linux icon.
 */
export function badgeCount(errs: number, warns: number): number {
  return errs > 0 ? errs : warns;
}

export function loadIcon(
  state: TrayColor,
  hasUpdate = false,
  count = 0,
): NativeImage {
  const dark = nativeTheme.shouldUseDarkColors,
    key = `${state}:${dark ? 'd' : 'l'}:${hasUpdate ? 'u' : '-'}:${count}`,
    cached = iconCache[key];
  if (cached) return cached;
  const rgb = COLORS[state] ?? COLORS.stopped,
    out = outlineColor(dark),
    // The count bubble reuses the update-badge red; with no count, the
    // pending-update cue is the small dot.
    badge = count > 0 || hasUpdate ? BADGE_RGB : undefined,
    image = nativeImage.createFromBitmap(
      drawGlyphBGRA(18, rgb, out, badge, count),
      { width: 18, height: 18 },
    );
  image.addRepresentation({
    scaleFactor: 2,
    width: 36,
    height: 36,
    buffer: drawGlyphBGRA(36, rgb, out, badge, count),
  });
  image.setTemplateImage(false);
  iconCache[key] = image;
  return image;
}
export function invalidateCache(): void {
  for (const key of Object.keys(iconCache)) delete iconCache[key];
}
export function preload(): void {
  for (const state of STATES) loadIcon(state);
}
export function defaultIcon(): NativeImage {
  return loadIcon('stopped');
}
const SEVERITY: Record<TrayColor, number> = {
  stopped: 0,
  running: 1,
  warn: 2,
  error: 3,
};
export function aggregateColor(
  states: readonly { color?: string | null }[],
): TrayColor {
  let worst: TrayColor = 'stopped';
  for (const state of states) {
    const color: TrayColor =
      state.color === 'running' ||
      state.color === 'warn' ||
      state.color === 'error'
        ? state.color
        : 'stopped';
    if (SEVERITY[color] > SEVERITY[worst]) worst = color;
  }
  return worst;
}
