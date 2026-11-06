import type { ImportPayload } from '../../src/config-io.js';
import type { Pipeline } from '../../src/domain-types.js';

/**
 * A backup from before workflows imports its one pipeline as the startup
 * workflow: these read that workflow back the way the old payload exposed
 * its `pipeline` and `globalSettings.preScriptsAutoRun`.
 */

export function importedGraph(payload: ImportPayload): Pipeline {
  return (
    payload.workflows.find((w) => w.trigger.kind === 'startup')?.graph ?? {
      blocks: [],
      edges: [],
    }
  );
}

export function importedAutoRun(payload: ImportPayload): boolean | undefined {
  return payload.workflows.find((w) => w.trigger.kind === 'startup')?.enabled;
}
