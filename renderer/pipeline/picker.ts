import { icon } from '../icon.js';
import { groupTile } from './group-tile.js';
import { pipelineRefKey } from '../../src/pipeline-graph.js';
import type { Group, PreStepScriptRef } from '../../src/domain-types.js';
import type { Point } from './viewport.js';

interface PickerRequest {
  /** Where the popover's top-left goes, in the host's coordinates. */
  at: Point;
  groups: readonly Group[];
  placed: ReadonlySet<string>;
  onPick(ref: PreStepScriptRef): void;
  /** "Nuevo pre-script…": offered only when set. */
  onCreate: (() => void) | null;
  /** Runs however the picker closes (pick, Esc, a click outside). */
  onClose(): void;
}

export interface Picker {
  open(request: PickerRequest): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * The "+" popover: an autofocused search over every pre-script, grouped by
 * group. Placed ones stay listed but disabled ("En el workflow"); ↑/↓ move
 * through the rest (and the "Nuevo pre-script…" footer), Enter picks, Esc or
 * a click outside closes.
 */
/** Nudges the popover back inside its host when it would spill out. */
function keepInside(root: HTMLElement, host: HTMLElement): void {
  const margin = 8;
  const maxX = host.clientWidth - root.offsetWidth - margin;
  const maxY = host.clientHeight - root.offsetHeight - margin;
  if (maxX > 0 && root.offsetLeft > maxX) root.style.left = `${maxX}px`;
  if (maxY > 0 && root.offsetTop > maxY) root.style.top = `${maxY}px`;
}

export function createPicker(host: HTMLElement): Picker {
  let current: { request: PickerRequest; root: HTMLElement } | null = null;

  function close(): void {
    if (!current) return;
    const { request, root } = current;
    current = null;
    root.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    request.onClose();
  }

  function onOutside(event: Event): void {
    if (!current) return;
    const target = event.target;
    if (target instanceof Node && current.root.contains(target)) return;
    close();
  }

  function open(request: PickerRequest): void {
    close();
    const root = document.createElement('div');
    root.className = 'pipeline-picker';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Añadir pre-script');
    root.style.left = `${request.at.x}px`;
    root.style.top = `${request.at.y}px`;

    const field = document.createElement('div');
    field.className = 'pipeline-picker-search';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Buscar pre-script…';
    input.setAttribute('aria-label', 'Buscar pre-script');
    const esc = document.createElement('kbd');
    esc.textContent = 'esc';
    field.append(icon('search'), input, esc);

    const list = document.createElement('div');
    list.className = 'pipeline-picker-list';
    root.append(field, list);

    let footer: HTMLButtonElement | null = null;
    if (request.onCreate) {
      const create = request.onCreate;
      const sep = document.createElement('div');
      sep.className = 'pipeline-picker-sep';
      footer = document.createElement('button');
      footer.type = 'button';
      footer.className = 'pipeline-picker-option is-create';
      const label = document.createElement('span');
      label.textContent = 'Nuevo pre-script…';
      footer.append(icon('plus'), label);
      footer.addEventListener('click', () => {
        close();
        create();
      });
      root.append(sep, footer);
    }

    let active = 0;
    const choices = (): HTMLButtonElement[] => [
      ...list.querySelectorAll<HTMLButtonElement>(
        '.pipeline-picker-option:not([disabled])',
      ),
      ...(footer ? [footer] : []),
    ];
    const paintActive = (): void => {
      choices().forEach((choice, index) =>
        choice.classList.toggle('is-active', index === active),
      );
    };

    function fill(): void {
      const needle = input.value.trim().toLocaleLowerCase();
      const nodes: HTMLElement[] = [];
      for (const group of request.groups) {
        const scripts = group.preScripts.filter((script) =>
          script.name.toLocaleLowerCase().includes(needle),
        );
        if (scripts.length === 0) continue;
        const name = document.createElement('div');
        name.className = 'pipeline-picker-group-name';
        name.textContent = group.name;
        nodes.push(name);
        for (const script of scripts) {
          const ref = { groupId: group.id, scriptId: script.id };
          const placed = request.placed.has(pipelineRefKey(ref));
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'pipeline-picker-option';
          option.dataset.ref = pipelineRefKey(ref);
          option.disabled = placed;
          const label = document.createElement('span');
          label.className = 'pipeline-picker-name';
          label.textContent = script.name;
          option.append(groupTile(group, 'is-small'), label);
          if (placed) {
            const note = document.createElement('span');
            note.className = 'pipeline-picker-note';
            note.textContent = 'En el workflow';
            option.appendChild(note);
          } else {
            option.addEventListener('click', () => {
              close();
              request.onPick(ref);
            });
          }
          nodes.push(option);
        }
      }
      if (nodes.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'pipeline-picker-empty';
        empty.textContent = needle
          ? 'Ningún pre-script coincide con la búsqueda.'
          : 'Todavía no hay pre-scripts.';
        nodes.push(empty);
      }
      list.replaceChildren(...nodes);
      active = 0;
      paintActive();
    }

    input.addEventListener('input', fill);
    root.addEventListener('keydown', (event) => {
      const options = choices();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (options.length === 0) return;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        active = (active + delta + options.length) % options.length;
        paintActive();
        options[active]?.scrollIntoView?.({ block: 'nearest' });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        options[active]?.click();
      }
    });

    host.appendChild(root);
    current = { request, root };
    fill();
    keepInside(root, host);
    // The canvas clips rather than scrolls: a focus that scrolled it would
    // shift every panel off its corner.
    input.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onOutside, true);
  }

  return { open, close, isOpen: () => current !== null };
}
