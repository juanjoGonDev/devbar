import type { McpClient } from '../../src/ipc-contract/mcp-api.js';
import { iconButton } from '../icon.js';
import { span } from './mcp-client-parts.js';

/**
 * «Renombrar» in a client's «⋯» menu: the name in its row turns into a field
 * with a small save (check) and cancel (x) next to it, and the line under it
 * says how to leave. Enter, the check or leaving the field saves; Escape or
 * the x cancels, without the Escape reaching anything else (an open sheet,
 * the window). A blank or unchanged name saves nothing. The list repaints the
 * row afterwards, so nothing here has to put the old title back.
 */

const MAX_NAME = 80;

export interface RenameDeps {
  /** Sends the new, trimmed name to main; settles once it answered. */
  save(name: string): Promise<void>;
  /**
   * The edit is over (saved or not). `refocus` is true when it ended from
   * the keyboard or its own buttons, so focus can go back to the row's
   * «⋯»; leaving the field already put focus somewhere else.
   */
  done(refocus: boolean): void;
}

/** Turns `row`'s name into the field; false when the row has no title. */
export function startRename(
  row: HTMLElement,
  client: McpClient,
  deps: RenameDeps,
): boolean {
  const title = row.querySelector('.mcp-client-title');
  const meta = row.querySelector('.mcp-client-meta');
  if (!title || !meta) return false;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = client.name;
  input.maxLength = MAX_NAME;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Nombre de la conexión');
  const save = iconButton('check', 'Guardar (Intro)', 'is-save');
  const cancel = iconButton('x', 'Cancelar (Esc)', 'is-cancel');
  const box = span('mcp-rename', '');
  box.append(input, save, cancel);

  title.replaceChildren(box);
  meta.textContent = 'Intro para guardar · Esc para cancelar';
  meta.classList.add('mcp-rename-hint');
  row.classList.add('is-renaming');
  input.focus();
  input.select();

  let finished = false;
  const finish = async (keep: boolean, refocus: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (keep && name && name !== client.name) await deps.save(name);
    deps.done(refocus);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    void finish(event.key === 'Enter', true);
  });
  input.addEventListener('blur', () => void finish(true, false));
  // Pressing either button must not blur the field first (that would save).
  for (const button of [save, cancel])
    button.addEventListener('mousedown', (event) => event.preventDefault());
  save.addEventListener('click', () => void finish(true, true));
  cancel.addEventListener('click', () => void finish(false, true));
  return true;
}
