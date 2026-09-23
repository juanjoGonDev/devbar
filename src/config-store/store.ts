import path from 'node:path';
import { app } from 'electron';
import Store from 'electron-store';
import { DEFAULT_MAX_LOG_LINES } from '../domain-types.js';
import type {
  GlobalSettings,
  Group,
  LegacyService,
  PreStep,
} from '../domain-types.js';
import {
  normalizeGroup,
  normalizePreStep,
  planStoreMigration,
  prunePipelineRefs,
  regenerateLegacyServices,
} from '../groups-model.js';
import {
  legacyLinuxConfigFile,
  migrateLegacyLinuxStore,
  packagedAppHome,
} from '../app-paths.js';

/**
 * The store handle itself: where the config file lives, the schema it is
 * validated against, the one-shot migration that runs before anything reads
 * it, and the slices that are plain values rather than collections
 * (globalSettings, scheduleState, version).
 *
 * The collection CRUD lives next door — `config-store.ts` for groups and
 * their commands/actions, `config-store/pipeline-store.ts` for the pipeline —
 * so neither of them has to know the store exists as anything but the
 * read/persist pair below.
 */

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  autostart: false,
  theme: 'auto',
  silenceWarnings: false,
  silenceErrors: false,
  maxLogLines: DEFAULT_MAX_LOG_LINES,
  notifySuccess: true,
  preScriptsAutoRun: false,
};

type StoreState = {
  version: number;
  services: LegacyService[];
  groups: Group[];
  preSteps: PreStep[];
  globalSettings: GlobalSettings;
  scheduleState: Record<string, string>;
  /** Absent until a v1/v2 store is actually converted — see the schema. */
  _services_pre_v3_backup?: unknown[];
};

function clampMaxLogLines(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0)
    return DEFAULT_MAX_LOG_LINES;
  return Math.min(50_000, Math.max(100, Math.floor(numberValue)));
}

const schema = {
  version: { type: 'number', default: 4 },
  services: { type: 'array', default: [] },
  groups: { type: 'array', default: [] },
  preSteps: { type: 'array', default: [] },
  globalSettings: { type: 'object', default: DEFAULT_GLOBAL_SETTINGS },
  scheduleState: { type: 'object', default: {} },
  // Deliberately NO default: conf fills schema defaults into `store.store`
  // before anything reads it, and `migrateServicesToGroups` treats ANY array
  // here as "a backup already exists" (so a real one is never overwritten).
  // A default of `[]` therefore told every v1/v2 conversion that the user's
  // original `services` had already been backed up, and the only copy of them
  // was dropped. Absent is the honest state until a conversion writes one.
  _services_pre_v3_backup: { type: 'array' },
} as const;

/**
 * Pin the store to the "DevBar" folder for packaged builds (see
 * app-paths.ts for why the explicit pin exists — on Linux Electron's
 * default keeps the package.json name). Dev mode keeps Electron's default
 * so existing dev stores are not orphaned.
 */
const storeOptions: {
  name: string;
  schema: typeof schema;
  cwd?: string;
} = { name: 'config', schema };
const storeDir = packagedAppHome();
if (storeDir !== undefined) {
  storeOptions.cwd = storeDir;
  // BEFORE the Store is constructed: pre-"DevBar"-pin packaged builds
  // stored the config at $XDG_CONFIG_HOME/devbar/config.json; move it so
  // runMigration() below runs on the user's real data.
  if (process.platform === 'linux') {
    const outcome = migrateLegacyLinuxStore(
      storeDir,
      app.getPath('home'),
      process.env.XDG_CONFIG_HOME,
    );
    if (outcome === 'failed') {
      // A failed migration must NOT fall through to a fresh empty store:
      // the first store.set() would create the target file, and every
      // later startup would skip the migration (target exists), orphaning
      // the user's legacy config forever. Keep serving the legacy
      // location for THIS run and retry the migration on the next start.
      const legacyDir = path.dirname(
        legacyLinuxConfigFile(app.getPath('home'), process.env.XDG_CONFIG_HOME),
      );
      storeOptions.cwd = legacyDir;
      console.error(
        `[config-store] legacy config migration failed — using the legacy ` +
          `store at ${legacyDir} for this run (it will be retried on the ` +
          `next start).`,
      );
    }
  }
}
const store = new Store<StoreState>(storeOptions);

