/**
 * Fakes shared by the `src/main/*` suites: a recording IPC registrar, a
 * recording BrowserWindow, and minimal domain objects.
 *
 * This file lives under `tests/helpers/` because vitest collects
 * `tests/**\/*.test.ts`; a helper here is a module, not a suite.
 */
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcRegistrar } from '../../src/main/ipc-validators.js';
import type {
  Action,
  Command,
  GlobalSettings,
  Group,
  PreScript,
  ProcessState,
} from '../../src/domain-types.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export interface RecordingIpc extends IpcRegistrar {
  channels: () => string[];
  invoke: (channel: string, ...args: unknown[]) => unknown;
  invokeFrom: (sender: unknown, channel: string, ...args: unknown[]) => unknown;
}

export function recordingIpc(): RecordingIpc {
  const handlers = new Map<string, Handler>();
  const get = (channel: string): Handler => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no IPC handler for ${channel}`);
    return handler;
  };
  return {
    handle: (channel, listener) => handlers.set(channel, listener),
    channels: () => [...handlers.keys()],
    invoke: (channel, ...args) =>
      get(channel)({ sender: null } as unknown as IpcMainInvokeEvent, ...args),
    invokeFrom: (sender, channel, ...args) =>
      get(channel)({ sender } as unknown as IpcMainInvokeEvent, ...args),
  };
}

export interface FakeWindow {
  sent: { channel: string; payload: unknown }[];
  loaded: { file: string; options: unknown }[];
  events: Map<string, ((...args: never[]) => void)[]>;
  destroyed: boolean;
  visible: boolean;
  focused: boolean;
  title: string;
  background: string | null;
  size: [number, number];
  emit: (event: string, ...args: unknown[]) => void;
  webContents: {
    send: (channel: string, payload?: unknown) => void;
    once: (event: string, listener: () => void) => void;
    emit: (event: string) => void;
  };
  isDestroyed: () => boolean;
  destroy: () => void;
  setBackgroundColor: (color: string) => void;
  getTitle: () => string;
  show: () => void;
  showInactive: () => void;
  focus: () => void;
  close: () => void;
  isVisible: () => boolean;
  isFocused: () => boolean;
  setMenuBarVisibility: (visible: boolean) => void;
  setVisibleOnAllWorkspaces: (visible: boolean, options?: unknown) => void;
  loadFile: (file: string, options?: unknown) => void;
  on: (event: string, listener: (...args: never[]) => void) => void;
  once: (event: string, listener: (...args: never[]) => void) => void;
  getBounds: () => { x: number; y: number; width: number; height: number };
  setSize: (width: number, height: number, animate?: boolean) => void;
  getSize: () => [number, number];
}

export function fakeWindow(title = ''): FakeWindow {
  const events = new Map<string, ((...args: never[]) => void)[]>();
  const wcEvents = new Map<string, (() => void)[]>();
  const win: FakeWindow = {
    sent: [],
    loaded: [],
    events,
    destroyed: false,
    visible: false,
    focused: false,
    title,
    background: null,
    size: [410, 500],
    emit: (event, ...args) => {
      for (const listener of events.get(event) ?? [])
        (listener as (...a: unknown[]) => void)(...args);
    },
    webContents: {
      send: (channel, payload) => win.sent.push({ channel, payload }),
      once: (event, listener) =>
        wcEvents.set(event, [...(wcEvents.get(event) ?? []), listener]),
      emit: (event) => {
        for (const listener of wcEvents.get(event) ?? []) listener();
      },
    },
    isDestroyed: () => win.destroyed,
    destroy: () => {
      win.destroyed = true;
    },
    setBackgroundColor: (color) => {
      win.background = color;
    },
    getTitle: () => win.title,
    show: () => {
      win.visible = true;
    },
    showInactive: () => {
      win.visible = true;
    },
    focus: () => {
      win.focused = true;
    },
    close: () => {
      win.destroyed = true;
      win.emit('closed');
    },
    isVisible: () => win.visible,
    isFocused: () => win.focused,
    setMenuBarVisibility: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadFile: (file, options) => win.loaded.push({ file, options }),
    on: (event, listener) =>
      events.set(event, [...(events.get(event) ?? []), listener]),
    once: (event, listener) =>
      events.set(event, [...(events.get(event) ?? []), listener]),
    getBounds: () => ({ x: 0, y: 0, width: win.size[0], height: win.size[1] }),
    setSize: (width, height) => {
      win.size = [width, height];
    },
    getSize: () => win.size,
  };
  return win;
}

export const WORK_AREA = { x: 0, y: 0, width: 1440, height: 900 };

export function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'c1',
    name: 'web',
    icon: null,
    command: 'pnpm dev',
    args: [],
    env: [],
    cwd: null,
    warnRegex: '',
    errorRegex: '',
    silenceWarnings: false,
    silenceErrors: false,
    silencedPatterns: { warn: [], error: [] },
    autoStart: false,
    schedule: { enabled: false, rules: [] },
    maxLogLines: null,
    confirm: false,
    confirmSecs: null,
    confirmOnTimeout: 'cancel',
    ...overrides,
  };
}

export function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    name: 'install',
    icon: null,
    command: 'pnpm install',
    args: [],
    env: [],
    inheritGroupEnv: true,
    schedule: { enabled: false, rules: [] },
    confirm: false,
    confirmSecs: null,
    confirmOnTimeout: 'cancel',
    ...overrides,
  };
}

export function makePreScript(overrides: Partial<PreScript> = {}): PreScript {
  return {
    id: 's1',
    name: 'vpn',
    command: 'connect',
    args: [],
    env: [],
    inheritGroupEnv: true,
    timeoutMs: null,
    confirm: false,
    confirmSecs: null,
    confirmOnTimeout: 'cancel',
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 'g1',
    name: 'API',
    icon: '📁',
    path: '/repo',
    mode: 'multi',
    order: 0,
    silenceWarnings: false,
    silenceErrors: false,
    env: [],
    commands: [],
    actions: [],
    preScripts: [],
    waitForPipeline: true,
    ...overrides,
  };
}

export function makeSettings(
  overrides: Partial<GlobalSettings> = {},
): GlobalSettings {
  return {
    autostart: false,
    theme: 'auto',
    silenceWarnings: false,
    silenceErrors: false,
    maxLogLines: 10_000,
    notifySuccess: true,
    preScriptsAutoRun: true,
    ...overrides,
  };
}

export function makeState(overrides: Partial<ProcessState> = {}): ProcessState {
  return {
    id: 'g1:c1',
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    lastError: null,
    startedAt: null,
    lastExitCode: null,
    lastFinishedAt: null,
    ...overrides,
  };
}
