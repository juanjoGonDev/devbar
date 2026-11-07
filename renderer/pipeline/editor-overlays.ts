import { createRunActions } from './run-actions.js';
import type { PipelineSync } from './sync.js';
import { createEditorChrome } from '../workflows/editor-chrome.js';
import { createLogDrawer } from '../workflows/log-drawer.js';
import { createTriggerPopover } from '../workflows/trigger-popover.js';
import type { PreStepScriptRef } from '../../src/domain-types.js';
import type {
  WorkflowEntry,
  WorkflowRunState,
} from '../../src/ipc-contract.js';

/**
 * What floats over the editor's canvas besides its own panels: the
 * breadcrumb, the run status and legend (`editor-chrome`), the trigger's
 * popover, the log drawer, and the run actions they and the toolbars share.
 */

export interface OverlaysDeps {
  root: HTMLElement;
  world: HTMLElement;
  sync: PipelineSync;
  entries: () => readonly WorkflowEntry[];
  run: () => WorkflowRunState | null;
  nameOf: (ref: PreStepScriptRef) => string;
  now: () => number;
  showToast: (message: string, kind?: string) => void;
  onBack: () => void;
  togglePanel: () => void;
  repaint: () => void;
  /** Where the popover goes when nothing is laid out (jsdom). */
  fallbackAnchor(): { x: number; y: number };
}

export function createEditorOverlays(deps: OverlaysDeps) {
  const { sync } = deps;
  const workflowId = (): string | null => sync.workflow()?.id ?? null;
  const actions = createRunActions({ workflowId, showToast: deps.showToast });
  const chrome = createEditorChrome({
    onBack: deps.onBack,
    onRename: (name) => void sync.setMeta({ name }),
    onTogglePanel: deps.togglePanel,
    onRun: () => actions.run(),
    onStop: () => actions.stop(),
  });
  const drawer = createLogDrawer({
    host: deps.root,
    workflowId,
    run: deps.run,
    pipeline: () => sync.get(),
    nameOf: deps.nameOf,
    now: deps.now,
    onToggle: (open) => deps.root.classList.toggle('has-log', open),
  });
  const trigger = (): HTMLElement | null =>
    deps.world.querySelector<HTMLElement>('.pipeline-trigger');

  async function takeStartup(): Promise<void> {
    const id = workflowId();
    if (!id) return;
    try {
      const changed = await window.api.makeStartupWorkflow(id);
      const mine = changed.find((w) => w.id === id);
      if (mine) sync.adopt(mine);
      deps.repaint();
    } catch {
      deps.showToast('No se pudo cambiar el desencadenante', 'error');
    }
  }

  const popover = createTriggerPopover({
    host: deps.root,
    workflow: () => sync.workflow(),
    entries: deps.entries,
    save: (patch) => void sync.setMeta(patch),
    takeStartup: () => void takeStartup(),
    now: deps.now,
    anchor: trigger,
  });

  return {
    chrome,
    drawer,
    popover,
    /** The trigger node toggles its popover, opened just under it. */
    toggleTrigger: (): void => {
      if (popover.isOpen()) {
        popover.close();
        return;
      }
      const rect = trigger()?.getBoundingClientRect();
      const origin = deps.root.getBoundingClientRect();
      popover.open(
        rect && rect.width > 0
          ? { x: rect.left - origin.left, y: rect.bottom - origin.top + 10 }
          : deps.fallbackAnchor(),
      );
      deps.repaint();
    },
    onAction: (action: string, button: HTMLElement): void =>
      actions.handle(action, button, {
        sync,
        openLog: (key) => drawer.open(key),
      }),
  };
}
