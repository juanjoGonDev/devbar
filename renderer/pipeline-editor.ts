import {
  attachEditorGestures,
  type DragState,
} from './pipeline/editor-gestures.js';
import { buildCanvasControls } from './pipeline/controls.js';
import { attachEditorEvents } from './pipeline/editor-events.js';
import { contentBounds } from './pipeline/geometry.js';
import { renderWorld, type ResolvedScript } from './pipeline/graph-view.js';
import { createMinimap } from './pipeline/minimap.js';
import { buildPaletteList } from './pipeline/palette.js';
import { wirePanelAndZoom } from './pipeline/editor-wiring.js';
import { createPipelinePanel } from './pipeline/panel.js';
import { createPicker } from './pipeline/picker.js';
import {
  createPlacement,
  type CreateScriptRequest,
} from './pipeline/placement.js';
import { runView } from './pipeline/run-view.js';
import { pipelineSummaryText } from './pipeline/summary.js';
import { createPipelineSync } from './pipeline/sync.js';
import { lockedSync } from './pipeline/locked-sync.js';
import { createEditorOverlays } from './pipeline/editor-overlays.js';
import {
  centerOn,
  fitView,
  formatZoom,
  type Viewport,
} from './pipeline/viewport.js';
import { TRIGGER_META } from './workflows/trigger-meta.js';
import {
  pipelineRefKey,
  placedRefKeys,
  runnableBlocks,
} from '../src/pipeline-graph.js';
import type {
  Group,
  Pipeline,
  PreScript,
  PreStepScriptRef,
} from '../src/domain-types.js';
import type { WorkflowEntry, WorkflowRunState } from '../src/ipc-contract.js';

export interface PipelineEditorDeps {
  /** Read-only — the editor never reads `draftGroup` (one-way dependency,
   * unsaved group edits must never leak into the workflow view). */
  getGroups(): readonly Group[];
  showToast(message: string, kind?: string): void;
  /** Opens the existing pre-script edit dialog; "Editar" is offered only
   * when this is wired. */
  editScript?(groupId: string, script: PreScript): void;
  /** Opens the new-pre-script dialog; "Nuevo pre-script" is offered only
   * when this is wired. */
  createScript?(request: CreateScriptRequest): void;
  /** How long a dragged block waits before its position is written. */
  moveDebounceMs?: number;
  /** The section's workflow list (who holds the startup slot, last runs). */
  getEntries?(): readonly WorkflowEntry[];
  /** «Workflows» in the breadcrumb: back to the list. */
  onBack?(): void;
  now?: () => number;
}

export interface PipelineEditorHandle {
  refresh(): Promise<void>;
  /** Edits workflow `id`; `rename` puts the cursor in its name. */
  open(workflowId: string, options?: { rename?: boolean }): Promise<void>;
  /** The workflow being edited, null until one is read. */
  workflowId(): string | null;
  /** The latest run of the workflow on screen (or null: none yet). */
  setRun(state: WorkflowRunState | null): void;
  /** The list changed: adopt the workflow's new name/trigger, repaint. */
  entriesChanged(): void;
}

/** How far a "+" stub reaches right of its output pin. */
const STUB_REACH = 40;
/** Room the breadcrumb pill takes above the panel and the graph. */
const CRUMB_HEIGHT = 46;

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

/**
 * The visual workflow editor: a canvas that fills the whole section, where
 * every pre-script is a node at its own 2D position and an edge means "wait
 * for". A dashed frame runs its scripts in parallel; several edges out of one
 * node run their branches in parallel too. The workflow's latest run is
 * painted over it, live.
 *
 * Every edit is computed by the pure `src/pipeline-graph.ts`, painted at once
 * and persisted through `pipeline/sync.ts`. Dragging a block only previews it
 * (`preview`) until the drop. While a run is in flight only layout edits go
 * through.
 */
