import {
  disconnect,
  extractFromBlock,
  pipelineRefKey,
  removeScript,
} from '../../src/pipeline-graph.js';
import type { PreStepScriptRef } from '../../src/domain-types.js';
import type { PipelineSync } from './sync.js';

export interface EditorEventsDeps {
  root: HTMLElement;
  canvas: HTMLElement;
  sync: PipelineSync;
  /** True right after a drag, whose closing click is not a click. */
  consumeDragClick(): boolean;
  getSelected(): string | null;
  select(key: string | null): void;
  editScript(ref: PreStepScriptRef): void;
  openPicker(stub: HTMLElement): void;
  /** The trigger node was clicked (or Enter/Space on it). */
  openTrigger(): void;
  /**
   * Any other toolbar action (log, retry, «Todos OK», ungroup…), with the
   * button that carries its `data-ref` or `data-block`.
   */
  onAction(action: string, button: HTMLElement): void;
}

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function keyToRef(key: string | undefined): PreStepScriptRef | null {
  const [groupId, scriptId] = (key ?? '').split('::');
  return groupId && scriptId ? { groupId, scriptId } : null;
}

/** The `data-from`/`data-to` of an edge's delete button. */
function edgeOf(target: Element | null): { from: string; to: string } | null {
  const button = target?.closest('.pipeline-edge-delete');
  const from = button?.getAttribute('data-from');
  const to = button?.getAttribute('data-to');
  return from && to ? { from, to } : null;
}

/**
 * The editor's clicks and keys, delegated on its root so a repaint never
 * re-wires anything: the toolbars, the trigger, an edge's ×, a "+" stub,
 * selecting a node (and deselecting on empty canvas), and Delete/Backspace,
 * Escape and Enter on a focused node.
 */
export function attachEditorEvents(deps: EditorEventsDeps): void {
  const { sync } = deps;

  function act(action: string, button: HTMLElement): void {
    const ref = keyToRef(button.dataset.ref);
    if (action === 'edit' && ref) deps.editScript(ref);
    else if (action === 'extract' && ref)
      sync.apply(extractFromBlock(sync.get(), ref));
    else if (action === 'remove' && ref) {
      deps.select(null);
      sync.apply(removeScript(sync.get(), ref));
    } else deps.onAction(action, button);
  }

  deps.root.addEventListener('click', (event) => {
    const target = asElement(event.target);
    if (!target) return;
    if (deps.consumeDragClick() && deps.canvas.contains(target)) return;
    const button = target.closest<HTMLElement>('[data-action]');
    if (button?.dataset.action && deps.canvas.contains(button)) {
      // aria-disabled (not disabled) so its tooltip can say why.
      if (button.getAttribute('aria-disabled') !== 'true')
        act(button.dataset.action, button);
      return;
    }
    if (target.closest('.pipeline-trigger')) {
      deps.openTrigger();
      return;
    }
    const edge = edgeOf(target);
    if (edge) {
      sync.apply(disconnect(sync.get(), edge.from, edge.to));
      return;
    }
    const stub = target.closest<HTMLElement>('.pipeline-stub');
    if (stub) {
      deps.openPicker(stub);
      return;
    }
    const node = target.closest<HTMLElement>('.pipeline-node');
    if (node?.dataset.ref) {
      deps.select(
        deps.getSelected() === node.dataset.ref ? null : node.dataset.ref,
      );
      return;
    }
    if (deps.canvas.contains(target) && deps.getSelected() !== null)
      deps.select(null);
  });

  deps.root.addEventListener('keydown', (event) => {
    const target = asElement(event.target);
    const edge = edgeOf(target);
    if (edge && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      sync.apply(disconnect(sync.get(), edge.from, edge.to));
      return;
    }
    if (
      target?.classList.contains('pipeline-trigger') &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      deps.openTrigger();
      return;
    }
    if (event.key === 'Escape' && deps.getSelected() !== null) {
      event.preventDefault();
      deps.select(null);
      return;
    }
    const node = target?.closest<HTMLElement>('.pipeline-node');
    const ref = keyToRef(node?.dataset.ref);
    if (!node || !ref) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      node.click();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (deps.getSelected() === pipelineRefKey(ref)) deps.select(null);
      sync.apply(removeScript(sync.get(), ref));
    }
  });
}
