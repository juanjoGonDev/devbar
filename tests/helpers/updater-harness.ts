/**
 * The updater under test with every dependency faked: records calls,
 * banners, toasts, pushes and removed files so a test can read back what the
 * update flow did. Shared by the updater test files.
 */
import { createUpdater, type UpdaterDeps } from '../../src/main/updater.js';
import type { AvailableUpdate } from '../../src/domain-types.js';
import type { UpdatePhase } from '../../src/ipc-contract.js';

export const update: AvailableUpdate = {
  version: '1.3.0',
  url: 'https://github.test/releases/v1.3.0',
  dmgUrl: null,
  zipUrl: 'https://github.test/DevBar-1.3.0-macos-arm64.zip',
  setupUrl: null,
  appImageUrl: null,
  debUrl: null,
};

export function harness(overrides: Partial<UpdaterDeps> = {}) {
  const calls: string[] = [];
  const banners: string[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const statuses: unknown[] = [];
  const phases: UpdatePhase[] = [];
  const processes: string[][] = [];
  const removed: string[] = [];
  const dirs = new Map<string, string[]>([
    ['/home/updates', ['1.2.0', 'file.zip']],
  ]);
  const deps: UpdaterDeps = {
    repo: { owner: 'o', repo: 'r' },
    platform: 'darwin',
    arch: 'arm64',
    isMac: true,
    pid: 99,
    appVersion: () => '1.2.0',
    checkForUpdate: () => Promise.resolve(update),
    fetchReleaseSha256: () =>
      Promise.resolve(new Map([['DevBar-1.3.0-macos-arm64.zip', 'hash']])),
    verifySha256: () => Promise.resolve(true),
    stageableAsset: () => ({
      url: update.zipUrl ?? '',
      fileName: 'DevBar-1.3.0-macos-arm64.zip',
      kind: 'macBundle',
    }),
    stageDownloadedArtifact: (input) => {
      calls.push(`stage:${input.destDir}`);
      return Promise.resolve({ version: input.version, appPath: '/staged' });
    },
    extractUpdate: (input) => {
      calls.push(`extract:${input.zipPath}`);
      return Promise.resolve({ version: input.version, appPath: '/staged' });
    },
    canInstallInPlace: (installed: string | null): installed is string =>
      installed !== null,
    installedAppPath: () => '/Applications/DevBar.app',
    spawnSwap: () => calls.push('spawnSwap'),
    downloadFile: (_url, dest, options) => {
      calls.push('download');
      options?.onProgress?.({ received: 50, total: 100 });
      return Promise.resolve(dest);
    },
    downloadsDir: () => '/Users/me/Downloads',
    updatesDir: () => '/home/updates',
    removeFile: (target) => removed.push(target),
    updaterFs: {
      mkdirSync: () => calls.push('mkdir'),
      rmSync: (target) => removed.push(target),
      readdirSync: (dir) => dirs.get(dir) ?? [],
      isDirectory: (target) => !target.endsWith('.zip'),
      readInstalledPlist: () =>
        '<key>CFBundleIdentifier</key><string>dev.devbar.app</string>',
    },
    messageBox: () => Promise.resolve({ response: 1 }),
    openPath: () => Promise.resolve(''),
    openExternal: (url) => calls.push(`external:${url}`),
    send: (channel, payload) => {
      if (channel === 'updates:status') statuses.push(payload);
      else phases.push(payload as UpdatePhase);
    },
    linuxInstallShape: () => Promise.resolve('deb'),
    makeExecutable: (target) => calls.push(`chmod:${target}`),
    runProcess: (file, args) => {
      processes.push([file, ...args]);
      return Promise.resolve({
        code: 0,
        stdout: '',
        stderr: '',
        spawnError: null,
      });
    },
    pathExists: () => true,
    relaunch: () => calls.push('relaunch'),
    copyText: (text) => calls.push(`copy:${text}`),
    showItemInFolder: (target) => calls.push(`show:${target}`),
    refreshTrayIcon: () => calls.push('refreshTrayIcon'),
    showBannerNotification: (_title, body) => banners.push(body),
    toast: (kind, message) => toasts.push({ kind, message }),
    markUpdateExit: () => calls.push('markUpdateExit'),
    quitAfter: (ms) => calls.push(`quit:${ms}`),
    configFocused: () => false,
    ...overrides,
  };
  return {
    updater: createUpdater(deps),
    calls,
    banners,
    toasts,
    statuses,
    phases,
    processes,
    removed,
  };
}