function runMigration(): void {
  // The whole decision — pipeline hoisting (seeing the PRISTINE raw group
  // before normalizeGroup can strip its legacy keys), THEN the v1/v2->v3
  // conversion or v3/v4 id-repair canonical pass, and the version label
  // itself — lives in the pure, unit-tested `planStoreMigration` (see
  // `tests/groups-model.test.ts`). This function is only the store-write
  // side effect.
  const plan = planStoreMigration(store.store);
  if (!plan.changed) return;
  store.set('version', plan.version);
  store.set('groups', plan.groups);
  store.set('services', plan.services);
  store.set('preSteps', plan.preSteps);
  if (plan.preScriptsAutoRun !== null) {
    store.set('globalSettings', {
      ...getGlobalSettings(),
      preScriptsAutoRun: plan.preScriptsAutoRun,
    });
  }
  if (plan.servicesBackup !== null) {
    store.set('_services_pre_v3_backup', plan.servicesBackup);
  }
}
runMigration();

export function readGroups(): Group[] {
  return store.get('groups', []).map(normalizeGroup);
}
export function readPreSteps(): PreStep[] {
  return store.get('preSteps', []).map(normalizePreStep);
}
/**
 * Successor to the old `persistGroups`: writes `groups`, regenerates
 * `services`, and re-derives `preSteps` through `prunePipelineRefs` against
 * the NEW `groups` on every write (D5) — the same "recompute a derived
 * artifact from groups[] on every persist" template as `services` itself,
 * so every current and future write path gets referential-integrity
 * pruning for free instead of a bolt-on prune at each delete call site.
 */
export function persistState(
  groups: Group[],
  steps?: readonly PreStep[],
): void {
  const prunedSteps = prunePipelineRefs(steps ?? readPreSteps(), groups);
  store.set('groups', groups);
  store.set('services', regenerateLegacyServices(groups));
  store.set('preSteps', prunedSteps);
}

export function getGlobalSettings(): GlobalSettings {
  return {
    ...DEFAULT_GLOBAL_SETTINGS,
    ...store.get('globalSettings', DEFAULT_GLOBAL_SETTINGS),
  };
}
export function saveGlobalSettings(
  patch: Partial<GlobalSettings>,
): GlobalSettings {
  const next = { ...getGlobalSettings(), ...patch };
  next.autostart = Boolean(next.autostart);
  next.theme =
    next.theme === 'light' || next.theme === 'dark' ? next.theme : 'auto';
  next.silenceWarnings = Boolean(next.silenceWarnings);
  next.silenceErrors = Boolean(next.silenceErrors);
  next.maxLogLines = clampMaxLogLines(next.maxLogLines);
  next.notifySuccess = Boolean(next.notifySuccess);
  next.preScriptsAutoRun = Boolean(next.preScriptsAutoRun);
  store.set('globalSettings', next);
  return next;
}
export function getScheduleLastRun(processId: string): string | null {
  return store.get('scheduleState', {})[processId] ?? null;
}
export function setScheduleLastRun(processId: string, iso: string): void {
  const state = { ...store.get('scheduleState', {}) };
  state[processId] = iso;
  store.set('scheduleState', state);
}

/** The schema version currently on disk — what an export/backup is labelled. */
export function readVersion(): number {
  return store.get('version', 4);
}
export function writeVersion(version: number): void {
  store.set('version', version);
}

/**
 * The directory the store is ACTUALLY served from, NOT appHome(): when the
 * Linux migration fails, the store is served from the LEGACY dir for this run
 * while appHome() still points at the (unavailable) new dir. In dev mode cwd
 * is unset and conf's Store default (userData) applies, as here.
 */
export function storeDirectory(): string {
  return storeOptions.cwd ?? app.getPath('userData');
}
