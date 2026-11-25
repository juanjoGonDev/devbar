/**
 * The updater under test with every dependency faked: records calls,
 * banners, toasts, pushes and removed files so a test can read back what the
 * update flow did. Shared by the updater test files.
 */
import path from 'node:path';
import { createUpdater, type UpdaterDeps } from '../../src/main/updater.js';
import type { AvailableUpdate } from '../../src/domain-types.js';
import type { UpdatePhase } from '../../src/ipc-contract.js';

export const updatesDir = path.join(path.sep, 'home', 'updates');

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
  /** Every version the install modal asked about, in order. */
  const asked: string[] = [];
  /** What the user answers in the install modal; «Ahora no» by default. */
  const confirm = { answer: false };
  /** Notices kept for a linked phone. */
  const notices: string[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const statuses: unknown[] = [];
  const phases: UpdatePhase[] = [];
  const processes: string[][] = [];
  const removed: string[] = [];
  const dirs = new Map<string, string[]>([[updatesDir, ['1.2.0', 'file.zip']]]);
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
      // The staged copy is a directory next to the others, as on disk.
      const parent = path.dirname(input.destDir);
      dirs.set(parent, [
        ...(dirs.get(parent) ?? []),
        path.basename(input.destDir),
      ]);
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
    updatesDir: () => updatesDir,
    removeFile: (target) => removed.push(target),
    updaterFs: {
      mkdirSync: () => calls.push('mkdir'),
      rmSync: (target) => {
        removed.push(target);
        const parent = path.dirname(target);
        const name = path.basename(target);
        dirs.set(
          parent,
          (dirs.get(parent) ?? []).filter((entry) => entry !== name),
        );
      },
      readdirSync: (dir) => [...(dirs.get(dir) ?? [])],
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
    showBannerNotification: (_title, body, options) =>
      (options?.logOnly ? notices : banners).push(body),
    toast: (kind, message) => toasts.push({ kind, message }),
    markUpdateExit: () => calls.push('markUpdateExit'),
    quitAfter: (ms) => calls.push(`quit:${ms}`),
    configFocused: () => false,
    autoUpdate: () => true,
    confirmInstall: (version) => {
      asked.push(version);
      return Promise.resolve(confirm.answer);
    },
    ...overrides,
  };
  return {
    updater: createUpdater(deps),
    calls,
    banners,
    asked,
    confirm,
    notices,
    toasts,
    statuses,
    phases,
    processes,
    removed,
    dirs,
  };
}
