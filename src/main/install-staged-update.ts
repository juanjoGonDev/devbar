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
  'platform' | 'messageBox' | 'toast' | 'markUpdateExit' | 'quitAfter'
> {
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
  let res;
  try {
    res = await deps.messageBox({
      type: 'question',
      buttons: ['Ahora no', 'Reiniciar e instalar'],
      defaultId: 1,
      cancelId: 0,
      message: `DevBar v${staged.version} está lista`,
      detail:
        'Ya está descargada. DevBar se cerrará, se sustituirá por la nueva versión y volverá a abrirse sola.',
    });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  return res.response === 1 ? null : { ok: false, cancelled: true };
}

export async function installStagedUpdate(
  deps: InstallStagedDeps,
  phase: PhaseStore,
  staged: StagedUpdate,
  target: string,
  { ask }: { ask: boolean },
): Promise<ApplyUpdateResult> {
  // Linux asks nothing more: the click WAS the confirmation, and a modal
  // can open behind every window on some window managers / Wayland.
  if (ask && deps.platform !== 'linux') {
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
