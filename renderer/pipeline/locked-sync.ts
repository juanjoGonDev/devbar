import { isLayoutOnly } from './frame-ops.js';
import type { PipelineSync } from './sync.js';

/**
 * The sync every gesture writes through while a run may be in flight: then
 * only layout edits (moving blocks around) go through, and anything that
 * would change what runs is refused with `refuse`.
 */
export function lockedSync(
  store: PipelineSync,
  isLocked: () => boolean,
  refuse: () => void,
): PipelineSync {
  return {
    ...store,
    apply: (next, options) => {
      if (isLocked() && !isLayoutOnly(store.get(), next)) {
        refuse();
        return;
      }
      store.apply(next, options);
    },
  };
}
