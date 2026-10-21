import type { PreScript, Workflow } from '../domain-types.js';
import { runnableScriptCount } from '../pipeline-graph.js';
import {
  formatPipelineFailure,
  formatScriptCount,
} from '../pipeline-labels.js';
import type { WorkflowRunnerDeps } from '../workflow-runner.js';

/**
 * What the user hears about a workflow run — the error toast, the completion
 * notification and the confirmation a manual run asks for — each naming the
 * workflow. Pure over the injected sinks, so the wording is tested without
 * Electron; `main.ts` only plugs the toast, the banner and the modal in.
 */

type ConfirmableScript = Pick<
  PreScript,
  'name' | 'command' | 'args' | 'confirmSecs' | 'confirmOnTimeout'
>;

export interface WorkflowFeedbackDeps {
  toast: (kind: string, message: string) => void;
  notify: (title: string, body: string) => void;
  /** The confirmation modal, as a manual command's would open. */
  confirm: (script: ConfirmableScript) => Promise<boolean>;
  /**
   * During boot, the startup workflow's failure is reported by the more
   * informative message naming the withheld groups.
   */
  bootReportsStartupFailure: () => boolean;
  /** The failed run's script count, for «Fallaron 2 scripts de 8». */
  totalScripts: (workflowId: string) => number;
}

export type WorkflowFeedback = Required<
  Pick<WorkflowRunnerDeps, 'onError' | 'onSuccess' | 'confirmWorkflow'>
>;

export function workflowFeedback(deps: WorkflowFeedbackDeps): WorkflowFeedback {
  return {
    onError: (workflow, err, { failedScripts }) => {
      if (
        workflow.trigger.kind === 'startup' &&
        deps.bootReportsStartupFailure()
      )
        return;
      const detail =
        failedScripts !== undefined
          ? (formatPipelineFailure(err, deps.totalScripts(workflow.id)) ?? err)
          : err;
      deps.toast('error', `Workflow «${workflow.name}»: ${detail}`);
    },
    onSuccess: (workflow, { scriptCount, warned }) =>
      deps.notify(
        'DevBar — workflows',
        `«${workflow.name}» completado${warned ? ' con avisos' : ''} (${formatScriptCount(scriptCount)})`,
      ),
    confirmWorkflow: (workflow: Workflow) =>
      deps.confirm({
        name: workflow.name,
        command: `Workflow · ${formatScriptCount(runnableScriptCount(workflow.graph))}`,
        args: [],
        confirmSecs: null,
        confirmOnTimeout: 'cancel',
      }),
  };
}
