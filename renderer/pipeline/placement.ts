import { NODE_HEIGHT, NODE_WIDTH, freeSpot, rectOf } from './geometry.js';
import { blockName, type ResolvedScript } from './graph-view.js';
import { toScreen, toWorld, type Point, type Viewport } from './viewport.js';
import {
  PIPELINE_GRID,
  PIPELINE_TRIGGER,
  addBlock,
  pipelineRefKey,
  placedRefKeys,
} from '../../src/pipeline-graph.js';
import type {
  Group,
  PreScript,
  PreStepScriptRef,
} from '../../src/domain-types.js';
import type { Picker } from './picker.js';
import type { PipelineSync } from './sync.js';

/** What the editor asks the config window to create a pre-script with. */
export interface CreateScriptRequest {
  groups: readonly Group[];
  groupId: string;
  /** The node the new script will follow, or null for a free placement. */
  after: string | null;
  onCreated: (groupId: string, script: PreScript) => void | Promise<void>;
}

export interface PlacementDeps {
  root: HTMLElement;
  sync: PipelineSync;
  picker: Picker;
  getGroups(): readonly Group[];
  resolve: (ref: PreStepScriptRef) => ResolvedScript | null;
  getView(): Viewport;
  canvasSize(): { width: number; height: number };
  /** Screen pixels the floating panel covers on the canvas's left. */
  coveredWidth(): number;
  /** Selects the script just placed (no repaint: the edit repaints). */
  selectQuietly(key: string): void;
  showToast(message: string, kind?: string): void;
  createScript: ((request: CreateScriptRequest) => void) | undefined;
  /** What the trigger node is called («Al iniciar», «Manual»…). */
  triggerName(): string;
}

export interface Placement {
  /** A new block wired after `fromId` (a block or the trigger). */
  placeAfter(ref: PreStepScriptRef, fromId: string): void;
  /** A new disconnected block centred on `at` (world), or in view. */
  placeFree(ref: PreStepScriptRef, at: Point | null): void;
  /** Opens the new-pre-script dialog for after `fromId`, or free. */
  createScript(fromId: string | null): void;
  /** Opens the "+" picker of a stub. */
  openPicker(stub: HTMLElement): void;
}

/** Where new scripts land on the canvas, however they arrive. */
export function createPlacement(deps: PlacementDeps): Placement {
  const { sync } = deps;

  function placeAfter(ref: PreStepScriptRef, fromId: string): void {
    const pipeline = sync.get();
    const rect = rectOf(pipeline, fromId);
    if (!rect) return;
    const spot = freeSpot(pipeline, rect.x + PIPELINE_GRID.columnGap, rect.y);
    deps.selectQuietly(pipelineRefKey(ref));
    sync.apply(addBlock(pipeline, ref, { from: fromId, x: spot.x, y: spot.y }));
  }

  function placeFree(ref: PreStepScriptRef, at: Point | null): void {
    const pipeline = sync.get();
    // An empty pipeline has nothing to keep apart from: start the chain.
    if (pipeline.blocks.length === 0 && at === null) {
      placeAfter(ref, PIPELINE_TRIGGER);
      return;
    }
    const size = deps.canvasSize();
    const center =
      at ??
      toWorld(
        deps.getView(),
        (deps.coveredWidth() + size.width) / 2,
        size.height / 2,
      );
    const spot = freeSpot(
      pipeline,
      Math.round(center.x - NODE_WIDTH / 2),
      Math.round(center.y - NODE_HEIGHT / 2),
    );
    deps.selectQuietly(pipelineRefKey(ref));
    sync.apply(addBlock(pipeline, ref, { x: spot.x, y: spot.y }));
  }

  function nameOf(id: string): string {
    if (id === PIPELINE_TRIGGER) return deps.triggerName();
    const block = sync.get().blocks.find((b) => b.id === id);
    return block ? blockName(block, deps.resolve) : '';
  }

  function createScript(fromId: string | null): void {
    if (!deps.createScript) return;
    const groups = deps.getGroups();
    const fromBlock = sync.get().blocks.find((b) => b.id === fromId);
    const groupId = fromBlock?.scripts[0]?.groupId ?? groups[0]?.id;
    if (!groupId) {
      deps.showToast(
        'Crea primero un grupo para guardar el pre-script',
        'error',
      );
      return;
    }
    deps.createScript({
      groups,
      groupId,
      after: fromId === null ? null : nameOf(fromId),
      onCreated: (savedGroupId, script) => {
        const ref = { groupId: savedGroupId, scriptId: script.id };
        if (fromId !== null && rectOf(sync.get(), fromId))
          placeAfter(ref, fromId);
        else placeFree(ref, null);
      },
    });
  }

  function openPicker(stub: HTMLElement): void {
    const fromId = stub.dataset.block;
    if (!fromId || stub.getAttribute('aria-disabled') === 'true') return;
    const box = deps.root.getBoundingClientRect();
    const anchor = stub.getBoundingClientRect();
    const rect = rectOf(sync.get(), fromId);
    // jsdom lays nothing out: fall back to the model's own geometry.
    const at =
      anchor.width > 0
        ? { x: anchor.left - box.left, y: anchor.bottom - box.top + 6 }
        : rect
          ? toScreen(deps.getView(), {
              x: rect.x + rect.width,
              y: rect.y + rect.height,
            })
          : { x: 0, y: 0 };
    stub.setAttribute('aria-expanded', 'true');
    deps.picker.open({
      at,
      groups: deps.getGroups().filter((g) => g.preScripts.length > 0),
      placed: placedRefKeys(sync.get()),
      onPick: (ref) => placeAfter(ref, fromId),
      onCreate: deps.createScript ? () => createScript(fromId) : null,
      onClose: () => {
        stub.setAttribute('aria-expanded', 'false');
        if (stub.isConnected) stub.focus({ preventScroll: true });
      },
    });
  }

  return { placeAfter, placeFree, createScript, openPicker };
}
