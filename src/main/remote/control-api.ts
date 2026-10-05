import type { GlobalSettings, Group, LogEntry } from '../../domain-types.js';
import type { RemoteDeviceView } from '../../ipc-contract/remote-api.js';
import type {
  RemoteNotice,
  RemoteStateView,
} from '../../ipc-contract/remote-wire.js';
import type { ApplyUpdateResult } from '../assisted-update.js';
import type { ConfirmDecision } from '../ipc-validators.js';
import { findRunnable, type RuntimeActions } from '../runtime-actions.js';
import type { ApiRequest, ApiResponse } from './api.js';
import {
  branchField,
  decisionField,
  idField,
  record,
  settingsPatch,
  tailParam,
} from './validate.js';
import { logLine, settingsView } from './views.js';

/**
 * What a linked phone can do: read the state, start and stop things, switch
 * branches, read logs and notices, answer confirmations, change the four
 * whitelisted settings, install a staged update and rename itself. Every
 * route runs for an authenticated device only (src/main/remote/rpc.ts maps
 * each devbar-rc/1 operation onto one of these routes once the session has
 * proved which device it is), and every body and query is narrowed by
 * src/main/remote/validate.ts before anything acts on it.
 *
 * The actions themselves are src/main/runtime-actions.ts — the very code the
 * IPC handlers run — so a phone cannot start something a window could not.
 * A start that waits on a confirmation is NOT awaited: the reply is a 202 and
 * the outcome reaches the phone through the state stream, because the modal
 * may stay open for minutes and an HTTP request should not.
 */

type Outcome = { ok: boolean; error?: string | undefined };

export interface ControlApiDeps {
  configStore: { getGroup(id: string): Group | null };
  runtime: Pick<
    RuntimeActions,
    | 'startProcess'
    | 'stopProcess'
    | 'runAction'
    | 'stopAll'
    | 'runPipeline'
    | 'listBranches'
    | 'switchBranch'
    | 'needsConfirm'
  >;
  state(): Promise<RemoteStateView>;
  logs(processId: string): readonly LogEntry[];
  /** How far the process's log count has got: the snapshot/stream boundary. */
  logSeq(processId: string): number;
  /** The notice log as this device sees it (notices about itself left out). */
  notices(deviceId: string): RemoteNotice[];
  confirms: {
    hasPending(token: string): boolean;
    resolveConfirm(token: string, decision: ConfirmDecision): void;
  };
  settings: {
    get(): GlobalSettings;
    save(patch: Partial<GlobalSettings>): GlobalSettings;
  };
  updater: {
    canInstallStaged(): boolean;
    installStagedHeadless(): Promise<ApplyUpdateResult>;
  };
  renameDevice(id: string, name: string): 'ok' | 'invalid-name' | 'not-found';
  /** A switch from the phone finished: refresh that group's branch. */
  branchSwitched(groupId: string): void;
  /** A background start that failed after its 202 was sent. */
  reportError(error: unknown): void;
}

export interface ControlApi {
  handle(request: ApiRequest, device: RemoteDeviceView): Promise<ApiResponse>;
}

type Handler = (
  request: ApiRequest,
  device: RemoteDeviceView,
) => ApiResponse | Promise<ApiResponse>;

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});
const invalid = (): ApiResponse => json(400, { error: 'invalid-request' });
const notFound = (what: string): ApiResponse =>
  json(404, { error: `unknown-${what}` });
const pending = (): ApiResponse => json(202, { pending: true });
const outcome = (result: Outcome): ApiResponse =>
  json(200, result.ok ? { ok: true } : { ok: false, error: result.error });

