import { attachCanvasInput } from './canvas-input.js';
import { hitBlock } from './geometry.js';
import { setDraftEdge } from './graph-view.js';
import type { Viewport } from './viewport.js';
import {
  canConnect,
  connect,
  joinIntoBlock,
  moveBlock,
  type ConnectRejection,
} from '../../src/pipeline-graph.js';
import type { Pipeline } from '../../src/domain-types.js';
import type { PipelineSync } from './sync.js';

const REJECTIONS: Record<ConnectRejection, string> = {
  self: 'Un bloque no puede depender de sí mismo',
  into_trigger: 'Nada puede ir antes del desencadenante',
  unknown_block: 'Ese bloque ya no está en el workflow',
  duplicate: 'Esa conexión ya existe',
  cycle: 'Esa conexión cerraría un ciclo',
};

/** What a drag in progress shows: the block it would drop onto, and where. */
export interface DragState {
  target: string | null;
  /** The pipeline as the drag shows it; null when not dragging. */
  preview: Pipeline | null;
}

export interface GestureDeps {
  canvas: HTMLElement;
  world: HTMLElement;
  sync: PipelineSync;
  drag: DragState;
  locked: () => boolean;
  getView: () => Viewport;
  setView: (next: Viewport) => void;
  shown: () => Pipeline;
  render: () => void;
  showToast: (message: string, kind?: string) => void;
}

/**
 * The canvas's pointer gestures turned into graph edits: moving a block
 * (dropping a single node onto another block joins it — not mid-run),
 * and dragging a connection from an output pin.
 */
export function attachEditorGestures(deps: GestureDeps) {
  const { sync, drag } = deps;
  return attachCanvasInput({
    canvas: deps.canvas,
    getView: deps.getView,
    setView: deps.setView,
    getPipeline: deps.shown,
    previewMove: (blockId, x, y, target) => {
      drag.target = deps.locked() ? null : target;
      drag.preview = moveBlock(sync.get(), blockId, x, y);
      deps.render();
    },
    finishMove: (blockId, x, y, target) => {
      drag.target = null;
      drag.preview = null;
      const pipeline = sync.get();
      const block = pipeline.blocks.find((b) => b.id === blockId);
      const only = block?.scripts.length === 1 ? block.scripts[0] : undefined;
      if (target && only && !deps.locked())
        sync.apply(joinIntoBlock(pipeline, only, target));
      else sync.apply(moveBlock(pipeline, blockId, x, y), { debounce: true });
      deps.render();
    },
    hitTarget: (point, exclude) => hitBlock(sync.get(), point, exclude),
    previewConnection: (from, to, target) => {
      if (drag.target !== target) {
        drag.target = target;
        deps.render();
      }
      setDraftEdge(deps.world, from, to);
    },
    finishConnection: (fromId, toId) => {
      drag.target = null;
      const rejection = toId ? canConnect(sync.get(), fromId, toId) : null;
      if (toId && !rejection) {
        sync.apply(connect(sync.get(), fromId, toId));
        return;
      }
      deps.render();
      if (rejection) deps.showToast(REJECTIONS[rejection], 'error');
    },
  });
}
