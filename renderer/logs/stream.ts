/**
 * The logs window's live stream: the snapshot/stream reconciliation every log
 * view shares (`renderer/log-view/stream.ts`) bound to the window's view, its
 * pane and its pause queue. The workflow terminal reconciles its own lines
 * with another instance of the same code.
 */
import { createStream } from '../log-view/stream.js';
import { pushEntry } from './pane.js';
import { queueWhilePaused } from './status.js';
import { view } from './view.js';

const stream = createStream({
  state: view,
  pushEntry,
  queueWhilePaused,
  mergedSources: (groupId) => window.api.getMergedSources(groupId),
});

/** Open a load: take the ticket and start holding what arrives meanwhile. */
export const beginLoad = stream.beginLoad;
/** Close a load: deliver what arrived meanwhile, minus what it carried. */
export const endLoad = stream.endLoad;
/** Await a snapshot; a failed one hands what it held back to the live path. */
export const awaitSnapshot = stream.awaitSnapshot;
/** Held lines belong to the old scope; a scope switch drops them. */
export const dropUnknownSources = stream.dropUnknownSources;
/** A line pushed from main. */
export const receivePush = stream.receivePush;
