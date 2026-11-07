import { icon } from '../icon.js';
import { groupTile } from './group-tile.js';
import { pipelineRefKey } from '../../src/pipeline-graph.js';
import type { Group } from '../../src/domain-types.js';

const NO_SCRIPTS = 'Todavía no hay pre-scripts. Crea el primero arriba.';
const NO_MATCHES = 'Ningún pre-script coincide con la búsqueda.';

function emptyNote(text: string): HTMLElement {
  const note = document.createElement('p');
  note.className = 'pipeline-palette-empty muted small';
  note.textContent = text;
  return note;
}

/**
 * The floating panel's list: every pre-script of every group, under its group
 * name and tile, filtered by `query` (case-insensitive, on the script name).
 * Each pre-script can be placed only once, so a placed one is drawn dimmed
 * with a check and is not draggable; a free one is a draggable chip carrying
 * its ref key.
 */
export function buildPaletteList(
  groups: readonly Group[],
  placed: ReadonlySet<string>,
  query: string,
): HTMLElement {
  const list = document.createElement('div');
  list.className = 'pipeline-palette-groups';
  const withScripts = groups.filter((group) => group.preScripts.length > 0);
  if (withScripts.length === 0) {
    list.appendChild(emptyNote(NO_SCRIPTS));
    return list;
  }
  const needle = query.trim().toLocaleLowerCase();
  for (const group of withScripts) {
    const scripts = group.preScripts.filter((script) =>
      script.name.toLocaleLowerCase().includes(needle),
    );
    if (scripts.length === 0) continue;
    const section = document.createElement('section');
    section.className = 'pipeline-palette-group';
    const name = document.createElement('div');
    name.className = 'pipeline-palette-group-name';
    name.textContent = group.name;
    const items = document.createElement('ul');
    for (const script of scripts) {
      const key = pipelineRefKey({ groupId: group.id, scriptId: script.id });
      const isPlaced = placed.has(key);
      const item = document.createElement('li');
      const chip = document.createElement('div');
      chip.className = 'pipeline-chip';
      chip.dataset.ref = key;
      chip.draggable = !isPlaced;
      if (isPlaced) {
        chip.classList.add('is-placed');
        chip.title = 'Ya está en el workflow';
      } else {
        chip.title = 'Arrastra al lienzo';
      }
      const label = document.createElement('span');
      label.className = 'pipeline-chip-name';
      label.textContent = script.name;
      const mark = icon(isPlaced ? 'check' : 'grip-vertical');
      mark.classList.add('pipeline-chip-mark');
      chip.append(groupTile(group, 'is-small'), label, mark);
      item.appendChild(chip);
      items.appendChild(item);
    }
    section.append(name, items);
    list.appendChild(section);
  }
  if (list.childElementCount === 0) list.appendChild(emptyNote(NO_MATCHES));
  return list;
}
