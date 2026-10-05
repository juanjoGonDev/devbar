import type { RemoteStateView } from '../../src/ipc-contract/remote-wire.js';
import type { Answer, RemoteClient } from './api.js';
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
  unlinked(): void;
}

export const UNREACHABLE = 'No se pudo conectar con DevBar.';
