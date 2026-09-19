import { describe, expect, it } from 'vitest';
import { registerAppIpc, type AppIpcDeps } from '../src/main/ipc/app-ipc.js';
import { makeSettings, recordingIpc } from './helpers/main-fakes.js';
import type { ImportPayload } from '../src/config-io.js';

const preview = {
  groupsCount: 2,
  commandsCount: 3,
  actionsCount: 1,
  preStepsCount: 0,
  preScriptsCount: 0,
  hasGlobalSettings: true,
};

const payload = {
  version: 1,
  groups: [],
  globalSettings: {},
} as unknown as ImportPayload;

function harness(overrides: Partial<AppIpcDeps> = {}) {
  const calls: string[] = [];
  const written: { path: string; contents: string }[] = [];
  const timers: (() => void)[] = [];
  let files = new Map<string, string>([['/in.json', JSON.stringify({ a: 1 })]]);
  let saveResult: { canceled: boolean; filePath?: string } = {
    canceled: false,
    filePath: '/out.json',
  };
  let openResult = { canceled: false, filePaths: ['/in.json'] };
  let folderResult = { canceled: false, filePaths: ['/chosen'] };
  let messageResponse = 1;
  let stopAll = { ok: true, failed: [] as string[] };
  let validation: ReturnType<AppIpcDeps['configIo']['validateImportedConfig']> =
    {
      ok: true,
      payload,
    };
  const ipc = recordingIpc();
  registerAppIpc(ipc, {
    configStore: {
      exportConfig: () => ({ version: 1 }),
      replaceConfig: () => calls.push('replaceConfig'),
      writeImportBackup: () => '/backup.json',
      getGlobalSettings: () => makeSettings({ autostart: true }),
    },
    processManager: { stopAll: () => Promise.resolve(stopAll) },
    configIo: {
      validateImportedConfig: () => validation,
      summarizeImport: () => preview,
    },
    files: {
      readText: (path) => {
        const contents = files.get(path);
        if (contents === undefined) throw new Error('ENOENT');
        return contents;
      },
      writeText: (path, contents) => written.push({ path, contents }),
    },
    dialogs: {
      save: () => Promise.resolve(saveResult),
      open: () => Promise.resolve(openResult),
      folder: (options) => {
        calls.push(`folder:${options.defaultPath ?? ''}`);
        return Promise.resolve(folderResult);
      },
      message: () => Promise.resolve({ response: messageResponse }),
    },
    updater: {
      status: () => ({
        available: null,
        staged: null,
        lastCheckAt: null,
        currentVersion: '1.2.0',
      }),
      runUpdateCheck: (options) => {
        calls.push(`check:${options?.manual === true}`);
        return Promise.resolve({});
      },
      applyUpdate: () => {
        calls.push('apply');
        return Promise.resolve({ ok: true });
      },
    },
    snapshots: { forgetPipelineRunId: () => calls.push('forgetRunId') },
    expandTilde: (value) => value.replace('~', '/home/me'),
    syncRepoWatchers: () => calls.push('syncRepoWatchers'),
    applyAutostart: (enabled) => calls.push(`autostart:${enabled}`),
    broadcast: () => calls.push('broadcast'),
    fetchReleases: (limit) =>
      Promise.resolve([{ version: `${limit}` } as never]),
    releasesUrl: 'https://github.test/releases',
    iconBattery: { emojis: [] },
    devPanelAvailable: true,
    appVersion: () => '1.2.0',
    appQuit: () => calls.push('quit'),
    openNotificationSettings: () => Promise.resolve({ ok: true }),
    openExternal: (url) => calls.push(`external:${url}`),
    reportIssue: () => {
      calls.push('reportIssue');
      return {
        url: 'https://github.test/issues/new?title=x',
        bodyIncluded: true,
      };
    },
    setTimer: (fn) => timers.push(fn),
    newImportToken: () => 'tok',
    ...overrides,
  });
  return {
    ipc,
    calls,
    written,
    timers,
    setSave: (value: typeof saveResult) => {
      saveResult = value;
    },
    setOpen: (value: typeof openResult) => {
      openResult = value;
    },
    setFolder: (value: typeof folderResult) => {
      folderResult = value;
    },
    setMessage: (value: number) => {
      messageResponse = value;
    },
    setStopAll: (value: typeof stopAll) => {
      stopAll = value;
    },
    setValidation: (value: typeof validation) => {
      validation = value;
    },
    setFiles: (value: Map<string, string>) => {
      files = value;
    },
  };
}

