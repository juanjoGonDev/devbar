import type {
  RemotePairCodeResult,
  RemotePairingResult,
  RemotePairRequest,
  RemotePairRequestClosed,
} from '../../ipc-contract/remote-api.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';
import type { Pairing } from './pairing.js';
import { qrMatrix } from './qr.js';
import { toB64 } from './rc-protocol.js';
import type { TimerHandle, Timers } from './timers.js';

/**
 * The desktop's side of pairing, between the state machine
 * (src/main/remote/pairing.ts) and the config window: the QR link, the
 * pushes that open and close «¿Vincular este dispositivo?», the minute each
 * request waits, and the six digits the user types there.
 *
 * The link is `/pair#c=<code>&k=<identity key>`: both ride in the fragment,
 * which the browser never sends anywhere, so the code cannot be read off the
 * network and raced to the desktop. The phone pins the key before it trusts
 * a single answer.
 */

const NOT_PENDING = 'La solicitud ya no está pendiente.';
const CODE_MISMATCH = 'El código no coincide con el del móvil.';

export interface PairingDeskDeps {
  pairing: Pick<
    Pairing,
    'startPairing' | 'expire' | 'checkCode' | 'respond' | 'clear'
  >;
  now(): number;
  timers: Timers;
  send(channel: string, payload: unknown): void;
}

export interface PairingDesk {
  /** THE pairing code, as a link to `origin` that pins `identityKey`. */
  start(origin: string, identityKey: Uint8Array): RemotePairingResult;
  /** A phone asked: the dialog opens, and closes itself at the deadline. */
  requested(request: RemotePairRequest): void;
  /** The phone withdrew its request. */
  withdrawn(requestId: string): void;
  checkCode(requestId: string, code: string): RemotePairCodeResult;
  respond(requestId: string, accept: boolean, code: string): SimpleResult;
  /** Drops the code and every pending request; their dialogs close. */
  clear(): void;
}

export function createPairingDesk(deps: PairingDeskDeps): PairingDesk {
  const { pairing, timers } = deps;
  const expiries = new Map<string, TimerHandle>();

  const close = (
    requestId: string,
    outcome: RemotePairRequestClosed['outcome'],
  ): void => {
    const timer = expiries.get(requestId);
    if (timer !== undefined) timers.clearTimeout(timer);
    expiries.delete(requestId);
    const closed: RemotePairRequestClosed = { requestId, outcome };
    deps.send('remote:pairRequestClosed', closed);
  };

  return {
    start: (origin, identityKey) => {
      const { code, expiresAt } = pairing.startPairing();
      const url = `${origin}/pair#c=${code}&k=${toB64(identityKey)}`;
      return { ok: true, url, expiresAt, qr: qrMatrix(url) };
    },
    requested: (request) => {
      deps.send('remote:pairRequest', request);
      const expire = (): void => {
        if (pairing.expire(request.requestId))
          close(request.requestId, 'expired');
      };
      expiries.set(
        request.requestId,
        timers.setTimeout(expire, Math.max(0, request.expiresAt - deps.now())),
      );
    },
    withdrawn: (requestId) => close(requestId, 'cancelled'),
    checkCode: (requestId, code) => {
      const check = pairing.checkCode(requestId, code);
      if (!check) return { ok: false, error: NOT_PENDING };
      // The third wrong code rejected it: the dialog has to go.
      if (!check.match && check.attemptsLeft === 0)
        close(requestId, 'rejected');
      return { ok: true, ...check };
    },
    respond: (requestId, accept, code) => {
      const outcome = pairing.respond(requestId, accept, code);
      if (outcome === 'not-pending') return { ok: false, error: NOT_PENDING };
      if (outcome === 'mismatch') return { ok: false, error: CODE_MISMATCH };
      close(requestId, accept ? 'accepted' : 'rejected');
      return { ok: true };
    },
    clear: () => {
      for (const requestId of pairing.clear()) close(requestId, 'cancelled');
    },
  };
}
