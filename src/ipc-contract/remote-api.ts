import type { SimpleResult } from './simple-result.js';

/**
 * A linked phone (or any browser) as the config window sees it. Its public
 * key stays in main: the window gets the safety code built from it instead
 * (`getRemoteSecurityCode`).
 */
export interface RemoteDeviceView {
  id: string;
  name: string;
  /** Short label derived from the User-Agent, e.g. "Safari · iOS". */
  client: string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * When the phone scanned this device's security code, proving both ends
   * hold the keys the other expects; null until then, and again after either
   * side renews its keys.
   */
  verifiedAt: number | null;
  /**
   * The address it last signed in from (where it paired, until then). A
   * sign-in from another one raises the «IP nueva» alert on the desktop.
   */
  lastIp: string | null;
}

/** A linked device in the «Control remoto» list, with its live presence. */
export interface RemoteDeviceRow extends RemoteDeviceView {
  /** It holds an open event stream right now («Conectado ahora»). */
  connected: boolean;
}

/** Everything the «Control remoto» section paints. */
export interface RemoteStatus {
  /** The user's switch — the server may still be down (see `error`). */
  enabled: boolean;
  autoUnlink: boolean;
  /** A desktop notice when a linked device connects. */
  notifyConnections: boolean;
  port: number;
  listening: boolean;
  /** Why the server could not listen (port in use…), in Spanish. */
  error: string | null;
  /**
   * The stored identity key could not be read (a locked or denied
   * keychain), so the server stays off: «Reintentar» tries again.
   */
  keyError: string | null;
  /**
   * The server is waiting on the OS keychain for the identity key (on macOS
   * the user may have a permission prompt open): not an error, it is just
   * not listening yet. The next status push says how it went.
   */
  keyPending: boolean;
  /** The identity key is stored without the OS keychain (none was there). */
  keyUnsealed: boolean;
  /** This machine's private LAN IPv4 addresses. */
  addresses: string[];
  devices: RemoteDeviceRow[];
}

/** QR modules, row-major: `modules[row * size + col]` is a dark cell. */
export interface RemoteQrMatrix {
  size: number;
  modules: boolean[];
}

/** A port change: the status it left, or why it was refused (Spanish). */
export type RemotePortResult =
  { ok: true; status: RemoteStatus } | { ok: false; error: string };

/**
 * A device's security code (six groups of five digits, the same the phone
 * shows), and — while the server is reachable — the QR the phone scans to
 * compare them for the user.
 */
export type RemoteSecurityCodeResult =
  | {
      ok: true;
      code: string[];
      verified: boolean;
      url: string | null;
      qr: RemoteQrMatrix | null;
    }
  | { ok: false; error: string };

export type RemotePairingResult =
  | { ok: true; url: string; expiresAt: number; qr: RemoteQrMatrix }
  | { ok: false; error: string };

/**
 * A phone that scanned the code and is waiting for the desktop's answer.
 * Its six digits are not here: only the phone shows them, and the user
 * types them on the desktop (`checkRemotePairCode`) to accept.
 */
export interface RemotePairRequest {
  requestId: string;
  name: string;
  client: string;
  ip: string;
  expiresAt: number;
}

/**
 * The digits typed on the desktop against the phone's. The third wrong code
 * rejects the request (`attemptsLeft` 0), which main then closes.
 */
export type RemotePairCodeResult =
  | { ok: true; match: boolean; attemptsLeft: number }
  | { ok: false; error: string };

export interface RemotePairRequestClosed {
  requestId: string;
  outcome: 'accepted' | 'rejected' | 'expired' | 'cancelled';
}

/** The remote-control calls of the window API (part of `DevBarApi`). */
export interface RemoteApi {
  getRemoteStatus(): Promise<RemoteStatus>;
  /** Persists the switch and starts/stops the LAN server. */
  setRemoteEnabled(enabled: boolean): Promise<RemoteStatus>;
  setRemoteAutoUnlink(enabled: boolean): Promise<RemoteStatus>;
  setRemoteNotifyConnections(enabled: boolean): Promise<RemoteStatus>;
  /**
   * Persists the port (1024–65535) and, with the switch on, restarts the
   * server on it: the active pairing code and every open stream end there.
   */
  setRemotePort(port: number): Promise<RemotePortResult>;
  renameRemoteDevice(id: string, name: string): Promise<SimpleResult>;
  unlinkRemoteDevice(id: string): Promise<SimpleResult>;
  /** Issues THE single-use pairing code (replacing any previous one). */
  startRemotePairing(): Promise<RemotePairingResult>;
  cancelRemotePairing(): Promise<SimpleResult>;
  checkRemotePairCode(
    requestId: string,
    code: string,
  ): Promise<RemotePairCodeResult>;
  /** Accepting needs the digits the phone shows; rejecting, none. */
  respondRemotePairing(
    requestId: string,
    accept: boolean,
    code: string,
  ): Promise<SimpleResult>;
  getRemoteSecurityCode(id: string): Promise<RemoteSecurityCodeResult>;
  /**
   * A new identity key for this computer: every open session ends, any
   * pairing is cancelled and every device has to verify it again.
   */
  renewRemoteIdentity(): Promise<SimpleResult>;
  onRemoteChanged(callback: (status: RemoteStatus) => void): () => void;
  /** A phone claimed the code on screen: the QR dialog shows a fresh one. */
  onRemotePairCodeClaimed(callback: () => void): () => void;
  onRemotePairRequest(
    callback: (request: RemotePairRequest) => void,
  ): () => void;
  onRemotePairRequestClosed(
    callback: (closed: RemotePairRequestClosed) => void,
  ): () => void;
}
