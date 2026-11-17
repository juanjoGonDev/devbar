import { errorMessage } from './ipc-validators.js';
import type {
  ApplyUpdateResult,
  AssistedUpdateDeps,
} from './assisted-update.js';
import type { PhaseStore } from './update-phase.js';
import type { StagedUpdate } from '../domain-types.js';

/**
 * Installing an update that is already downloaded and unpacked: confirm →
 * hand the swap to a detached process → quit. The user never touches the
 * Finder/Explorer; only the confirmation is asked of them, once — and not
 * even that when the request comes from a surface that cannot show a dialog
 * (a phone through «Control remoto»), where the tap WAS the confirmation.
 */

export interface InstallStagedDeps extends Pick<
  AssistedUpdateDeps,
  'toast' | 'markUpdateExit' | 'quitAfter'
> {
  /**
   * The «Reiniciar e instalar» modal: DevBar's own window, on top of
   * everything on every platform (a native dialog can open behind other
   * windows on some Linux window managers). Resolves the user's answer.
   */
  confirmInstall: (version: string) => Promise<boolean>;
  pid: number;
  updatesDir: () => string;
  spawnSwap: (input: {
    staged: StagedUpdate;
    target: string;
    scriptDir: string;
    pid: number;
  }) => void;
}

async function confirmed(
  deps: InstallStagedDeps,
  staged: StagedUpdate,
): Promise<ApplyUpdateResult | null> {
  try {
    return (await deps.confirmInstall(staged.version))
      ? null
      : { ok: false, cancelled: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function installStagedUpdate(
  deps: InstallStagedDeps,
  phase: PhaseStore,
  staged: StagedUpdate,
  target: string,
  { ask }: { ask: boolean },
): Promise<ApplyUpdateResult> {
  if (ask) {
    const refusal = await confirmed(deps, staged);
    if (refusal) return refusal;
  }
  try {
    deps.spawnSwap({
      staged,
      target,
      scriptDir: deps.updatesDir(),
      pid: deps.pid,
    });
  } catch (err) {
    phase.set({
      state: 'install-failed',
      version: staged.version,
      reason: errorMessage(err),
      path: staged.appPath,
      command: null,
    });
    deps.toast('error', `No se pudo instalar: ${errorMessage(err)}`);
    return { ok: false, error: errorMessage(err) };
  }
  phase.set({ state: 'restarting', version: staged.version });
  // The script polls for our exit, so a short delay is enough to let this
  // reply (IPC or HTTP) reach its caller before we go.
  deps.markUpdateExit();
  deps.quitAfter(200);
  return { ok: true, quitting: true, inPlace: true };
}
