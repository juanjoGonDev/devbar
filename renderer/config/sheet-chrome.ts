import { icon } from '../icon.js';

/**
 * The behaviour around the side sheet's fields: opening it with focus on
 * the first field and giving focus back to the opener on close, keeping Tab
 * inside it, Cmd/Ctrl+S to save, and Escape, × or a click on the backdrop to
 * close — asking first when that would throw edits away.
 */
export interface SheetChromeDeps {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  /** Where focus lands when the sheet opens. */
  firstField: HTMLElement;
  /** The «Guardar» shortcut hint. */
  shortcutHint: HTMLElement;
  platform: string;
  isDirty(): boolean;
  /** Closes a popover open over the sheet; true when there was one. */
  dismissPopover(): boolean;
}

export interface SheetChrome {
  open(): void;
  /** Closes, after asking when there are edits to lose. */
  requestClose(): void;
}

const FOCUSABLE =
  'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Shown, enabled and in the tab order, within `root`. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled) return false;
    for (let node: HTMLElement | null = el; node && node !== root;) {
      if (node.hidden || node.style.display === 'none') return false;
      node = node.parentElement;
    }
    return true;
  });
}

export function wireSheetChrome(deps: SheetChromeDeps): SheetChrome {
  const { dialog } = deps;
  let opener: HTMLElement | null = null;

  // The hint names the key this platform uses.
  if (deps.platform === 'darwin')
    deps.shortcutHint.replaceChildren(icon('command'), 'S');
  else deps.shortcutHint.textContent = 'Ctrl+S';

  function requestClose(): void {
    if (deps.isDirty() && !confirm('¿Descartar los cambios?')) return;
    dialog.close();
  }

  function trapTab(event: KeyboardEvent): void {
    const list = tabbables(dialog);
    const first = list[0];
    const last = list.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!deps.dismissPopover()) requestClose();
    } else if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 's'
    ) {
      event.preventDefault();
      deps.form.requestSubmit();
    } else if (event.key === 'Tab') {
      trapTab(event);
    }
  });
  // Escape is handled above; the native cancel would close without asking.
  dialog.addEventListener('cancel', (event) => event.preventDefault());

  dialog.querySelectorAll<HTMLElement>('[data-close]').forEach((button) => {
    button.addEventListener('click', requestClose);
  });
  // A click on the dimmed backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) requestClose();
  });

  dialog.addEventListener('close', () => {
    if (opener?.isConnected) opener.focus();
    opener = null;
  });

  return {
    open() {
      opener =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialog.showModal();
      deps.firstField.focus();
    },
    requestClose,
  };
}
