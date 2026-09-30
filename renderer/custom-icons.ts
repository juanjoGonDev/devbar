import type { CustomIcon } from '../src/domain-types.js';
import { repaintCustomIcons, setCustomIcons } from './icon.js';

/**
 * Keeps this window's copy of the uploaded-icon library (renderer/icon.ts)
 * current: loaded once, then replaced on every `customIcons:changed` push.
 * Every image reference already on screen is repainted in place — a fresh
 * upload appears, a deleted one falls back — without rebuilding any view;
 * `onChange` lets a view that lists the library itself (the icon picker)
 * follow along.
 */
export function watchCustomIcons(onChange: () => void = () => undefined): void {
  const apply = (icons: readonly CustomIcon[]): void => {
    setCustomIcons(icons);
    repaintCustomIcons(document);
    onChange();
  };
  window.api.onCustomIconsChanged(apply);
  window.api
    .listCustomIcons()
    .then(apply)
    .catch(() => {
      // No library (IPC unavailable): every image ref paints its fallback.
    });
}
