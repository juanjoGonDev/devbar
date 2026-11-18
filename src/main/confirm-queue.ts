import crypto from 'node:crypto';
import type { Action, Command, Group, PreScript } from '../domain-types.js';
import type { PrescriptConfirmContext } from '../ipc-contract.js';
import type { RemoteConfirmView } from '../ipc-contract/remote-wire.js';
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
 * may pre-empt. `update` = restarting to install a downloaded update: never
 * cancelled by a pipeline cancel, and kept off a phone (which installs
 * through its own button). `preview` = the dev panel's look at that modal.
 * Prompts that wait with no countdown step aside, unanswered, for the ones
 * that matter more: a preview for anything, an install for any script.
 */
type ConfirmOrigin = 'pipeline' | 'interactive' | 'update' | 'preview';
type YieldingOrigin = 'update' | 'preview';

const yieldsTo = (lower: YieldingOrigin, origin: ConfirmOrigin): boolean =>
  lower === 'preview'
    ? origin !== 'preview'
    : origin === 'pipeline' || origin === 'interactive';

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
  /** When main answers by itself (epoch ms), or null when it never does. */
  deadline: number | null;
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
  now?: () => number;
}

export interface ConfirmQueue {
  /** Opens at once, bypassing the queue: for this module's own tests only.
   *  Every real caller goes through a queued entrypoint. */
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
  /** «Reiniciar e instalar» for a downloaded update; waits for an answer. */
  confirmInstall: (version: string) => Promise<boolean>;
  /** The same modal for the dev panel, which anything real pushes aside. */
  previewInstall: (version: string) => Promise<boolean>;
  /** A script's confirmation outside any pipeline (a workflow run, the dev
   *  panel): queued like every other, never cancelled by a pipeline cancel. */
  confirmInteractive: (
    script: ConfirmableScript,
    groupName: string | null,
  ) => Promise<boolean>;
  cancelConfirm: () => void;
  resolveConfirm: (token: string, decision: ConfirmDecision) => void;
  hasPending: (token: string) => boolean;
  getContext: (token: string) => PrescriptConfirmContext | null;
  /** Every open confirmation, for surfaces other than its modal (a phone). */
  pending: () => RemoteConfirmView[];
  /** Called after a confirmation opens or closes; returns the unsubscribe. */
  onChange: (listener: () => void) => () => void;
}

