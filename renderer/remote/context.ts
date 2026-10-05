import type { RemoteStateView } from '../../src/ipc-contract/remote-wire.js';
import type { Answer, RemoteClient } from './api.js';
import { RemoteError } from './channel.js';
import type { RemoteEnv } from './env.js';
import type { DeviceKeys } from './keys.js';

/**
 * What each part of the linked panel gets from renderer/remote/panel.ts: the
 * client, main's clock, the last state, and the few shared actions (toasts,
 * switching tabs, the standard way to send a command).
 */

export type TabName = 'groups' | 'logs' | 'notices' | 'settings';
export type ConfirmAnswer = 'ok' | 'gone' | 'error';

/** This device's keys, as the app keeps them (renderer/remote/keys.ts). */
export interface DeviceIdentity {
  keys(): DeviceKeys;
  /** Whether this browser can keep new keys right now. */
  writable(): boolean;
  /** Keeps and trusts `next`; false when the browser would not keep it. */
  replace(next: DeviceKeys): boolean;
}

export interface PanelContext {
  env: RemoteEnv;
  client: RemoteClient;
  identity: DeviceIdentity;
  /** Main's clock: this phone's, corrected by the skew of the last push. */
  serverNow(): number;
  hostName(): string;
  state(): RemoteStateView | null;
  toast(message: string): void;
  showTab(tab: TabName): void;
  openLogs(processId: string): void;
  openConfirm(token: string): void;
  /**
   * Sends a command and reports a failure as a toast. Null when DevBar never
   * answered; `pending` is the toast for a 202 (it waits on a confirmation).
   */
  run(
    op: string,
    body?: unknown,
    options?: { pending?: string },
  ): Promise<Answer | null>;
  answerConfirm(
    token: string,
    decision: 'confirm' | 'cancel',
  ): Promise<ConfirmAnswer>;
  /** The functions the 1 s clock calls for `owner`, until its next render. */
  onTick(owner: string, fns: (() => void)[]): void;
  /**
   * An answer said this device may be unlinked (401, 403). Only a fresh
   * sign-in decides: refused as an unknown device, the app forgets the keys
   * and shows «no vinculado». True while the device is still linked.
   */
  recheck(): Promise<boolean>;
}

export const UNREACHABLE = 'No se pudo conectar con DevBar.';
/** A command whose session was lost: it is not resent on its own. */
export const LOST = 'Conexión perdida, inténtalo de nuevo.';

/** Why a call got no answer, as the user is told. */
function failureMessage(error: unknown): string {
  return error instanceof RemoteError && error.code === 'session'
    ? LOST
    : UNREACHABLE;
}

/** A call's answer, or null and the line that says why there is none. */
export async function attempt(
  call: Promise<Answer>,
): Promise<{ answer: Answer | null; failure: string }> {
  try {
    return { answer: await call, failure: '' };
  } catch (error) {
    return { answer: null, failure: failureMessage(error) };
  }
}

/** An answer that says this session is no device's: worth a recheck. */
export const signedOut = (answer: Answer | null): boolean =>
  answer?.status === 401 || answer?.status === 403;
