import path from 'node:path';
import { app } from 'electron';
import Store from 'electron-store';
import { DEFAULT_MAX_LOG_LINES } from '../domain-types.js';
import type {
  CustomIcon,
  GlobalSettings,
  Group,
  LegacyService,
  Workflow,
  WorkflowRunRecord,
} from '../domain-types.js';
import { normalizeCustomIcons } from '../custom-icons.js';
import { OWNER_ONLY, restrictToOwner } from './owner-only.js';
import { normalizeWorkflows, pruneWorkflowRefs } from '../workflows.js';
import {
  normalizeGroup,
  planStoreMigration,
  regenerateLegacyServices,
} from '../groups-model.js';
import {
  normalizePinnedPopover,
  type PinnedPopover,
} from '../main/pinned-popover-geometry.js';
import type { RemoteControlState } from '../main/remote/device-store.js';
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
 * their commands/actions, `config-store/workflow-store.ts` for workflows —
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
  showHiddenGroupsFold: true,
  showHiddenWorkflowsFold: false,
};

type StoreState = {
  version: number;
  services: LegacyService[];
  groups: Group[];
  /** Absent only until the migration turned the old pipeline into them. */
  workflows?: Workflow[];
  /** The last finished run of each workflow, keyed by workflow id. */
  workflowRuns: Record<string, WorkflowRunRecord>;
  /** LEGACY single pipeline: read once by the migration, then deleted. */
  pipeline?: unknown;
  /** LEGACY ordered steps: read once by the migration, then deleted. */
  preSteps?: unknown[];
  globalSettings: GlobalSettings;
  scheduleState: Record<string, string>;
  /** Uploaded images usable as icons (see src/custom-icons.ts). */
  customIcons: CustomIcon[];
  /** Where the user pinned the tray popover; absent while it is anchored. */
  trayPopover?: PinnedPopover;
  /** «Control remoto»: switches and linked devices (token hashes only). */
  remoteControl?: RemoteControlState;
  /** Absent until a v1/v2 store is actually converted — see the schema. */
  _services_pre_v3_backup?: unknown[];
  /** Original emoji of every icon the Lucide migration replaced, keyed
   *  `group:<id>` / `command:<groupId>/<id>` / `action:<groupId>/<id>`.
   *  Absent until a conversion actually happens. */
  _icons_pre_lucide_backup?: Record<string, string>;
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
  // Deliberately NO default: its ABSENCE is what tells the migration that the
  // store still holds the single pre-workflow pipeline (planStoreMigration).
  workflows: { type: 'array' },
  workflowRuns: { type: 'object', default: {} },
  // Legacy keys, no defaults either: their presence is what tells the
  // migration there is something to convert, and a default would make every
  // store look like one.
  pipeline: { type: 'object' },
  preSteps: { type: 'array' },
  globalSettings: { type: 'object', default: DEFAULT_GLOBAL_SETTINGS },
  scheduleState: { type: 'object', default: {} },
  customIcons: { type: 'array', default: [] },
  // Deliberately NO default: conf fills schema defaults into `store.store`
  // before anything reads it, and `migrateServicesToGroups` treats ANY array
  // here as "a backup already exists" (so a real one is never overwritten).
  // A default of `[]` therefore told every v1/v2 conversion that the user's
  // original `services` had already been backed up, and the only copy of them
  // was dropped. Absent is the honest state until a conversion writes one.
  _services_pre_v3_backup: { type: 'array' },
  // Same reasoning: no default, so absent means "nothing was converted".
  _icons_pre_lucide_backup: { type: 'object' },
  // No default either: absent IS "anchored to the tray icon".
  trayPopover: { type: 'object' },
  // Its own key, never part of globalSettings: those reach every window and
  // every export/backup, and this holds the linked devices' public keys and
  // this computer's identity seed, as it is — which is why the whole file is
  // readable by its user only (see `configFileMode` below). Absent means
  // "never configured" — src/main/remote/device-store.ts reads that as the
  // defaults (off).
  remoteControl: { type: 'object' },
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
  configFileMode: number;
  cwd?: string;
} = {
  name: 'config',
  schema,
  // It holds «Control remoto»'s identity seed: user-only, like ~/.ssh keys.
  configFileMode: OWNER_ONLY,
};
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
// conf applies `configFileMode` only when it writes: a file an earlier
// version left readable by others is tightened here, on the next start.
restrictToOwner(store.path);

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
  store.set('workflows', plan.workflows);
  if (plan.workflowsMigrated || plan.legacyStepsMigrated) {
    store.delete('pipeline');
    store.delete('preSteps');
    // «Auto al arrancar» now lives in the startup workflow's `enabled`.
    const settings: GlobalSettings & { preScriptsAutoRun?: unknown } = {
      ...store.get('globalSettings', DEFAULT_GLOBAL_SETTINGS),
    };
    delete settings.preScriptsAutoRun;
    store.set('globalSettings', settings);
  }
  if (plan.servicesBackup !== null) {
    store.set('_services_pre_v3_backup', plan.servicesBackup);
  }
  if (plan.iconsBackup !== null) {
    store.set('_icons_pre_lucide_backup', plan.iconsBackup);
  }
}
runMigration();

