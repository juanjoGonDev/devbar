import fs from 'node:fs';
import os from 'node:os';
import { sendToRenderers } from '../renderer-bus.js';
import type { RemoteControlState } from './device-store.js';
import type { SecretBox } from './identity.js';
import {
  createRemoteControl,
  type RemoteControl,
  type RemoteControlDeps,
} from './remote-control.js';
import { remoteRuntime, type RemoteAppWiring } from './runtime.js';

/**
 * «Control remoto» wired to the real collaborators: the disk, the OS, the
 * window fan-out, the keychain (safeStorage), the desktop banner and the
 * app's own runtime. Everything it decides lives in
 * src/main/remote/remote-control.ts; this only hands it what main.ts has.
 */

/** What main.ts already has at hand. */
interface RemoteWiring extends RemoteAppWiring {
  notifications: {
    showBannerNotification: NonNullable<RemoteControlDeps['showBanner']>;
  };
  host: RemoteAppWiring['host'] & {
    rendererFile(name: string): string;
    appVersion(): string;
    safeStorage: SecretBox;
  };
  configStore: RemoteAppWiring['configStore'] & {
    getRemoteControl(): unknown;
    saveRemoteControl(state: RemoteControlState): void;
  };
}

/** The real collaborators: disk, OS, the window fan-out and the app. */
export function remoteControlDeps(wiring: RemoteWiring): RemoteControlDeps {
  return {
    readState: () => wiring.configStore.getRemoteControl(),
    writeState: (state) => wiring.configStore.saveRemoteControl(state),
    send: (channel, payload) =>
      sendToRenderers(wiring.registry, channel, payload),
    readStatic: (file) => {
      try {
        return fs.readFileSync(wiring.host.rendererFile(file));
      } catch {
        return null;
      }
    },
    appVersion: () => wiring.host.appVersion(),
    // "Mac-de-Ana.local" → "Mac-de-Ana": what the phone calls this computer.
    hostName: () => os.hostname().split('.')[0] ?? os.hostname(),
    networkInterfaces: () => os.networkInterfaces(),
    runtime: remoteRuntime(wiring),
    secretBox: wiring.host.safeStorage,
    showBanner: (title, body, options) =>
      wiring.notifications.showBannerNotification(title, body, options),
  };
}

export function remoteControlFor(wiring: RemoteWiring): RemoteControl {
  return createRemoteControl(remoteControlDeps(wiring));
}