export function initPipelineEditor(
  host: HTMLElement,
  deps: PipelineEditorDeps,
): PipelineEditorHandle {
  let view: Viewport = { x: 0, y: 0, zoom: 1 };
  let selectedKey: string | null = null;
  const drag: DragState = { target: null, preview: null };
  let query = '';
  let minimapOn = true;
  let fitted = false;
  let run: WorkflowRunState | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  const now = deps.now ?? (() => Date.now());
  const entries = (): readonly WorkflowEntry[] => deps.getEntries?.() ?? [];

  const store = createPipelineSync({
    onChange: () => render(),
    showToast: (message, kind) => deps.showToast(message, kind),
    debounceMs: deps.moveDebounceMs ?? 400,
  });
  const locked = (): boolean => run?.status === 'running';
  const sync = lockedSync(store, locked, () => {
    deps.showToast('No disponible durante la ejecución', 'error');
    render();
  });
  const shown = (): Pipeline => drag.preview ?? sync.get();
  const entry = (): WorkflowEntry | null =>
    entries().find((e) => e.workflow.id === sync.workflow()?.id) ?? null;
  const triggerKind = () => sync.workflow()?.trigger.kind ?? 'startup';

  // ── Skeleton, built once so the search box keeps its focus ─────────────
  const root = div('pipeline-editor');
  const canvas = div('pipeline-canvas');
  canvas.setAttribute('aria-label', 'Lienzo del workflow');
  const world = div('pipeline-world');
  canvas.appendChild(world);
  const panel = createPipelinePanel({
    canCreate: deps.createScript !== undefined,
    onLayoutChange: () => {
      paintMinimap();
      paintChrome();
    },
  });
  const controls = buildCanvasControls();
  const minimap = createMinimap((point) =>
    setView(centerOn(view, point, canvasSize())),
  );
  const overlays = createEditorOverlays({
    root,
    world,
    sync,
    entries,
    run: () => run,
    nameOf: (ref) => findScript(ref)?.script.name ?? 'Referencia rota',
    now,
    showToast: (message, kind) => deps.showToast(message, kind),
    onBack: () => deps.onBack?.(),
    togglePanel: () => panel.toggle(),
    repaint: () => render(),
    fallbackAnchor: () => ({ x: view.x, y: view.y + CRUMB_HEIGHT }),
  });
  const { chrome, drawer, popover } = overlays;
  root.append(
    canvas,
    chrome.breadcrumb,
    panel.panel,
    chrome.status,
    chrome.legend,
    minimap.element,
    controls.zoom,
  );
  host.replaceChildren(root);
  const picker = createPicker(root);

  // ── Lookups ────────────────────────────────────────────────────────────
  function findScript(ref: PreStepScriptRef): ResolvedScript | null {
    const group = deps.getGroups().find((g) => g.id === ref.groupId);
    const script = group?.preScripts.find((s) => s.id === ref.scriptId);
    return group && script ? { group, script } : null;
  }

  /** False only once every existing pre-script is already placed. */
  function canAdd(): boolean {
    const placed = placedRefKeys(sync.get());
    const all = deps
      .getGroups()
      .flatMap((g) =>
        g.preScripts.map((s) => ({ groupId: g.id, scriptId: s.id })),
      );
    return (
      all.length === 0 || all.some((ref) => !placed.has(pipelineRefKey(ref)))
    );
  }

  function canvasSize(): { width: number; height: number } {
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  // ── Painting ───────────────────────────────────────────────────────────
  function paintMinimap(): void {
    minimap.element.hidden = !minimapOn;
    controls.minimap.setAttribute('aria-pressed', String(minimapOn));
    if (minimapOn)
      minimap.render({
        pipeline: shown(),
        view,
        canvas: canvasSize(),
        selectedKey,
      });
  }

  function paintChrome(): void {
    chrome.paint({
      workflow: sync.workflow(),
      entry: entry(),
      run,
      summary: pipelineSummaryText(sync.get()),
      panelOpen: panel.isOpen(),
      now: now(),
    });
  }

  function applyView(): void {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const grid = 20 * view.zoom;
    canvas.style.backgroundSize = `${grid}px ${grid}px`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    controls.zoomValue.textContent = formatZoom(view.zoom);
    paintMinimap();
  }

  function setView(next: Viewport): void {
    if (next === view) return;
    view = next;
    picker.close();
    popover.close();
    applyView();
    render();
  }

  function renderPalette(): void {
    panel.list.replaceChildren(
      buildPaletteList(deps.getGroups(), placedRefKeys(sync.get()), query),
    );
  }

  function focusNode(key: string): void {
    Array.from(world.querySelectorAll<HTMLElement>('.pipeline-node'))
      .find((candidate) => candidate.dataset.ref === key)
      ?.focus({ preventScroll: true });
  }

  function render(): void {
    const active = document.activeElement;
    const focusRef =
      active instanceof HTMLElement && world.contains(active)
        ? active.closest<HTMLElement>('.pipeline-node')?.dataset.ref
        : undefined;
    const pipeline = shown();
    const kind = triggerKind();
    renderWorld(world, {
      pipeline,
      resolve: findScript,
      runnable: new Set(runnableBlocks(pipeline)),
      selectedKey,
      dropTarget: drag.target,
      canAdd: canAdd(),
      canEdit: deps.editScript !== undefined,
      trigger: {
        kind,
        label: TRIGGER_META[kind].node,
        icon: TRIGGER_META[kind].icon,
      },
      run: runView(run, now()),
      locked: locked(),
    });
    root.classList.toggle('is-locked', locked());
    root.classList.toggle('has-run', run !== null);
    world
      .querySelector('.pipeline-trigger')
      ?.setAttribute('aria-expanded', String(popover.isOpen()));
    renderPalette();
    paintChrome();
    popover.refresh();
    drawer.update();
    paintMinimap();
    if (focusRef) focusNode(focusRef);
  }

  /** Fits the whole graph in the part of the canvas the chrome leaves free. */
  function fit(): boolean {
    const size = canvasSize();
    const covered = panel.coveredWidth();
    const bounds = contentBounds(sync.get());
    // Room for the "+" stubs that stick out of the rightmost outputs.
    bounds.width += STUB_REACH;
    const next = fitView(bounds, {
      x: covered,
      y: CRUMB_HEIGHT,
      width: size.width - covered,
      height: size.height - CRUMB_HEIGHT,
    });
    if (next) setView(next);
    return next !== null;
  }

  /** First open: fit as soon as the canvas has both a size and a graph. */
  function fitOnce(): void {
    if (!fitted && sync.loaded()) fitted = fit();
  }

  async function refresh(): Promise<void> {
    await sync.refresh();
    if (selectedKey && !placedRefKeys(sync.get()).has(selectedKey))
      selectedKey = null;
    render();
    fitOnce();
  }

  function tick(): void {
    const running = run?.status === 'running';
    if (running && ticker === null) ticker = setInterval(render, 1000);
    if (!running && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  const placement = createPlacement({
    root,
    sync,
    picker,
    getGroups: () => deps.getGroups(),
    resolve: findScript,
    getView: () => view,
    canvasSize,
    coveredWidth: () => panel.coveredWidth(),
    selectQuietly: (key) => {
      selectedKey = key;
    },
    showToast: (message, kind) => deps.showToast(message, kind),
    createScript: deps.createScript
      ? (request) => deps.createScript?.(request)
      : undefined,
    triggerName: () => TRIGGER_META[triggerKind()].node,
  });

  // ── Gestures ───────────────────────────────────────────────────────────
  const input = attachEditorGestures({
    canvas,
    world,
    sync,
    drag,
    locked,
    getView: () => view,
    setView,
    shown,
    render,
    showToast: (message, kind) => deps.showToast(message, kind),
  });

  attachEditorEvents({
    root,
    canvas,
    sync,
    consumeDragClick: () => input.consumeDragClick(),
    getSelected: () => selectedKey,
    select: (key) => {
      selectedKey = key;
      render();
      if (key) focusNode(key);
    },
    editScript: (ref) => {
      const resolved = findScript(ref);
      if (resolved) deps.editScript?.(resolved.group.id, resolved.script);
    },
    openPicker: (stub) => placement.openPicker(stub),
    openTrigger: () => overlays.toggleTrigger(),
    onAction: (action, button) => overlays.onAction(action, button),
  });

  wirePanelAndZoom({
    panel,
    canvas,
    controls,
    picker,
    placement,
    sync,
    getView: () => view,
    setView,
    canvasSize,
    fit,
    onQuery: (next) => {
      query = next;
      renderPalette();
    },
    toggleMinimap: () => {
      minimapOn = !minimapOn;
      paintMinimap();
    },
  });

  // The section starts hidden: fit once it first gets a size, and keep the
  // minimap's view rectangle in step with the window.
  if (typeof ResizeObserver === 'function')
    // Next frame: repainting inside the callback can resize observed boxes and
    // trip the "ResizeObserver loop" error.
    new ResizeObserver(() =>
      requestAnimationFrame(() => {
        fitOnce();
        paintMinimap();
      }),
    ).observe(canvas);

  applyView();
  // The toolbar exists from the start; the graph fills in on `refresh`.
  render();

  return {
    refresh,
    open: async (workflowId, options = {}) => {
      const switching = sync.workflow()?.id !== workflowId;
      sync.target(workflowId);
      if (switching) {
        selectedKey = null;
        fitted = false;
        run = null;
        popover.close();
        drawer.close();
        tick();
      }
      render();
      await refresh();
      if (options.rename) chrome.focusName();
    },
    workflowId: () => sync.workflow()?.id ?? null,
    setRun: (state) => {
      run = state;
      tick();
      render();
    },
    entriesChanged: () => {
      const mine = entry();
      if (mine) sync.adopt(mine.workflow);
      render();
    },
  };
}
