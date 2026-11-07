/**
 * The toolbar's «Buscar» button. The find widget lives in the log panel and
 * owns its own state; this button only asks it to open or close, and shows
 * it pressed while the widget says it is open (`data-find-open="true"` on the
 * root element).
 */
import { findToggleBtn } from './elements.js';

const root = document.documentElement;

// The tooltip names the key this platform actually uses, like the sidebar's
// «Ctrl+K» hint.
const mac = window.api.platform === 'darwin';
const label = `Buscar (${mac ? 'Cmd' : 'Ctrl'}+F)`;
findToggleBtn.title = label;
findToggleBtn.setAttribute('aria-label', label);
findToggleBtn.setAttribute('aria-keyshortcuts', mac ? 'Meta+F' : 'Control+F');

function paintPressed(): void {
  findToggleBtn.setAttribute(
    'aria-pressed',
    String(root.dataset.findOpen === 'true'),
  );
}

findToggleBtn.addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('devbar:find', { detail: 'toggle' }));
});

new MutationObserver(paintPressed).observe(root, {
  attributes: true,
  attributeFilter: ['data-find-open'],
});
paintPressed();
