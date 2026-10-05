import type { RemoteDeviceView } from '../../ipc-contract/remote-api.js';
import type { ApiRequest, ApiResponse, RpcCall, SessionApi } from './api.js';
import type { ControlApi } from './control-api.js';
import type { DeviceStore } from './device-store.js';
import { idField, record } from './validate.js';

/**
 * Every devbar-rc/1 operation onto a handler that already existed:
 *
 *   me, pair.*, auth, unlink, verify.done, device.rotate
 *                    src/main/remote/api.ts (the session API);
 *   logs.subscribe   which process's lines this session's stream carries;
 *   everything else  for a proven device only, the route of
 *                    src/main/remote/control-api.ts it always was — a read's
 *                    arguments become its query, a write's its body.
 *
 * No business rule lives here: this only routes, so a phone over the
 * encrypted channel can do exactly what the routes allowed before.
 */

type Route = { method: 'GET' | 'POST'; pathname: string };

const get = (pathname: string): Route => ({ method: 'GET', pathname });
const post = (pathname: string): Route => ({ method: 'POST', pathname });

const CONTROL_OPS: ReadonlyMap<string, Route> = new Map([
  ['state', get('/api/state')],
  ['process.start', post('/api/process/start')],
  ['process.stop', post('/api/process/stop')],
  ['actions.run', post('/api/actions/run')],
  ['pipeline.run', post('/api/pipeline/run')],
  ['stopAll', post('/api/stop-all')],
  ['branches', get('/api/branches')],
  ['branch', post('/api/branch')],
  ['logs', get('/api/logs')],
  ['notices', get('/api/notices')],
  ['confirm', post('/api/confirm')],
  ['settings.get', get('/api/settings')],
  ['settings.set', post('/api/settings')],
  ['update.apply', post('/api/update/apply')],
  ['device.rename', post('/api/device/rename')],
]);
const LOGS_SUBSCRIBE = 'logs.subscribe';

export interface RpcDeps {
  session: SessionApi;
  control: Pick<ControlApi, 'handle'>;
  devices: Pick<DeviceStore, 'find' | 'touch'>;
  devicesChanged(): void;
  subscribeLogs(sessionId: string, logsId: string | null): void;
}

export type Rpc = (
  op: string,
  args: unknown,
  call: RpcCall,
) => Promise<ApiResponse>;

const json = (status: number, body: unknown): ApiResponse => ({
  status,
  body,
});

/** The plain route request a control operation stands for. */
function routeRequest(route: Route, args: unknown, call: RpcCall): ApiRequest {
  const query = new URLSearchParams();
  if (route.method === 'GET')
    for (const [key, value] of Object.entries(record(args) ?? {}))
      if (typeof value === 'string' || typeof value === 'number')
        query.set(key, String(value));
  return {
    method: route.method,
    pathname: route.pathname,
    query,
    sessionId: call.session.id,
    ip: call.ip,
    userAgent: call.userAgent,
    body: route.method === 'POST' ? args : undefined,
  };
}

export function createRpc(deps: RpcDeps): Rpc {
  const subscribe = (args: unknown, call: RpcCall): ApiResponse => {
    const raw = record(args)?.id;
    const logsId = raw === null ? null : idField(args, 'id');
    if (raw !== null && logsId === null)
      return json(400, { error: 'invalid-request' });
    call.session.logsId = logsId;
    deps.subscribeLogs(call.session.id, logsId);
    return json(200, { ok: true });
  };

  const deviceOf = (call: RpcCall): RemoteDeviceView | null =>
    call.session.deviceId ? deps.devices.find(call.session.deviceId) : null;

  return async (op, args, call) => {
    if (deps.session.handles(op)) return deps.session.handle(op, args, call);
    const route = CONTROL_OPS.get(op);
    if (!route && op !== LOGS_SUBSCRIBE)
      return json(404, { error: 'unknown-op' });
    const device = deviceOf(call);
    if (!device) return json(401, { error: 'unlinked' });
    // Every call of a device is a sign of life («Última conexión»).
    if (deps.devices.touch(device.id)) deps.devicesChanged();
    if (!route) return subscribe(args, call);
    return deps.control.handle(routeRequest(route, args, call), device);
  };
}
