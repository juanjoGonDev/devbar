/**
 * Opens the REAL `src/config-store.js` — real `electron-store`, real schema,
 * real JSON on a real disk — against a throwaway directory, with `electron`
 * itself the only thing faked.
 *
 * Why a module reload per scenario: config-store does its whole job at import
 * time (it picks the store directory, moves a legacy Linux config, constructs
 * the `Store` and runs the schema migration before a single export is
 * callable). A scenario therefore IS an import, so every helper here ends in
 * one.
 *
 * Why `open()` always pins a PACKAGED macOS build: vitest externalizes
 * `electron-store`, so that package's own `import electron from 'electron'`
 * reaches the real npm module (a path string) rather than the test's mock.
 * It can therefore never derive a default directory, and only a store whose
 * `cwd` config-store pins explicitly — i.e. a packaged build — can be
 * constructed under test. Everything below the directory choice behaves
 * identically in dev mode, and the directory choice itself is
 * `app-paths.packagedAppHome()`, which has its own tests.
 *
 * The caller owns the `electron` mock and hands its hoisted state in, because
 * `vi.resetModules()` must never be able to hand the mock factory a different
 * state object than the one the test is writing to.
 *
 * This file lives under `tests/helpers/` because vitest collects
 * `tests/**\/*.test.ts`; a helper here is a module, not a suite.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export interface ElectronState {
  isPackaged: boolean;
  home: string;
  userData: string;
  version: string;
}

export type ConfigStoreModule = typeof import('../../src/config-store.js');

interface OpenOptions {
  /** Written to the store file before the store opens. */
  seed?: unknown;
  /** An earlier session's home, to reopen the same store ("restart"). */
  home?: string;
}

export interface ConfigStoreHarness {
  /** Loads config-store as a packaged macOS build pinned under `home`. */
  open(options?: OpenOptions): Promise<ConfigStoreModule>;
  /** Loads config-store against whatever state the caller has arranged. */
  load(): Promise<ConfigStoreModule>;
  /** The home the last `open` used — pass it back to reopen the store. */
  home(): string;
  /** The directory the store file actually lives in. */
  dir(): string;
  /** Makes a throwaway directory that is cleaned up with the rest. */
  scratch(): string;
  /** The raw store file, as it actually landed on disk. */
  onDisk(dir?: string): Record<string, unknown>;
  cleanup(): void;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

export function configStoreHarness(state: ElectronState): ConfigStoreHarness {
  const created: string[] = [];
  const realPlatform = process.platform;
  let currentHome = '';
  let currentDir = '';

  const scratch = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-config-'));
    created.push(dir);
    return dir;
  };

  const load = async (): Promise<ConfigStoreModule> => {
    vi.resetModules();
    return import('../../src/config-store.js');
  };

  return {
    scratch,
    load,
    home: () => currentHome,
    dir: () => currentDir,
    open: async (options = {}) => {
      setPlatform('darwin');
      state.isPackaged = true;
      currentHome = options.home ?? scratch();
      state.home = currentHome;
      state.userData = currentHome;
      currentDir = path.join(
        currentHome,
        'Library',
        'Application Support',
        'DevBar',
      );
      fs.mkdirSync(currentDir, { recursive: true });
      if (options.seed !== undefined) {
        fs.writeFileSync(
          path.join(currentDir, 'config.json'),
          JSON.stringify(options.seed, null, 2),
          'utf8',
        );
      }
      return load();
    },
    onDisk: (dir = currentDir) =>
      JSON.parse(
        fs.readFileSync(path.join(dir, 'config.json'), 'utf8'),
      ) as Record<string, unknown>,
    cleanup: () => {
      for (const dir of created)
        fs.rmSync(dir, { recursive: true, force: true });
      created.length = 0;
      currentHome = '';
      currentDir = '';
      state.isPackaged = false;
      state.version = '0.9.2';
      setPlatform(realPlatform);
    },
  };
}
