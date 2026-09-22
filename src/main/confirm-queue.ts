import crypto from 'node:crypto';
import type { Action, Command, Group, PreScript } from '../domain-types.js';
import type { PrescriptConfirmContext } from '../ipc-contract.js';
import type { ConfirmDecision } from './ipc-validators.js';

/**
 * The confirmation gate's whole state machine: the token → pending map, the
 * AUTHORITATIVE auto-resolve timer (ADR-1) and the global serial modal queue
 * (ADR-2). The BrowserWindow is injected, so this is the only place with
 * mutable confirm state and the only place that has to be reasoned about when
 * a cancel races a queued job.
 */

/** The minimum a confirm modal window has to offer. */
export interface ConfirmWindowLike {
  isDestroyed: () => boolean;
  close: () => void;
}

/**
 * `pipeline` = the global pre-script pipeline, cancellable in bulk via
 * `cancelConfirm`. `interactive` = a manual/scheduled command or action
 * confirmation (`confirmIfNeeded`). Both origins share the SAME serial modal
 * queue (ADR-2) and the SAME pending map — origin only decides which entries
 * `cancelConfirm` may resolve, and which queued jobs the generation counter
 * may pre-empt.
 */
type ConfirmOrigin = 'pipeline' | 'interactive';

/** The fields a confirmable target contributes to the modal. */
type ConfirmableScript = Pick<
  PreScript,
  'name' | 'command' | 'args' | 'confirmSecs' | 'confirmOnTimeout'
>;

interface PendingConfirm {
  resolve: (confirmed: boolean) => void;
  timer: NodeJS.Timeout | null;
  win: ConfirmWindowLike | null;
  context: PrescriptConfirmContext;
  origin: ConfirmOrigin;
}

export interface ConfirmQueueDeps {
  /** Opens the modal for `token`; called AFTER the entry is registered so the
   *  renderer's `getContext` round-trip can already find it. */
  openWindow: (token: string) => ConfirmWindowLike;
  /** Data-URL logo for the modal; '' degrades gracefully (hides the <img>). */
  logo: () => string;
  newToken?: () => string;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export interface ConfirmQueue {
  showConfirmModal: (
    script: ConfirmableScript,
    origin: ConfirmOrigin,
    groupName: string | null,
  ) => Promise<boolean>;
  confirmScript: (
    script: ConfirmableScript,
    group: Group | null,
  ) => Promise<boolean>;
  confirmIfNeeded: (
    target: Command | Action | null | undefined,
    group: Group | null,
  ) => Promise<boolean>;
  cancelConfirm: () => void;
  resolveConfirm: (token: string, decision: ConfirmDecision) => void;
  hasPending: (token: string) => boolean;
  getContext: (token: string) => PrescriptConfirmContext | null;
}

export function createConfirmQueue(deps: ConfirmQueueDeps): ConfirmQueue {
  const newToken = deps.newToken ?? (() => crypto.randomUUID());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));

  const pendingConfirms = new Map<string, PendingConfirm>();
  let confirmChain: Promise<void> = Promise.resolve();
  /**
   * Bumped only by a pipeline cancel, so a PIPELINE job still queued behind
   * `confirmChain` declines instead of showing. An interactive confirmation
   * never consults this counter — the pipeline and an unrelated interactive
   * confirmation happened to share one queue and one counter before, so
   * cancelling the pipeline could silently cancel a manual command's
   * confirmation too.
   */
  let pipelineConfirmGeneration = 0;

  function resolveConfirm(token: string, decision: ConfirmDecision): void {
    const entry = pendingConfirms.get(token);
    if (!entry) return; // no-op guard => double-resolve safe
    pendingConfirms.delete(token); // delete FIRST so a re-entrant close is a no-op
    if (entry.timer) clearTimer(entry.timer);
    if (entry.win && !entry.win.isDestroyed()) entry.win.close();
    entry.resolve(decision === 'confirm');
  }

  function showConfirmModal(
    script: ConfirmableScript,
    origin: ConfirmOrigin,
    groupName: string | null,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const token = newToken();
      const entry: PendingConfirm = {
        resolve,
        timer: null,
        win: null,
        origin,
        context: {
          name: script.name,
          command: [script.command, ...(script.args || [])].join(' ').trim(),
          secs: script.confirmSecs, // null => no countdown (indefinite)
          onTimeout: script.confirmOnTimeout, // 'confirm' | 'cancel'
          logo: deps.logo(),
          groupName,
        },
      };
      pendingConfirms.set(token, entry);
      entry.win = deps.openWindow(token);
      // AUTHORITATIVE auto-resolve timer lives in MAIN (ADR-1) — the
      // renderer's countdown is purely cosmetic and never resolves on its own.
      if (script.confirmSecs != null) {
        entry.timer = setTimer(
          () => resolveConfirm(token, script.confirmOnTimeout),
          script.confirmSecs * 1000,
        );
      }
    });
  }

  /**
   * Shared enqueue mechanics for BOTH origins: always serializes through the
   * SAME chain so only one modal ever shows at a time (ADR-2). Only a
   * `pipeline` job can be pre-empted while still queued; an `interactive` job
   * always shows when its turn comes up.
   */
  function enqueueConfirm(
    script: ConfirmableScript,
    origin: ConfirmOrigin,
    groupName: string | null,
  ): Promise<boolean> {
    const generation = pipelineConfirmGeneration;
    const run = (): Promise<boolean> =>
      origin === 'pipeline' && generation !== pipelineConfirmGeneration
        ? Promise.resolve(false)
        : showConfirmModal(script, origin, groupName); // never rejects
    const result = confirmChain.then(run, run);
    confirmChain = result.then(
      () => undefined,
      () => undefined,
    ); // neutralize so the next job is unaffected
    return result;
  }

  return {
    showConfirmModal,
    resolveConfirm,
    hasPending: (token) => pendingConfirms.has(token),
    getContext: (token) => pendingConfirms.get(token)?.context ?? null,

    /**
     * Cancels every pending PIPELINE confirmation — the pipeline is global, so
     * a cancel is never scoped to one group. Never touches an `interactive`
     * entry: a manual/scheduled confirmation shares the same queue but has
     * nothing to do with a pipeline cancel and must keep waiting unaffected.
     */
    cancelConfirm(): void {
      // Bump FIRST: a pipeline job still queued behind the chain is not in the
      // pending map yet, so without this it would open its modal after the user
      // already cancelled and leave the runner's Promise.all pending.
      pipelineConfirmGeneration += 1;
      for (const [token, entry] of pendingConfirms) {
        if (entry.origin === 'pipeline') resolveConfirm(token, 'cancel');
      }
    },

    /** Injected into the pre-script runner. */
    confirmScript(script, group) {
      return enqueueConfirm(script, 'pipeline', group?.name ?? null);
    },

    /**
     * Gate a command/action start behind its optional confirmation modal.
     * Returns true to proceed, false if the user (or the timeout default)
     * declined. For scheduled runs with nobody watching, confirmOnTimeout
     * decides after the countdown.
     */
    confirmIfNeeded(target, group) {
      if (!target || !target.confirm) return Promise.resolve(true);
      // origin 'interactive': a manual/scheduled confirmation must never be
      // cancelled or pre-empted by an unrelated pipeline cancel.
      return enqueueConfirm(
        {
          name: target.name,
          command: target.command,
          args: target.args,
          confirmSecs: target.confirmSecs,
          confirmOnTimeout: target.confirmOnTimeout,
        },
        'interactive',
        group?.name ?? null,
      );
    },
  };
}
