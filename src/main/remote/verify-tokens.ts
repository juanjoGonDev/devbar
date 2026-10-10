import crypto from 'node:crypto';
import { fromB64, sameBytes, toB64 } from './rc-protocol.js';

/**
 * The one-time token in a device's «Código de seguridad» QR (`&t=`). The
 * other values of that QR — the identity key, the device id, the device's
 * own key — are all things the device already knows, so `verify.done` alone
 * would only be the device saying so. Carrying this token, which only this
 * screen showed, it means the phone scanned it.
 *
 * In memory only: the latest token per device, for ten minutes, taken once.
 */

const TOKEN_BYTES = 16;
const TOKEN_TTL_MS = 10 * 60_000;

export interface VerifyTokens {
  /** A new token for the device (any earlier one stops counting). */
  issue(deviceId: string): string;
  /** True once, for the device's live token, compared in constant time. */
  consume(deviceId: string, token: unknown): boolean;
  revoke(deviceId: string): void;
  clear(): void;
}

export function createVerifyTokens(deps: {
  now(): number;
  randomBytes?: (size: number) => Buffer;
}): VerifyTokens {
  const randomBytes = deps.randomBytes ?? ((size) => crypto.randomBytes(size));
  const live = new Map<string, { token: Buffer; expiresAt: number }>();
  return {
    issue: (deviceId) => {
      const token = randomBytes(TOKEN_BYTES);
      live.set(deviceId, { token, expiresAt: deps.now() + TOKEN_TTL_MS });
      return toB64(token);
    },
    consume: (deviceId, raw) => {
      const entry = live.get(deviceId);
      const token = fromB64(raw, TOKEN_BYTES);
      if (!entry || !token) return false;
      if (deps.now() >= entry.expiresAt) {
        live.delete(deviceId);
        return false;
      }
      if (!sameBytes(entry.token, token)) return false;
      live.delete(deviceId);
      return true;
    },
    revoke: (deviceId) => {
      live.delete(deviceId);
    },
    clear: () => live.clear(),
  };
}
