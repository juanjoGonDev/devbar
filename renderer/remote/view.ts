/**
 * DOM access for the phone page. Deliberately its own copy of the helpers in
 * renderer/dom.ts: this page is served to browsers by the remote-control
 * server, which only hands out the modules in its whitelist
 * (src/main/remote/static-files.ts) — so the page imports nothing outside
 * renderer/remote/.
 *
 * Nothing here ever parses markup: text from the server only reaches the
 * page as textContent.
 */

type ElementConstructor<T extends HTMLElement> = { new (): T };

export function byId<T extends HTMLElement>(
  id: string,
  ctor: ElementConstructor<T>,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof ctor))
    throw new Error(`Missing required element: #${id}`);
  return element;
}

export type ViewName =
  | 'loading'
  | 'unlinked'
  | 'pair'
  | 'waiting'
  | 'result'
  | 'linked'
  | 'error'
  | 'keychanged'
  | 'verified'
  | 'mismatch';

/**
 * Shows exactly one `section[data-view]`, and names it on the body
 * (`data-screen`) for the styles that depend on it.
 */
export function showView(name: ViewName): void {
  for (const view of document.querySelectorAll<HTMLElement>(
    'section[data-view]',
  ))
    view.hidden = view.dataset.view !== name;
  document.body.dataset.screen = name;
}

/** A new element with its class and, optionally, its text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.addEventListener('click', onClick);
  return node;
}

export function openDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) dialog.showModal();
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
}
