/**
 * Laying a group's rows out in the order `sidebar-order.ts` decides, and the
 * «+ N parados» fold that hides the stopped tail.
 *
 * Rows are MOVED, never rebuilt: the tree is repainted in place once a second
 * and a service starting or stopping changes the order, so rebuilding would
 * drop a click in progress on a counter, the focus and the tooltip anchor.
 * A row is only moved when the order actually changed.
 *
 * This sits below `scope.ts` on purpose: revealing a service the window just
 * opened has to be able to open the fold it is hidden behind.
 */
import { arrangeGroup } from './sidebar-order.js';
import type { LogListGroup } from '../../src/ipc-contract.js';

function foldKey(groupId: string): string {
  return `devbar.logs.stopped.${groupId}`;
}

function isUnfolded(groupId: string): boolean {
  return localStorage.getItem(foldKey(groupId)) === 'open';
}

function rowsOf(box: HTMLElement): HTMLElement[] {
  return Array.from(box.querySelectorAll<HTMLElement>(':scope > .side-item'));
}

function foldButton(box: HTMLElement): HTMLButtonElement {
  const existing = box.querySelector<HTMLButtonElement>(':scope > .s-fold');
  if (existing) return existing;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 's-fold';
  button.addEventListener('click', () => {
    const details = button.closest<HTMLElement>('.side-group');
    if (details) unfoldGroup(details);
  });
  return button;
}

/** Order the rows of one group, mark the stopped ones and fold the tail. */
export function layoutGroupItems(
  details: HTMLElement,
  group: LogListGroup,
): void {
  const box = details.querySelector<HTMLElement>(':scope > .side-items');
  if (!box) return;
  const { order, folded } = arrangeGroup(
    group.items,
    isUnfolded(group.groupId),
  );
  const byId = new Map(rowsOf(box).map((row) => [row.dataset.id ?? '', row]));
  const wanted = order.flatMap((id) => byId.get(id) ?? []);
  const fold = foldButton(box);
  const foldedSet = new Set(folded);
  const firstFolded = wanted.find((row) => foldedSet.has(row.dataset.id ?? ''));
  // Where everything should sit, the fold button just before the first row
  // it hides. Moving nodes that are already in place would still churn the
  // DOM, so the current order is compared first.
  const target: HTMLElement[] = [];
  for (const row of wanted) {
    if (row === firstFolded) target.push(fold);
    target.push(row);
  }
  if (!firstFolded) target.push(fold);
  const current = Array.from(box.children);
  if (
    current.length !== target.length ||
    target.some((node, i) => current[i] !== node)
  )
    box.append(...target);
  for (const row of wanted)
    row.classList.toggle('folded', foldedSet.has(row.dataset.id ?? ''));
  fold.hidden = folded.length === 0;
  const label = `+ ${folded.length} parados`;
  if (fold.textContent !== label) fold.textContent = label; // repainted every second
  fold.title = `Mostrar los ${folded.length} servicios parados`;
}

/** Open a group's fold for good — the reader asked to see what it hides. */
export function unfoldGroup(details: HTMLElement): void {
  const groupId = details.dataset.groupId;
  if (groupId) localStorage.setItem(foldKey(groupId), 'open');
  const box = details.querySelector<HTMLElement>(':scope > .side-items');
  if (!box) return;
  for (const row of rowsOf(box)) row.classList.remove('folded');
  const fold = box.querySelector<HTMLElement>(':scope > .s-fold');
  if (fold) fold.hidden = true;
}
