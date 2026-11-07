import { icon } from '../icon.js';
import type { ConfigSection } from '../../src/ipc-contract.js';

/**
 * «Gestionar … ›»: the compact link heading each tray tab's list, which opens
 * the settings window on that tab's section. It lives inside the scrolling
 * list, so the popover's height measurement already counts it.
 */
export function manageLink(label: string, section: ConfigSection): HTMLElement {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'ghost tray-manage';
  link.append(label, icon('chevron-right'));
  link.addEventListener('click', (e) => {
    e.stopPropagation();
    void window.api.openConfig(section);
  });
  return link;
}