export function createControlApi(deps: ControlApiDeps): ControlApi {
  const { runtime } = deps;
  const kindOf = (processId: string) =>
    findRunnable((id) => deps.configStore.getGroup(id), processId)?.kind ??
    null;

  /** Fire and forget, but never silently: a rejection is reported. */
  const inBackground = (work: Promise<unknown>): ApiResponse => {
    work.catch((error: unknown) => deps.reportError(error));
    return pending();
  };

  /** Reads `processId`, held to the kinds the route accepts. */
  const processFrom = (
    body: unknown,
    kinds: readonly ('command' | 'action')[],
  ): { processId: string } | ApiResponse => {
    const processId = idField(body, 'processId');
    if (!processId || !/^(cmd|act):/.test(processId)) return invalid();
    const kind = kindOf(processId);
    if (kind === null) return notFound('process');
    return kinds.includes(kind) ? { processId } : invalid();
  };

  const start: Handler = async ({ body }) => {
    const read = processFrom(body, ['command']);
    if (!('processId' in read)) return read;
    const run = runtime.startProcess(read.processId);
    if (runtime.needsConfirm(read.processId)) return inBackground(run);
    return outcome(await run);
  };

  const stop: Handler = async ({ body }) => {
    const read = processFrom(body, ['command', 'action']);
    if (!('processId' in read)) return read;
    return outcome(await runtime.stopProcess(read.processId));
  };

  const runAction: Handler = async ({ body }) => {
    const groupId = idField(body, 'groupId');
    const actionId = idField(body, 'actionId');
    if (!groupId || !actionId) return invalid();
    const processId = `act:${groupId}:${actionId}`;
    if (kindOf(processId) !== 'action') return notFound('action');
    const run = runtime.runAction(groupId, actionId);
    if (runtime.needsConfirm(processId)) return inBackground(run);
    return outcome(await run);
  };

  const branchesOf = async (groupId: string) => {
    const answer = record(await runtime.listBranches(groupId)) ?? {};
    const branches = Array.isArray(answer.branches)
      ? answer.branches.filter((b): b is string => typeof b === 'string')
      : [];
    const error = typeof answer.error === 'string' ? answer.error : undefined;
    return { ok: answer.ok === true, branches, error };
  };

  const listBranches: Handler = async ({ query }) => {
    const groupId = idField({ groupId: query.get('groupId') }, 'groupId');
    if (!groupId) return invalid();
    if (!deps.configStore.getGroup(groupId)) return notFound('group');
    const { ok, branches, error } = await branchesOf(groupId);
    return json(200, ok ? { ok, branches } : { ok, branches, error });
  };

  const switchBranch: Handler = async ({ body }) => {
    const groupId = idField(body, 'groupId');
    const branch = branchField(body);
    if (!groupId || !branch) return invalid();
    if (!deps.configStore.getGroup(groupId)) return notFound('group');
    // Only a branch the list offers: the same choice the tray gives.
    if (!(await branchesOf(groupId)).branches.includes(branch))
      return json(400, { error: 'unknown-branch' });
    const result = await runtime.switchBranch(groupId, branch);
    deps.branchSwitched(groupId);
    return outcome(result);
  };

  const logs: Handler = ({ query }) => {
    const id = idField({ id: query.get('id') }, 'id');
    const tail = tailParam(query.get('tail'));
    if (!id || tail === null) return invalid();
    if (kindOf(id) === null) return notFound('process');
    const lines = deps.logs(id).slice(-tail).map(logLine);
    return json(200, { id, seq: deps.logSeq(id), lines });
  };

  const confirm: Handler = ({ body }) => {
    const token = idField(body, 'token');
    const decision = decisionField(body);
    if (!token || !decision) return invalid();
    // First answer wins: the desktop, the timer or another phone may have
    // settled it a moment ago.
    if (!deps.confirms.hasPending(token))
      return json(409, { error: 'already-answered' });
    deps.confirms.resolveConfirm(token, decision);
    return json(200, { ok: true });
  };

  const saveSettings: Handler = ({ body }) => {
    const patch = settingsPatch(body);
    if (!patch) return invalid();
    return json(200, settingsView(deps.settings.save(patch)));
  };

  const applyUpdate: Handler = async () => {
    if (!deps.updater.canInstallStaged())
      return json(409, { error: 'not-ready' });
    const result = await deps.updater.installStagedHeadless();
    if (!result.ok)
      return json(500, { error: result.error ?? 'install-failed' });
    return json(202, { ok: true, restarting: true });
  };

  const rename: Handler = ({ body }, device) => {
    const name = record(body)?.name;
    const result = deps.renameDevice(
      device.id,
      typeof name === 'string' ? name : '',
    );
    if (result === 'invalid-name') return json(400, { error: 'invalid-name' });
    if (result === 'not-found') return json(401, { error: 'unlinked' });
    return json(200, { ok: true });
  };

  const routes = new Map<string, Handler>([
    ['GET /api/state', async () => json(200, await deps.state())],
    ['POST /api/process/start', start],
    ['POST /api/process/stop', stop],
    ['POST /api/actions/run', runAction],
    [
      'POST /api/pipeline/run',
      () => inBackground(Promise.resolve().then(() => runtime.runPipeline())),
    ],
    ['POST /api/stop-all', async () => json(200, await runtime.stopAll())],
    ['GET /api/branches', listBranches],
    ['POST /api/branch', switchBranch],
    ['GET /api/logs', logs],
    [
      'GET /api/notices',
      (_request, device) => json(200, { notices: deps.notices(device.id) }),
    ],
    ['POST /api/confirm', confirm],
    ['GET /api/settings', () => json(200, settingsView(deps.settings.get()))],
    ['POST /api/settings', saveSettings],
    ['POST /api/update/apply', applyUpdate],
    ['POST /api/device/rename', rename],
  ]);

  return {
    handle: async (request, device) => {
      const handler = routes.get(`${request.method} ${request.pathname}`);
      if (!handler) return json(405, { error: 'method-not-allowed' });
      return handler(request, device);
    },
  };
}