export function createConfirmQueue(deps: ConfirmQueueDeps): ConfirmQueue {
  const newToken = deps.newToken ?? (() => crypto.randomUUID());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const now = deps.now ?? Date.now;

  const pendingConfirms = new Map<string, PendingConfirm>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
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
  /**
   * Bumped whenever something a waiting prompt yields to arrives (see
   * `yieldsTo`): one still waiting for its turn then steps aside unshown.
   */
  const yieldGeneration: Record<YieldingOrigin, number> = {
    update: 0,
    preview: 0,
  };

  function resolveConfirm(token: string, decision: ConfirmDecision): void {
    const entry = pendingConfirms.get(token);
    if (!entry) return; // no-op guard => double-resolve safe
    pendingConfirms.delete(token); // delete FIRST so a re-entrant close is a no-op
    if (entry.timer) clearTimer(entry.timer);
    if (entry.win && !entry.win.isDestroyed()) entry.win.close();
    entry.resolve(decision === 'confirm');
    changed();
  }

  function openModal(
    context: PrescriptConfirmContext,
    origin: ConfirmOrigin,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const token = newToken();
      const { secs, onTimeout } = context;
      const entry: PendingConfirm = {
        resolve,
        timer: null,
        win: null,
        origin,
        context,
        deadline: secs == null ? null : now() + secs * 1000,
      };
      pendingConfirms.set(token, entry);
      entry.win = deps.openWindow(token);
      changed();
      // AUTHORITATIVE auto-resolve timer lives in MAIN (ADR-1) — the
      // renderer's countdown is purely cosmetic and never resolves on its own.
      if (secs != null)
        entry.timer = setTimer(
          () => resolveConfirm(token, onTimeout),
          secs * 1000,
        );
    });
  }

  function showConfirmModal(
    script: ConfirmableScript,
    origin: ConfirmOrigin,
    groupName: string | null,
  ): Promise<boolean> {
    return openModal(
      {
        name: script.name,
        command: [script.command, ...(script.args || [])].join(' ').trim(),
        secs: script.confirmSecs, // null => no countdown (indefinite)
        onTimeout: script.confirmOnTimeout, // 'confirm' | 'cancel'
        logo: deps.logo(),
        groupName,
      },
      origin,
    );
  }

  /**
   * Shared enqueue mechanics for EVERY origin: always serializes through the
   * SAME chain so only one modal ever shows at a time (ADR-2). Only a
   * `pipeline` job can be pre-empted while still queued; any other job always
   * shows when its turn comes up.
   */
  function enqueue(
    show: () => Promise<boolean>,
    origin: ConfirmOrigin,
  ): Promise<boolean> {
    // An install prompt waits with no countdown, possibly with nobody at the
    // desk: it must not hold a script's confirmation (and its countdown)
    // back. It steps aside unanswered; the update stays ready in About.
    for (const lower of ['update', 'preview'] as const) {
      if (!yieldsTo(lower, origin)) continue;
      yieldGeneration[lower] += 1;
      for (const [token, entry] of pendingConfirms)
        if (entry.origin === lower) resolveConfirm(token, 'cancel');
    }
    const generation = pipelineConfirmGeneration;
    const yielding =
      origin === 'update' || origin === 'preview' ? origin : null;
    const yieldAt = yielding ? yieldGeneration[yielding] : 0;
    const run = (): Promise<boolean> =>
      (origin === 'pipeline' && generation !== pipelineConfirmGeneration) ||
      (yielding !== null && yieldAt !== yieldGeneration[yielding])
        ? Promise.resolve(false)
        : show(); // never rejects
    const result = confirmChain.then(run, run);
    confirmChain = result.then(
      () => undefined,
      () => undefined,
    ); // neutralize so the next job is unaffected
    return result;
  }

  function askToInstall(
    version: string,
    origin: YieldingOrigin,
  ): Promise<boolean> {
    const context: PrescriptConfirmContext = {
      name: `DevBar v${version}`,
      command: '',
      secs: null, // waits for the user, however long it takes
      onTimeout: 'cancel',
      logo: deps.logo(),
      groupName: null,
      title: `DevBar v${version} está lista`,
      detail:
        'Ya está descargada. DevBar se cerrará, se sustituirá por la nueva versión y volverá a abrirse sola.',
      confirmLabel: 'Reiniciar e instalar',
      cancelLabel: 'Ahora no',
      clickToConfirm: true,
    };
    return enqueue(() => openModal(context, origin), origin);
  }

  return {
    showConfirmModal,
    resolveConfirm,
    hasPending: (token) => pendingConfirms.has(token),
    getContext: (token) => pendingConfirms.get(token)?.context ?? null,
    // The logo stays out: it is the desktop modal's data URL, kilobytes a
    // phone has no use for.
    pending: () =>
      [...pendingConfirms]
        .filter(([, { origin }]) => origin !== 'update' && origin !== 'preview')
        .map(([token, { context, deadline }]) => ({
          token,
          name: context.name,
          command: context.command,
          groupName: context.groupName,
          secs: context.secs,
          onTimeout: context.onTimeout,
          deadline,
        })),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

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
      return enqueue(
        () => showConfirmModal(script, 'pipeline', group?.name ?? null),
        'pipeline',
      );
    },

    confirmInstall: (version) => askToInstall(version, 'update'),
    previewInstall: (version) => askToInstall(version, 'preview'),
    confirmInteractive: (script, groupName) =>
      enqueue(
        () => showConfirmModal(script, 'interactive', groupName),
        'interactive',
      ),

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
      const script = {
        name: target.name,
        command: target.command,
        args: target.args,
        confirmSecs: target.confirmSecs,
        confirmOnTimeout: target.confirmOnTimeout,
      };
      return enqueue(
        () => showConfirmModal(script, 'interactive', group?.name ?? null),
        'interactive',
      );
    },
  };
}
