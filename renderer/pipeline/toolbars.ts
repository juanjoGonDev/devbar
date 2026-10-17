import { icon, iconButton, type IconName } from '../icon.js';
import { nodeOffset } from './geometry.js';
import { pipelineRefKey } from '../../src/pipeline-graph.js';
import type {
  PipelineBlock,
  PreStepScriptRef,
} from '../../src/domain-types.js';
import type { RunView } from './run-view.js';

/** What the toolbars read off the canvas's paint input. */
interface ToolbarInput {
  resolve: (ref: PreStepScriptRef) => unknown;
  canEdit: boolean;
  run: RunView | null;
  locked: boolean;
}

/**
 * The floating toolbars of the canvas: the selected node's (log, retry,
 * edit, take out of the frame, remove) and the one a parallel frame shows on
 * hover («Todos OK», ungroup, logs). Same look; each button carries a
 * `data-action` the editor handles by delegation.
 */

export const LOCKED_TIP = 'No disponible durante la ejecución';
const REQUIRE_ALL_TIP = 'Si uno falla, se para';

function bar(className: string, label: string): HTMLElement {
  const node = document.createElement('div');
  node.className = `pipeline-node-toolbar ${className}`.trim();
  node.setAttribute('role', 'toolbar');
  node.setAttribute('aria-label', label);
  return node;
}

function button(
  action: string,
  name: IconName,
  label: string,
  options: { extra?: string; locked?: boolean } = {},
): HTMLButtonElement {
  const node = iconButton(
    name,
    label,
    `pipeline-icon-btn ${options.extra ?? ''}`.trim(),
  );
  node.dataset.action = action;
  if (options.locked) {
    node.setAttribute('aria-disabled', 'true');
    node.title = LOCKED_TIP;
  }
  return node;
}

export function nodeToolbar(
  input: ToolbarInput,
  block: PipelineBlock,
  ref: PreStepScriptRef,
  index: number,
): HTMLElement {
  const toolbar = bar('', 'Acciones del nodo');
  const offset = nodeOffset(index, block.scripts.length);
  toolbar.style.left = `${block.x + offset.x + 24}px`;
  toolbar.style.top = `${block.y + offset.y - 36}px`;
  const key = pipelineRefKey(ref);
  const add = (node: HTMLButtonElement): void => {
    node.dataset.ref = key;
    toolbar.appendChild(node);
  };
  const run = input.run;
  if (run?.script(key)) add(button('log', 'terminal', 'Ver log'));
  if (run?.finished && run.block(block.id) === 'error')
    add(button('retry', 'rotate-cw', 'Reintentar'));
  if (input.canEdit && input.resolve(ref))
    add(button('edit', 'pencil', 'Editar'));
  if (block.scripts.length > 1)
    add(
      button('extract', 'square-arrow-out-up-right', 'Sacar del grupo', {
        locked: input.locked,
      }),
    );
  add(
    button('remove', 'trash-2', 'Quitar', {
      extra: 'is-danger',
      locked: input.locked,
    }),
  );
  return toolbar;
}

/** Shown while the frame is hovered or holds the focus (CSS). */
export function frameToolbar(
  input: ToolbarInput,
  block: PipelineBlock,
): HTMLElement {
  const toolbar = bar('pipeline-frame-toolbar', 'Acciones del grupo');
  const requireAll = document.createElement('button');
  requireAll.type = 'button';
  requireAll.className = 'pipeline-require-all';
  requireAll.dataset.action = 'require-all';
  requireAll.setAttribute('aria-pressed', String(block.requireAll));
  const text = document.createElement('span');
  text.textContent = 'Todos OK';
  requireAll.append(icon('shield-check'), text);
  if (input.locked) {
    requireAll.setAttribute('aria-disabled', 'true');
    requireAll.title = LOCKED_TIP;
  } else requireAll.title = REQUIRE_ALL_TIP;
  const sep = document.createElement('span');
  sep.className = 'pipeline-toolbar-sep';
  toolbar.append(
    requireAll,
    sep,
    button('ungroup', 'ungroup', 'Deshacer grupo', { locked: input.locked }),
  );
  if (
    input.run &&
    block.scripts.some((ref) => input.run?.script(pipelineRefKey(ref)))
  )
    toolbar.append(button('frame-logs', 'terminal', 'Ver logs'));
  for (const node of toolbar.querySelectorAll<HTMLElement>('[data-action]'))
    node.dataset.block = block.id;
  return toolbar;
}
