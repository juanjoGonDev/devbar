import { icon, type IconName } from '../icon.js';

/**
 * The «⋯» menu of a linked device: a small `role="menu"` popup that opens
 * under its button, inside the device's row. Only one is open at a time.
 * Escape closes it and gives focus back to its button; a click anywhere
 * else, choosing an item or a repaint of the list closes it too. Focus starts
 * on the first item, and the arrow keys, Home and End move between items.
 */

interface MenuAction {
  label: string;
  icon: IconName;
  /** Painted red: the action takes something away (Desvincular). */
  danger?: boolean;
  run(): void;
}

/** `null` draws a separator line between two groups of actions. */
export type MenuEntry = MenuAction | null;

export interface DeviceMenu {
  /** Opens `entries` under `trigger`, or closes the menu if it is its own. */
  toggle(trigger: HTMLButtonElement, entries: readonly MenuEntry[]): void;
  /**
   * Closes the open menu, if any, without moving focus. Returns its button
   * when focus was inside the menu, so a repaint can put focus back on the
   * same device's new button.
   */
  close(): HTMLButtonElement | null;
}

interface OpenMenu {
  trigger: HTMLButtonElement;
  menu: HTMLElement;
}

export function createDeviceMenu(): DeviceMenu {
  let open: OpenMenu | null = null;

  const menuItems = (menu: HTMLElement): HTMLButtonElement[] => [
    ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ];

  function close(restoreFocus: boolean): HTMLButtonElement | null {
    if (!open) return null;
    const { trigger, menu } = open;
    const hadFocus = menu.contains(document.activeElement);
    open = null;
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
    return hadFocus ? trigger : null;
  }

  /** The index arrow keys, Home and End lead to, or null for other keys. */
  function target(key: string, at: number, count: number): number | null {
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    if (key === 'ArrowDown') return (at + 1) % count;
    if (key === 'ArrowUp') return at <= 0 ? count - 1 : at - 1;
    return null;
  }

  function item(action: MenuAction): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.danger
      ? 'remote-menu-item is-danger'
      : 'remote-menu-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    const label = document.createElement('span');
    label.textContent = action.label;
    button.append(icon(action.icon), label);
    button.addEventListener('click', () => {
      close(true);
      action.run();
    });
    return button;
  }

  function build(entries: readonly MenuEntry[]): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'remote-menu';
    menu.setAttribute('role', 'menu');
    for (const entry of entries) {
      if (entry) {
        menu.append(item(entry));
        continue;
      }
      const line = document.createElement('div');
      line.className = 'remote-menu-separator';
      line.setAttribute('role', 'separator');
      menu.append(line);
    }
    menu.addEventListener('keydown', (event) => {
      // Tab leaves like it would from the button: close, then let it move on.
      if (event.key === 'Tab') {
        close(true);
        return;
      }
      const list = menuItems(menu);
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = target(event.key, at, list.length);
      if (next === null) return;
      event.preventDefault();
      list[next]?.focus();
    });
    return menu;
  }

  document.addEventListener('click', (event) => {
    if (!open) return;
    const clicked = event.target as Node | null;
    if (open.menu.contains(clicked) || open.trigger.contains(clicked)) return;
    close(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });

  return {
    toggle: (trigger, entries) => {
      const own = open?.trigger === trigger;
      close(own);
      if (own) return;
      const menu = build(entries);
      trigger.after(menu);
      trigger.setAttribute('aria-expanded', 'true');
      open = { trigger, menu };
      menuItems(menu)[0]?.focus();
    },
    close: () => close(false),
  };
}
