/**
 * The toolbar's «⋯» menu: the actions on the view as a whole that used to be
 * a row of icon buttons — clear, copy, detach — plus the switch for the
 * activity strip. They are used rarely enough that a menu costs nothing, and
 * the toolbar has room again for what you read while the log runs.
 *
 * The entries are built when the menu opens, so «Copiar» can say whether it
 * copies the selection or everything the filter leaves — and so a narrow
 * toolbar, which stops drawing Reiniciar, Parar and Silenciados, finds them
 * here instead.
 */
import {
  createDeviceMenu,
  type MenuEntry,
} from '../config/remote-device-menu.js';
import { activityShown, setActivityShown } from './activity.js';
import { buffer } from './buffer.js';
import { clearLog, detachLog } from './header.js';
import { logsParams } from './params.js';
import { copyPicked } from './selection-ui.js';
import {
  moreBtn,
  restartBtn,
  runBtn,
  silenceToggleBtn,
  silenceToggleCountEl,
} from './elements.js';
import { view } from './view.js';

const menu = createDeviceMenu();

/**
 * A toolbar button the service has (not `hidden`) that the stylesheet is not
 * drawing: the «Logs: header» container query folds it on a narrow toolbar.
 * Reading the computed style keeps the stylesheet the one place that decides.
 */
function folded(button: HTMLButtonElement): boolean {
  return !button.hidden && getComputedStyle(button).display === 'none';
}

/** The folded toolbar buttons, each acting through the button itself. */
function foldedEntries(): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (folded(restartBtn))
    entries.push({
      label: 'Reiniciar',
      icon: 'rotate-cw',
      run: () => restartBtn.click(),
    });
  if (folded(runBtn)) {
    // The name, not the title: the tooltip layer moves every title away.
    const label = runBtn.getAttribute('aria-label') ?? 'Iniciar';
    entries.push({
      label,
      icon: label === 'Parar' ? 'square' : 'play',
      run: () => runBtn.click(),
    });
  }
  if (folded(silenceToggleBtn)) {
    const count = silenceToggleCountEl.textContent;
    entries.push({
      label: count ? `Silenciados (${count})` : 'Silenciados',
      icon: 'bell-off',
      run: () => silenceToggleBtn.click(),
    });
  }
  return entries;
}

/** What the menu offers right now, in order. */
export function menuEntries(): MenuEntry[] {
  const selected = buffer.selected.size;
  const fold = foldedEntries();
  const entries: MenuEntry[] = [
    ...(fold.length ? [...fold, null] : []),
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
    null,
    {
      label: 'Mostrar actividad',
      icon: 'activity',
      checked: activityShown(),
      run: () => setActivityShown(!activityShown()),
    },
  ];
  // Only a single service can be detached, and a detached window already is.
  if (view.processId && !logsParams.isDetached)
    entries.push({
      label: 'Separar ventana',
      icon: 'app-window',
      run: detachLog,
    });
  return entries;
}

moreBtn.addEventListener('click', () => menu.toggle(moreBtn, menuEntries()));
