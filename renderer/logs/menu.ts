/**
 * The toolbar's «⋯» menu: the actions on the view as a whole that used to be
 * a row of icon buttons — clear, copy, detach. They are used rarely enough
 * that a menu costs nothing, and the toolbar has room again for what you read
 * while the log runs.
 *
 * The entries are built when the menu opens, so «Copiar» can say whether it
 * copies the selection or everything the filter leaves.
 */
import {
  createDeviceMenu,
  type MenuEntry,
} from '../config/remote-device-menu.js';
import { buffer } from './buffer.js';
import { clearLog, detachLog } from './header.js';
import { logsParams } from './params.js';
import { copyPicked } from './selection-ui.js';
import { moreBtn } from './elements.js';
import { view } from './view.js';

const menu = createDeviceMenu();

/** What the menu offers right now, in order. */
export function menuEntries(): MenuEntry[] {
  const selected = buffer.selected.size;
  const entries: MenuEntry[] = [
    {
      label: selected ? `Copiar ${selected} seleccionada(s)` : 'Copiar todo',
      icon: 'copy',
      run: copyPicked,
    },
    {
      label: 'Vaciar',
      icon: 'trash-2',
      danger: true,
      run: () => void clearLog(),
    },
  ];
  // Only a single service can be detached, and a detached window already is.
  if (view.processId && !logsParams.isDetached)
    entries.push(null, {
      label: 'Separar ventana',
      icon: 'app-window',
      run: detachLog,
    });
  return entries;
}

moreBtn.addEventListener('click', () => menu.toggle(moreBtn, menuEntries()));