describe('src/main/ipc/app-ipc.ts', () => {
  describe('registration', () => {
    it('claims every app channel', () => {
      expect(harness().ipc.channels()).toEqual([
        'updates:status',
        'updates:check',
        'updates:apply',
        'updates:changelog',
        'config:export',
        'config:import',
        'config:confirmImport',
        'config:applyImport',
        'icons:get',
        'dialog:pickFolder',
        'app:isDev',
        'app:quit',
        'app:version',
        'app:openNotificationSettings',
        'app:reportIssue',
        'app:openExternal',
      ]);
    });
  });

  describe('app:reportIssue', () => {
    it('copies the report, opens the URL and reports whether the body rode along', async () => {
      const h = harness();
      const res = await h.ipc.invoke('app:reportIssue');
      expect(res).toEqual({ ok: true, bodyIncluded: true });
      expect(h.calls).toContain('reportIssue');
      expect(h.calls).toContain(
        'external:https://github.test/issues/new?title=x',
      );
    });
  });

  describe('updates', () => {
    it('reads the status, forces a manual check and applies', async () => {
      const h = harness();
      expect(h.ipc.invoke('updates:status')).toMatchObject({
        currentVersion: '1.2.0',
      });
      await h.ipc.invoke('updates:check');
      await h.ipc.invoke('updates:apply');
      expect(h.calls).toEqual(['check:true', 'apply']);
    });

    it('serves the last five releases with the repo link', async () => {
      const h = harness();
      await expect(h.ipc.invoke('updates:changelog')).resolves.toEqual({
        releases: [{ version: '5' }],
        repoUrl: 'https://github.test/releases',
      });
    });
  });

  describe('config:export', () => {
    it('writes the serialized config to the chosen file', async () => {
      const h = harness();
      await expect(h.ipc.invoke('config:export')).resolves.toEqual({
        ok: true,
        path: '/out.json',
      });
      expect(h.written[0]?.contents).toBe(
        JSON.stringify({ version: 1 }, null, 2),
      );
    });

    it('reports a cancelled save', async () => {
      const h = harness();
      h.setSave({ canceled: true });
      await expect(h.ipc.invoke('config:export')).resolves.toEqual({
        ok: false,
        canceled: true,
      });
    });

    it('reports a dialog that could not open', async () => {
      const h = harness({
        dialogs: {
          save: () => Promise.reject(new Error('no window')),
          open: () => Promise.resolve({ canceled: true, filePaths: [] }),
          folder: () => Promise.resolve({ canceled: true, filePaths: [] }),
          message: () => Promise.resolve({ response: 0 }),
        },
      });
      await expect(h.ipc.invoke('config:export')).resolves.toEqual({
        ok: false,
        error: 'no window',
      });
    });

    it('reports a write that failed', async () => {
      const h = harness({
        files: {
          readText: () => '',
          writeText: () => {
            throw new Error('EACCES');
          },
        },
      });
      await expect(h.ipc.invoke('config:export')).resolves.toEqual({
        ok: false,
        error: 'EACCES',
      });
    });
  });

  describe('config:import', () => {
    it('hands back a token and a preview, never the payload', async () => {
      const h = harness();
      await expect(h.ipc.invoke('config:import')).resolves.toEqual({
        ok: true,
        token: 'tok',
        preview,
        path: '/in.json',
      });
    });

    it('reports a cancelled pick', async () => {
      const h = harness();
      h.setOpen({ canceled: true, filePaths: [] });
      await expect(h.ipc.invoke('config:import')).resolves.toEqual({
        ok: false,
        canceled: true,
      });
    });

    it('reports a dialog failure', async () => {
      const h = harness({
        dialogs: {
          save: () => Promise.resolve({ canceled: true }),
          open: () => Promise.reject(new Error('no window')),
          folder: () => Promise.resolve({ canceled: true, filePaths: [] }),
          message: () => Promise.resolve({ response: 0 }),
        },
      });
      await expect(h.ipc.invoke('config:import')).resolves.toEqual({
        ok: false,
        error: 'no window',
      });
    });

    it('reports an unreadable file', async () => {
      const h = harness();
      h.setFiles(new Map());
      await expect(h.ipc.invoke('config:import')).resolves.toEqual({
        ok: false,
        error: 'No se pudo leer el archivo: ENOENT',
      });
    });

    it('reports a file that is not JSON', async () => {
      const h = harness();
      h.setFiles(new Map([['/in.json', 'not json']]));
      await expect(h.ipc.invoke('config:import')).resolves.toEqual({
        ok: false,
        error: 'Archivo no es JSON válido',
      });
    });

    it('reports a payload that failed validation', async () => {
      const h = harness();
      h.setValidation({ ok: false, error: 'schema mismatch' });
      await expect(h.ipc.invoke('config:import')).resolves.toEqual({
        ok: false,
        error: 'schema mismatch',
      });
    });
  });

  describe('config:confirmImport', () => {
    it('lists what is about to be overwritten', async () => {
      const h = harness();
      await expect(
        h.ipc.invoke('config:confirmImport', { preview }),
      ).resolves.toEqual({ confirmed: true });
    });

    it('treats a cancel and a failed dialog alike', async () => {
      const h = harness();
      h.setMessage(0);
      await expect(
        h.ipc.invoke('config:confirmImport', { preview }),
      ).resolves.toEqual({ confirmed: false });
      const failing = harness({
        dialogs: {
          save: () => Promise.resolve({ canceled: true }),
          open: () => Promise.resolve({ canceled: true, filePaths: [] }),
          folder: () => Promise.resolve({ canceled: true, filePaths: [] }),
          message: () => Promise.reject(new Error('no window')),
        },
      });
      await expect(
        failing.ipc.invoke('config:confirmImport', { preview }),
      ).resolves.toEqual({ confirmed: false });
    });
  });

  describe('config:applyImport', () => {
    it('refuses a token it never issued', async () => {
      const h = harness();
      await expect(
        h.ipc.invoke('config:applyImport', { token: 'other' }),
      ).resolves.toMatchObject({ ok: false });
    });

    it('replaces the config and re-applies the settings', async () => {
      const h = harness();
      await h.ipc.invoke('config:import');
      await expect(
        h.ipc.invoke('config:applyImport', { token: 'tok' }),
      ).resolves.toEqual({ ok: true, backupPath: '/backup.json' });
      expect(h.calls).toEqual([
        'forgetRunId',
        'replaceConfig',
        'syncRepoWatchers',
        'autostart:true',
        'broadcast',
      ]);
    });

    it('refuses to import over a half-stopped fleet', async () => {
      const h = harness();
      h.setStopAll({ ok: false, failed: ['cmd:g1:c1'] });
      await h.ipc.invoke('config:import');
      await expect(
        h.ipc.invoke('config:applyImport', { token: 'tok' }),
      ).resolves.toMatchObject({ ok: false });
      expect(h.calls).not.toContain('replaceConfig');
    });

    it('consumes the token, so a replay expires', async () => {
      const h = harness();
      await h.ipc.invoke('config:import');
      await h.ipc.invoke('config:applyImport', { token: 'tok' });
      await expect(
        h.ipc.invoke('config:applyImport', { token: 'tok' }),
      ).resolves.toMatchObject({ ok: false });
    });

    it('expires a token that was never used', async () => {
      const h = harness();
      await h.ipc.invoke('config:import');
      h.timers[0]?.();
      await expect(
        h.ipc.invoke('config:applyImport', { token: 'tok' }),
      ).resolves.toMatchObject({ ok: false });
    });

    it('reports a failure while replacing', async () => {
      const h = harness({
        configStore: {
          exportConfig: () => ({}),
          replaceConfig: () => {
            throw new Error('disk full');
          },
          writeImportBackup: () => '/backup.json',
          getGlobalSettings: () => makeSettings(),
        },
      });
      await h.ipc.invoke('config:import');
      await expect(
        h.ipc.invoke('config:applyImport', { token: 'tok' }),
      ).resolves.toEqual({ ok: false, error: 'disk full' });
    });
  });

  describe('misc', () => {
    it('serves the icon battery and the dev-panel flag', () => {
      const h = harness();
      expect(h.ipc.invoke('icons:get')).toEqual({ emojis: [] });
      expect(h.ipc.invoke('app:isDev')).toBe(true);
      expect(h.ipc.invoke('app:version')).toBe('1.2.0');
      expect(h.ipc.invoke('app:quit')).toEqual({ ok: true });
      expect(h.calls).toContain('quit');
    });

    it('expands a tilde in the folder picker default', async () => {
      const h = harness();
      await expect(
        h.ipc.invoke('dialog:pickFolder', { defaultPath: '~/code' }),
      ).resolves.toEqual({ ok: true, path: '/chosen' });
      expect(h.calls).toContain('folder:/home/me/code');
    });

    it('opens the picker with no default at all', async () => {
      const h = harness();
      await h.ipc.invoke('dialog:pickFolder', {});
      expect(h.calls).toContain('folder:');
    });

    it('reports a cancelled folder pick', async () => {
      const h = harness();
      h.setFolder({ canceled: true, filePaths: [] });
      await expect(h.ipc.invoke('dialog:pickFolder', {})).resolves.toEqual({
        ok: false,
        canceled: true,
      });
    });

    it('reports a folder dialog that could not open', async () => {
      const h = harness({
        dialogs: {
          save: () => Promise.resolve({ canceled: true }),
          open: () => Promise.resolve({ canceled: true, filePaths: [] }),
          folder: () => Promise.reject(new Error('no window')),
          message: () => Promise.resolve({ response: 0 }),
        },
      });
      await expect(h.ipc.invoke('dialog:pickFolder', {})).resolves.toEqual({
        ok: false,
        error: 'no window',
      });
    });

    it('opens the OS notification settings', async () => {
      const h = harness();
      await expect(
        h.ipc.invoke('app:openNotificationSettings'),
      ).resolves.toEqual({ ok: true });
    });

    it('opens https links only', () => {
      const h = harness();
      expect(h.ipc.invoke('app:openExternal', 'https://devbar.test')).toEqual({
        ok: true,
      });
      expect(h.ipc.invoke('app:openExternal', 'file:///etc/passwd')).toEqual({
        ok: false,
      });
      expect(h.ipc.invoke('app:openExternal', 42)).toEqual({ ok: false });
      expect(h.calls).toEqual(['external:https://devbar.test']);
    });
  });

  describe('defaults', () => {
    it('mints a real token and uses a real expiry timer', async () => {
      const h = harness({ setTimer: undefined, newImportToken: undefined });
      const result = (await h.ipc.invoke('config:import')) as { token: string };
      expect(result.token).toMatch(/^imp_\d+_[a-z0-9]+$/);
    });
  });
});
