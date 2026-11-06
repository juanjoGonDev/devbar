import { ungroup } from './frame-ops.js';
import { reasonOf, runErrorText } from '../workflows/trigger-meta.js';
import { pipelineRefKey, setRequireAll } from '../../src/pipeline-graph.js';
import type { PipelineSync } from './sync.js';

/**
 * The editor's run controls and the toolbar actions that are not plain
 * graph edits: ▶/■ from the status pill, a node's «Ver log» and
 * «Reintentar», and a frame's «Todos OK», «Deshacer grupo» and «Ver logs».
 */

export interface RunActionsDeps {
  workflowId: () => string | null;
  showToast: (message: string, kind?: string) => void;
}

interface ActionContext {
  sync: PipelineSync;
  /** Opens the log drawer on a script (by ref key). */
  openLog: (key: string | null) => void;
}

export interface RunActions {
  run(): void;
  stop(): void;
  /** One toolbar `data-action`, with the button that carries its target. */
  handle(action: string, button: HTMLElement, context: ActionContext): void;
}

export function createRunActions(deps: RunActionsDeps): RunActions {
  async function outcome(
    call: Promise<{ ok: boolean; error?: string | undefined }>,
  ): Promise<void> {
    try {
      const result = await call;
      const text = result.ok ? null : runErrorText(result.error);
      if (text) deps.showToast(text, 'error');
    } catch (error) {
      deps.showToast(reasonOf(error), 'error');
    }
  }

  function withId(use: (id: string) => void): void {
    const id = deps.workflowId();
    if (id) use(id);
  }

  return {
    run: () => withId((id) => void outcome(window.api.runWorkflow(id))),
    stop: () => withId((id) => void window.api.stopWorkflow(id)),
    handle: (action, button, { sync, openLog }) => {
      const blockId = button.dataset.block ?? '';
      const block = sync.get().blocks.find((b) => b.id === blockId);
      if (action === 'log') openLog(button.dataset.ref ?? null);
      else if (action === 'retry') {
        const owner = sync
          .get()
          .blocks.find((b) =>
            b.scripts.some((ref) => pipelineRefKey(ref) === button.dataset.ref),
          );
        if (owner)
          withId(
            (id) => void outcome(window.api.retryWorkflowFrom(id, owner.id)),
          );
      } else if (action === 'require-all' && block)
        sync.apply(setRequireAll(sync.get(), block.id, !block.requireAll));
      else if (action === 'ungroup' && block)
        sync.apply(ungroup(sync.get(), block.id));
      else if (action === 'frame-logs' && block)
        openLog(block.scripts[0] ? pipelineRefKey(block.scripts[0]) : null);
    },
  };
}
