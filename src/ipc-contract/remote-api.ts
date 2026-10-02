import type { SimpleResult } from './simple-result.js';

/**
 * A linked phone (or any browser) as the config window sees it. The session
 * token's hash never leaves main: nothing here can re-authenticate anyone.
 */
export interface RemoteDeviceView {
  id: string;
  name: string;
  /** Short label derived from the User-Agent, e.g. "Safari · iOS". */
  client: string;
  createdAt: number;
  lastSeenAt: number;
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
  port: number;
  listening: boolean;
  /** Why the server could not listen (port in use…), in Spanish. */
  error: string | null;
  /** This machine's private LAN IPv4 addresses. */
  addresses: string[];
  devices: RemoteDeviceRow[];
}

/** QR modules, row-major: `modules[row * size + col]` is a dark cell. */
export interface RemoteQrMatrix {
  size: number;
  modules: boolean[];
}

export type RemotePairingResult =
  | { ok: true; url: string; expiresAt: number; qr: RemoteQrMatrix }
  | { ok: false; error: string };

/** A phone that scanned the code and is waiting for the desktop's answer. */
export interface RemotePairRequest {
  requestId: string;
  name: string;
  client: string;
  ip: string;
  /** Six digits, also shown on the phone. */
  verificationCode: string;
  expiresAt: number;
}

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
  renameRemoteDevice(id: string, name: string): Promise<SimpleResult>;
  unlinkRemoteDevice(id: string): Promise<SimpleResult>;
  /** Issues THE single-use pairing code (replacing any previous one). */
  startRemotePairing(): Promise<RemotePairingResult>;
  cancelRemotePairing(): Promise<SimpleResult>;
  respondRemotePairing(
    requestId: string,
    accept: boolean,
  ): Promise<SimpleResult>;
  onRemoteChanged(callback: (status: RemoteStatus) => void): () => void;
  onRemotePairRequest(
    callback: (request: RemotePairRequest) => void,
  ): () => void;
  onRemotePairRequestClosed(
    callback: (closed: RemotePairRequestClosed) => void,
  ): () => void;
}
