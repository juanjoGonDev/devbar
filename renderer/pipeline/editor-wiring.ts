import { attachPaletteDrop } from './palette-drop.js';
import { spreadColumns } from './geometry.js';
import { stepZoom, toWorld, type Viewport } from './viewport.js';
import { autoLayout, joinIntoBlock } from '../../src/pipeline-graph.js';
import type { CanvasControls } from './controls.js';
import type { PipelinePanel } from './panel.js';
import type { Picker } from './picker.js';
import type { Placement } from './placement.js';
import type { PipelineSync } from './sync.js';

/**
 * The editor's static wiring, attached once: the pre-scripts panel (search,
 * «Nuevo pre-script», chips dragged onto the canvas) and the zoom cluster.
 */

export interface WiringDeps {
  panel: PipelinePanel;
  canvas: HTMLElement;
  controls: CanvasControls;
  picker: Picker;
  placement: Placement;
  sync: PipelineSync;
  getView: () => Viewport;
  setView: (next: Viewport) => void;
  canvasSize: () => { width: number; height: number };
  fit: () => boolean;
  onQuery: (query: string) => void;
  toggleMinimap: () => void;
}

export function wirePanelAndZoom(deps: WiringDeps): void {
  const { panel, controls, sync, placement } = deps;
  panel.search.addEventListener('input', () =>
    deps.onQuery(panel.search.value),
  );
  panel.newButton?.addEventListener('click', () =>
    placement.createScript(null),
  );

  attachPaletteDrop({
    panel: panel.panel,
    canvas: deps.canvas,
    toWorld: (clientX, clientY) => {
      const box = deps.canvas.getBoundingClientRect();
      return toWorld(deps.getView(), clientX - box.left, clientY - box.top);
    },
    onDragStart: () => deps.picker.close(),
    onDrop: (key, drop) => {
      const [groupId = '', scriptId = ''] = key.split('::');
      if (!groupId || !scriptId) return;
      const ref = { groupId, scriptId };
      if (drop.kind === 'join')
        sync.apply(joinIntoBlock(sync.get(), ref, drop.blockId));
      else if (drop.kind === 'after') placement.placeAfter(ref, drop.fromId);
      else placement.placeFree(ref, drop.at);
    },
  });

  const zoomAround = (direction: -1 | 1): void => {
    const size = deps.canvasSize();
    deps.setView(
      stepZoom(deps.getView(), direction, size.width / 2, size.height / 2),
    );
  };
  controls.zoomOut.addEventListener('click', () => zoomAround(-1));
  controls.zoomIn.addEventListener('click', () => zoomAround(1));
  controls.fit.addEventListener('click', () => void deps.fit());
  controls.arrange.addEventListener('click', () => {
    sync.apply(spreadColumns(autoLayout(sync.get())));
    deps.fit();
  });
  controls.minimap.addEventListener('click', () => deps.toggleMinimap());
}