/**
 * The dev panel's "Grupos y workflows de prueba": while set, every group,
 * workflow, workflow last run and schedule marker read and written in the
 * app goes to this in-memory copy instead of the store, so the user's
 * configuration and history are hidden but never read-modify-written. Never
 * persisted: a restart always comes back on the real ones.
 */
interface Overlay {
  groups: Group[];
  workflows: Workflow[];
  workflowRuns: Record<string, WorkflowRunRecord>;
  scheduleState: Record<string, string>;
}
let overlay: Overlay | null = null;

export function setGroupsOverlay(
  next: {
    groups: readonly Group[];
    workflows?: readonly Workflow[];
    workflowRuns?: Readonly<Record<string, WorkflowRunRecord>>;
  } | null,
): void {
  overlay = next
    ? {
        groups: structuredClone([...next.groups]),
        workflows: structuredClone([...(next.workflows ?? [])]),
        workflowRuns: structuredClone({ ...next.workflowRuns }),
        scheduleState: {},
      }
    : null;
}
export function groupsOverlayActive(): boolean {
  return overlay !== null;
}

/** The groups the user stored, whatever the overlay says (export, backup). */
export function readStoredGroups(): Group[] {
  return store.get('groups', []).map(normalizeGroup);
}
export function readStoredWorkflows(): Workflow[] {
  return normalizeWorkflows(store.get('workflows', []));
}
// Copies, both ways: every caller mutates what it read before persisting it,
// and that must not reach the overlay until it actually does persist.
export function readGroups(): Group[] {
  return overlay ? structuredClone(overlay.groups) : readStoredGroups();
}
export function readWorkflows(): Workflow[] {
  return overlay ? structuredClone(overlay.workflows) : readStoredWorkflows();
}
/**
 * Successor to the old `persistGroups`: writes `groups`, regenerates
 * `services`, and re-derives every workflow graph through `pruneWorkflowRefs`
 * against the NEW `groups` on every write (D5) — the same "recompute a
 * derived artifact from groups[] on every persist" template as `services`
 * itself, so every current and future write path gets referential-integrity
 * pruning for free instead of a bolt-on prune at each delete call site.
 */
export function persistState(
  groups: Group[],
  workflows?: readonly Workflow[],
): void {
  const pruned = pruneWorkflowRefs(workflows ?? readWorkflows(), groups);
  if (overlay) {
    overlay = {
      ...overlay,
      groups: structuredClone(groups),
      workflows: structuredClone(pruned),
    };
    return;
  }
  store.set('groups', groups);
  store.set('services', regenerateLegacyServices(groups));
  store.set('workflows', pruned);
}

/** Last runs are runtime history, never part of a backup. */
export function readWorkflowRuns(): Record<string, WorkflowRunRecord> {
  return overlay
    ? structuredClone(overlay.workflowRuns)
    : { ...store.get('workflowRuns', {}) };
}
export function writeWorkflowRuns(
  runs: Record<string, WorkflowRunRecord>,
): void {
  if (overlay) overlay.workflowRuns = structuredClone(runs);
  else store.set('workflowRuns', runs);
}

/** Read through normalizeCustomIcons: a hand-edited entry that is not an
 *  inline PNG never reaches a renderer. */
export function readCustomIcons(): CustomIcon[] {
  return normalizeCustomIcons(store.get('customIcons', []));
}
export function writeCustomIcons(icons: readonly CustomIcon[]): void {
  store.set('customIcons', normalizeCustomIcons(icons));
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
  next.showHiddenGroupsFold = Boolean(next.showHiddenGroupsFold);
  next.showHiddenWorkflowsFold = Boolean(next.showHiddenWorkflowsFold);
  store.set('globalSettings', next);
  return next;
}
// Under the overlay the scheduler only sees the fixture targets: their
// markers stay in memory, and the real ones are left exactly as they were.
export function getScheduleLastRun(processId: string): string | null {
  const state = overlay?.scheduleState ?? store.get('scheduleState', {});
  return state[processId] ?? null;
}
export function setScheduleLastRun(processId: string, iso: string): void {
  if (overlay) {
    overlay.scheduleState = { ...overlay.scheduleState, [processId]: iso };
    return;
  }
  const state = { ...store.get('scheduleState', {}) };
  state[processId] = iso;
  store.set('scheduleState', state);
}

/**
 * The pinned tray popover (see src/main/pinned-popover.ts), read through
 * normalizePinnedPopover so a hand-edited record means "not pinned" rather
 * than a popover restored to NaN. Null deletes the key: anchored again.
 */
export function getTrayPopover(): PinnedPopover | null {
  return normalizePinnedPopover(store.get('trayPopover'));
}
export function saveTrayPopover(value: PinnedPopover | null): void {
  if (value) store.set('trayPopover', value);
  else store.delete('trayPopover');
}

/** Raw: src/main/remote/device-store.ts normalizes what it reads. */
export function getRemoteControl(): unknown {
  return store.get('remoteControl');
}
export function saveRemoteControl(value: RemoteControlState): void {
  store.set('remoteControl', value);
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
