'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Menu, screen, dialog } = require('electron');
const { menubar } = require('menubar');

const configStore = require('./config-store');
const { validateImportedConfig, summarizeImport } = require('./config-io');
const { ProcessManager, deriveColor } = require('./process-manager');
const gitManager = require('./git-manager');
const trayIcon = require('./tray-icon');
const logger = require('./logger');
const { aggregateColor } = trayIcon;
const { loadShellPath, expandTilde } = require('./path-helper');
const { RepoWatcher } = require('./repo-watcher');
const { makeCommandId, makeActionId, parseProcessId } = require('./compound-id');
const { createPreScriptRunner } = require('./pre-script-runner');

loadShellPath();

// ─── File logger ────────────────────────────────────────────────────
// Initialise before anything noisy so we capture early `console.*`
// from the main process. The renderer side is hooked later, when each
// BrowserWindow is created (we need its `webContents` to subscribe).
//
// File lives at `app.getPath('logs')/app.log` which is
// `~/Library/Logs/DevBar/app.log` on macOS. `install-local.sh` drops a
// symlink at the repo root so the user can `tail -f app.log` from the
// project directory.
try {
  logger.init({ filePath: path.join(app.getPath('logs'), 'app.log') });
  logger.attachMainConsole();
} catch (e) {
  // Logger is best-effort; never block startup.
  // eslint-disable-next-line no-console
  console.error('logger init failed:', e);
}

const processManager = new ProcessManager(configStore);

const preScriptRunner = createPreScriptRunner({
  processManager,
  configStore,
  broadcastUpdate: () => broadcast(),
  onError: (err, ctx) => {
    broadcastToast('error', `Pre-scripts: ${err}`);
  },
});

let mb;
let configWindow = null;
const logsWindows = new Map();
const silencedWindows = new Map();
const repoWatcher = new RepoWatcher();

// Group-level transient errors (not persisted)
const groupErrors = new Map();

// Pending import payloads — keyed by opaque token (5-min TTL)
// Prevents renderer from smuggling an unvalidated payload to applyImport.
const pendingImports = new Map();

// ─────────────────────── State snapshot ──────────────────────────────

/**
 * Build a GroupState[] payload for all groups.
 * Shape per group (D4 broadcast format):
 *   { groupId, group, currentBranch, color, commands[], actions[], lastError? }
 */
function snapshotGroupStates() {
  const globals = configStore.getGlobalSettings();
  const groups = configStore.listGroups();

  return groups.map((group) => {
    const commandStates = (group.commands || []).map((cmd) => {
      const pid = makeCommandId(group.id, cmd.id);
      const state = processManager.getState(pid);
      const color = deriveColor(state, cmd, group, globals);
      const muteWarn = !!(globals.silenceWarnings || group.silenceWarnings || cmd.silenceWarnings);
      const muteErr = !!(globals.silenceErrors || group.silenceErrors || cmd.silenceErrors);
      return {
        commandId: cmd.id,
        processId: pid,
        status: state.status,
        warnCount: state.warnCount,
        errorCount: state.errorCount,
        lastError: state.lastError,
        startedAt: state.startedAt,
        color,
        muteWarn,
        muteErr,
      };
    });

    const actionStates = (group.actions || []).map((act) => {
      const pid = makeActionId(group.id, act.id);
      const state = processManager.getState(pid);
      return {
        actionId: act.id,
        processId: pid,
        status: state.status || 'idle',
        lastExitCode: state.lastExitCode,
        lastFinishedAt: state.lastFinishedAt,
        startedAt: state.startedAt,
      };
    });

    // Aggregate group color: worst over running commands
    let groupColor = 'stopped';
    for (const cs of commandStates) {
      if (cs.status === 'running') {
        if (cs.color === 'error') { groupColor = 'error'; break; }
        if (cs.color === 'warn' && groupColor !== 'error') groupColor = 'warn';
        else if (cs.color === 'running' && groupColor === 'stopped') groupColor = 'running';
      }
    }
    // Check lastError on running commands too
    if (groupColor === 'stopped') {
      const anyErr = commandStates.some((cs) => cs.lastError);
      if (anyErr) groupColor = 'error';
    }

    // Pre-scripts runtime fields
    const runState = preScriptRunner.getRunState(group.id);
    const recentResult = preScriptRunner.getRecentResult(group.id);
    const preScriptsStatus = runState ? runState.status
      : recentResult ? recentResult.status
      : 'idle';
    const preScriptsCurrentStep = runState ? runState.currentStep : null;
    const preScriptsTotalSteps = runState ? runState.totalSteps
      : (group.preSteps || []).length;
    const preScriptsLastError = (recentResult && recentResult.status === 'error')
      ? recentResult.error : null;
    const preScriptsLastRunId = runState ? String(runState.runId)
      : recentResult ? String(recentResult.runId) : null;

    return {
      groupId: group.id,
      group,
      currentBranch: null, // populated async by renderer via git:currentBranch
      color: groupColor,
      commands: commandStates,
      actions: actionStates,
      lastError: groupErrors.get(group.id) || null,
      preScriptsStatus,
      preScriptsCurrentStep,
      preScriptsTotalSteps,
      preScriptsLastError,
      preScriptsLastRunId,
      preScriptsStartedAt: runState ? runState.startedAt : null,
    };
  });
}

function broadcast() {
  const payload = snapshotGroupStates();
  for (const wc of rendererTargets()) wc.send('groups:update', payload);
  updateTrayTitle(payload);
}

function broadcastLog(payload) {
  const win = logsWindows.get(payload.id);
  if (win && !win.isDestroyed()) {
    win.webContents.send('logs:line', payload);
  }
}

function broadcastToast(kind, message) {
  for (const wc of rendererTargets()) {
    wc.send('groups:toast', { kind, message });
  }
}

function rendererTargets() {
  const targets = [];
  if (mb && mb.window && !mb.window.isDestroyed()) targets.push(mb.window.webContents);
  if (configWindow && !configWindow.isDestroyed()) targets.push(configWindow.webContents);
  for (const win of logsWindows.values()) {
    if (win && !win.isDestroyed()) targets.push(win.webContents);
  }
  for (const win of silencedWindows.values()) {
    if (win && !win.isDestroyed()) targets.push(win.webContents);
  }
  return targets;
}

function updateDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const anyOpen =
    logsWindows.size > 0 ||
    silencedWindows.size > 0 ||
    (configWindow && !configWindow.isDestroyed());
  if (anyOpen) {
    if (!app.dock.isVisible()) app.dock.show();
  } else {
    if (app.dock.isVisible()) app.dock.hide();
  }
}

function buildTrayContextMenu() {
  const items = [];
  if (logsWindows.size > 0) {
    const submenu = [];
    for (const [processId, win] of logsWindows.entries()) {
      if (win && !win.isDestroyed()) {
        const title = win.getTitle() || `Logs — ${processId}`;
        submenu.push({
          label: title,
          click: () => {
            if (!win.isDestroyed()) { win.show(); win.focus(); }
          },
        });
      }
    }
    if (submenu.length > 0) {
      items.push({ label: 'Ventanas de logs', submenu });
      items.push({ type: 'separator' });
    }
  }
  items.push({ label: 'Configuración…', click: () => ensureConfigWindow() });
  items.push({ type: 'separator' });
  items.push({ label: 'Salir', role: 'quit' });
  return Menu.buildFromTemplate(items);
}

function ensureSilencedWindow(groupId, commandId) {
  const key = `${groupId}:${commandId}`;
  const existing = silencedWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const group = configStore.getGroup(groupId);
  const command = group && group.commands && group.commands.find((c) => c.id === commandId);
  if (!command) return null;
  const win = new BrowserWindow({
    width: 480,
    height: 520,
    minWidth: 360,
    minHeight: 320,
    title: `Silenciados — ${command.name}`,
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'silenced.html'), {
    query: { groupId, commandId },
  });
  win.on('closed', () => {
    silencedWindows.delete(key);
    updateDockVisibility();
  });
  silencedWindows.set(key, win);
  logger.attachWindowConsole(win, `silenced:${key}`);
  updateDockVisibility();
  return win;
}

function broadcastBranchesChanged(repoPath) {
  for (const wc of rendererTargets()) {
    wc.send('branches:changed', { path: repoPath });
  }
}

function syncRepoWatchers() {
  const groups = configStore.listGroups();
  const paths = [...new Set(groups.map((g) => expandTilde(g.path)).filter(Boolean))];
  repoWatcher.sync(paths);
}

function updateTrayTitle(payload) {
  if (!mb || !mb.tray) return;
  // Pass per-group color objects to aggregateColor
  const colorStubs = payload.map((gs) => ({ color: gs.color }));
  const overall = aggregateColor(colorStubs);
  try {
    mb.tray.setImage(trayIcon.loadIcon(overall));
  } catch (err) {
    console.error('setImage failed:', err);
  }
  // Count non-silenced warns/errors across all command states
  let warns = 0;
  let errs = 0;
  for (const gs of payload) {
    for (const cs of gs.commands || []) {
      if (cs.status !== 'running') continue;
      if (!cs.muteWarn) warns += cs.warnCount;
      if (!cs.muteErr) errs += cs.errorCount;
    }
  }
  let badge = '';
  if (errs > 0) badge = ` ${errs}`;
  else if (warns > 0) badge = ` ${warns}`;
  mb.tray.setTitle(badge);
}

function adaptiveSize(maxW, maxH, marginW = 60, marginH = 100) {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  return {
    width: Math.max(420, Math.min(maxW, wa.width - marginW)),
    height: Math.max(360, Math.min(maxH, wa.height - marginH)),
  };
}

function ensureLogsWindow(processId, { filter } = {}) {
  const existing = logsWindows.get(processId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  // Resolve target name for window title
  const resolved = processManager.resolveTarget(processId);
  const titleName = resolved
    ? (resolved.kind === 'command' ? resolved.target.name : resolved.target.name)
    : processId;
  const size = adaptiveSize(960, 600);
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 480,
    minHeight: 320,
    title: `Logs — ${titleName}`,
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--process-id=${processId}`],
    },
  });
  win.setMenuBarVisibility(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const query = { id: processId };
  if (filter) query.filter = filter;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'logs.html'), { query });
  win.on('closed', () => {
    logsWindows.delete(processId);
    updateDockVisibility();
  });
  logsWindows.set(processId, win);
  logger.attachWindowConsole(win, `logs:${processId}`);
  updateDockVisibility();
  return win;
}

function ensureConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.show();
    configWindow.focus();
    return;
  }
  const size = adaptiveSize(820, 640);
  configWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 460,
    minHeight: 380,
    title: 'DevBar — Configuración',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  configWindow.setMenuBarVisibility(false);
  configWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  configWindow.loadFile(path.join(__dirname, '..', 'renderer', 'config.html'));
  configWindow.on('close', (e) => {
    if (configWindow.__forceClose) return;
    e.preventDefault();
    configWindow.webContents.send('config:closeRequested');
  });
  configWindow.on('closed', () => {
    configWindow = null;
    updateDockVisibility();
  });
  logger.attachWindowConsole(configWindow, 'config');
  updateDockVisibility();
}

function applyAutostart(enabled) {
  if (process.platform !== 'darwin') return;
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: true,
    });
  } catch (err) {
    console.error('Failed to set login item:', err);
  }
}

// ─────────────────────── IPC handlers ────────────────────────────────

function registerIpc() {
  // ── Groups ──────────────────────────────────────────────────────────
  ipcMain.handle('groups:list', () => configStore.listGroups());
  ipcMain.handle('groups:states', () => snapshotGroupStates());

  ipcMain.handle('groups:save', (_e, groupData) => {
    const saved = configStore.saveGroup(groupData);
    syncRepoWatchers();
    broadcast();
    return saved;
  });

  ipcMain.handle('groups:delete', async (_e, groupId) => {
    const group = configStore.getGroup(groupId);
    if (group) {
      // Stop all running commands in the group
      for (const cmd of group.commands || []) {
        const pid = makeCommandId(groupId, cmd.id);
        await processManager.stop(pid);
        processManager.states.delete(pid);
      }
      for (const act of group.actions || []) {
        const pid = makeActionId(groupId, act.id);
        await processManager.stop(pid);
        processManager.states.delete(pid);
      }
    }
    configStore.deleteGroup(groupId);
    groupErrors.delete(groupId);
    syncRepoWatchers();
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('groups:reorder', (_e, groupIds) => {
    configStore.reorderGroups(groupIds);
    broadcast();
    return { ok: true };
  });

  // ── Commands ─────────────────────────────────────────────────────────
  ipcMain.handle('commands:save', (_e, { groupId, commandData }) => {
    const saved = configStore.saveCommand(groupId, commandData);
    broadcast();
    return saved;
  });

  ipcMain.handle('commands:delete', async (_e, { groupId, commandId }) => {
    const pid = makeCommandId(groupId, commandId);
    await processManager.stop(pid);
    processManager.states.delete(pid);
    configStore.deleteCommand(groupId, commandId);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('commands:reorder', (_e, { groupId, commandIds }) => {
    configStore.reorderCommands(groupId, commandIds);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('commands:setAutoStart', (_e, { groupId, commandId, enabled }) => {
    const group = configStore.getGroup(groupId);
    if (!group) return { ok: false, error: 'group not found' };
    const cmd = (group.commands || []).find((c) => c.id === commandId);
    if (!cmd) return { ok: false, error: 'command not found' };

    let nextCommands = group.commands.map((c) =>
      c.id === commandId ? { ...c, autoStart: !!enabled } : c
    );

    // In single mode, enabling one command's autoStart clears all others
    // (radio semantics). Disabling does nothing extra.
    if (enabled && group.mode === 'single') {
      nextCommands = nextCommands.map((c) =>
        c.id === commandId ? c : { ...c, autoStart: false }
      );
    }

    configStore.saveGroup({ ...group, commands: nextCommands });
    broadcast();
    return { ok: true };
  });

  // ── Actions ──────────────────────────────────────────────────────────
  ipcMain.handle('actions:save', (_e, { groupId, actionData }) => {
    const saved = configStore.saveAction(groupId, actionData);
    broadcast();
    return saved;
  });

  ipcMain.handle('actions:delete', (_e, { groupId, actionId }) => {
    configStore.deleteAction(groupId, actionId);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('actions:reorder', (_e, { groupId, actionIds }) => {
    configStore.reorderActions(groupId, actionIds);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('actions:run', (_e, { groupId, actionId }) => {
    const pid = makeActionId(groupId, actionId);
    const res = processManager.start(pid);
    broadcast();
    return { ok: res.ok, processId: pid, error: res.error };
  });

  // ── Pre-scripts ───────────────────────────────────────────────────────
  ipcMain.handle('prescripts:run', (_e, { groupId }) => preScriptRunner.run(groupId));
  ipcMain.handle('prescripts:cancel', (_e, { groupId }) => preScriptRunner.cancel(groupId));

  ipcMain.handle('preSteps:save', (_e, { groupId, data }) => {
    const result = configStore.savePreStep(groupId, data);
    broadcast();
    return result;
  });
  ipcMain.handle('preSteps:delete', (_e, { groupId, stepId }) => {
    configStore.deletePreStep(groupId, stepId);
    broadcast();
    return { ok: true };
  });
  ipcMain.handle('preSteps:reorder', (_e, { groupId, orderedIds }) => {
    configStore.reorderPreSteps(groupId, orderedIds);
    broadcast();
    return { ok: true };
  });
  ipcMain.handle('preScripts:save', (_e, { groupId, stepId, data }) => {
    const result = configStore.savePreScript(groupId, stepId, data);
    broadcast();
    return result;
  });
  ipcMain.handle('preScripts:delete', (_e, { groupId, stepId, scriptId }) => {
    configStore.deletePreScript(groupId, stepId, scriptId);
    broadcast();
    return { ok: true };
  });
  ipcMain.handle('preScripts:reorder', (_e, { groupId, stepId, orderedIds }) => {
    configStore.reorderPreScripts(groupId, stepId, orderedIds);
    broadcast();
    return { ok: true };
  });

  // ── Process start/stop ────────────────────────────────────────────────
  ipcMain.handle('process:start', async (_e, processId) => {
    const parsed = parseProcessId(processId);
    if (parsed.kind === 'unknown') return { ok: false, error: 'Invalid process id' };

    // Single-mode: stop other running commands in the same group first
    if (parsed.kind === 'command') {
      const group = configStore.getGroup(parsed.groupId);
      if (group && group.mode === 'single') {
        const running = (group.commands || [])
          .map((c) => makeCommandId(group.id, c.id))
          .filter((pid) => pid !== processId && processManager.getState(pid).status === 'running');
        for (const pid of running) {
          await processManager.stop(pid);
        }
      }
    }

    const res = processManager.start(processId);
    broadcast();
    return res;
  });

  ipcMain.handle('process:stop', async (_e, processId) => {
    const res = await processManager.stop(processId);
    broadcast();
    return res;
  });

  // ── Git group-level ────────────────────────────────────────────────────
  ipcMain.handle('git:listBranches', async (_e, groupId) => {
    const group = configStore.getGroup(groupId);
    if (!group) return { ok: false, error: 'Group not found' };
    return gitManager.listBranches(group.path);
  });

  ipcMain.handle('git:currentBranch', async (_e, groupId) => {
    const group = configStore.getGroup(groupId);
    if (!group) return { ok: false, error: 'Group not found' };
    return gitManager.currentBranch(group.path);
  });

  ipcMain.handle('git:switchBranch', async (_e, { groupId, branch }) => {
    const group = configStore.getGroup(groupId);
    if (!group) return { ok: false, error: 'Group not found' };

    // Collect all currently running command pids in this group
    const runningPids = (group.commands || [])
      .map((c) => makeCommandId(group.id, c.id))
      .filter((pid) => processManager.getState(pid).status === 'running');

    // Stop all running commands and await each exit
    await Promise.all(runningPids.map((pid) => processManager.stop(pid)));

    const result = await gitManager.switchBranch(group.path, branch);
    if (!result.ok) {
      groupErrors.set(groupId, result.error);
      broadcast();
      return result;
    }
    groupErrors.set(groupId, null);

    // Restart commands that were running
    for (const pid of runningPids) {
      processManager.start(pid);
    }
    broadcast();
    return { ok: true };
  });

  // ── Silence ──────────────────────────────────────────────────────────
  ipcMain.handle('silence:add', (_e, { groupId, commandId, level, pattern }) => {
    const cmd = configStore.addSilencedPattern(groupId, commandId, level, pattern);
    if (cmd) {
      const pid = makeCommandId(groupId, commandId);
      processManager.recount(pid);
      broadcast();
    }
    return { ok: !!cmd, command: cmd };
  });

  ipcMain.handle('silence:remove', (_e, { groupId, commandId, level, pattern }) => {
    const cmd = configStore.removeSilencedPattern(groupId, commandId, level, pattern);
    if (cmd) {
      const pid = makeCommandId(groupId, commandId);
      processManager.recount(pid);
      broadcast();
    }
    return { ok: !!cmd, command: cmd };
  });

  ipcMain.handle('silence:setCommand', (_e, { groupId, commandId, level, enabled }) => {
    const cmd = configStore.setCommandSilence(groupId, commandId, level, enabled);
    if (cmd) broadcast();
    return { ok: !!cmd, command: cmd };
  });

  ipcMain.handle('silence:setGroup', (_e, { groupId, level, enabled }) => {
    const grp = configStore.setGroupSilence(groupId, level, enabled);
    if (grp) broadcast();
    return { ok: !!grp, group: grp };
  });

  // ── Logs ─────────────────────────────────────────────────────────────
  ipcMain.handle('logs:get', (_e, processId) => {
    const resolved = processManager.resolveTarget(processId);
    const cmdState = processManager.getState(processId);
    return {
      target: resolved || { kind: 'unknown', group: null, target: { name: '?' } },
      lines: processManager.getLogs(processId),
      commandState: { status: cmdState.status, startedAt: cmdState.startedAt },
    };
  });

  // ── Window management ─────────────────────────────────────────────────
  ipcMain.handle('window:openConfig', () => {
    ensureConfigWindow();
    if (mb && mb.window && mb.window.isVisible()) mb.hideWindow();
    return { ok: true };
  });

  ipcMain.handle('window:hideTray', () => {
    if (mb) mb.hideWindow();
    return { ok: true };
  });

  // Renderer measures its natural scrollHeight after every render and
  // sends it here so the popover grows / shrinks to fit. We clamp against
  // the available work-area so an extremely tall list doesn't push past
  // the screen edge.
  ipcMain.handle('tray:setHeight', (_e, contentHeight) => {
    if (!mb || !mb.window || mb.window.isDestroyed()) return { ok: false };
    const bounds = mb.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const maxH = Math.max(280, display.workAreaSize.height - 80);
    const desired = Math.max(160, Math.min(Math.ceil(contentHeight) + 4, maxH));
    if (desired !== bounds.height) {
      mb.window.setSize(bounds.width, desired, false);
    }
    return { ok: true, applied: desired };
  });

  ipcMain.handle('window:openLogs', (_e, payload) => {
    const { processId, filter } = typeof payload === 'string'
      ? { processId: payload }
      : payload;
    const existed = !!logsWindows.get(processId);
    const win = ensureLogsWindow(processId, { filter });
    if (existed && filter) win.webContents.send('logs:setFilter', { processId, filter });
    if (mb && mb.window && mb.window.isVisible()) mb.hideWindow();
    return { ok: true };
  });

  ipcMain.handle('window:openSilenced', (_e, { groupId, commandId }) => {
    const win = ensureSilencedWindow(groupId, commandId);
    return win ? { ok: true } : { ok: false, error: 'command not found' };
  });

  ipcMain.handle('silenced:getForCommand', (_e, { groupId, commandId }) => {
    const group = configStore.getGroup(groupId);
    const command = group && group.commands && group.commands.find((c) => c.id === commandId);
    if (!group || !command) return { ok: false, error: 'command not found' };
    return {
      ok: true,
      group: { id: group.id, name: group.name },
      command: {
        id: command.id,
        name: command.name,
        silencedPatterns: command.silencedPatterns || { warn: [], error: [] },
      },
    };
  });

  // ── Settings ──────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => configStore.getGlobalSettings());
  ipcMain.handle('settings:save', (_e, patch) => {
    const next = configStore.saveGlobalSettings(patch || {});
    applyAutostart(next.autostart);
    broadcast();
    return next;
  });

  // ── Config Export / Import ────────────────────────────────────────────

  ipcMain.handle('config:export', async () => {
    const owner = configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();
    const stamp = new Date().toISOString().slice(0, 10);
    let res;
    try {
      res = await dialog.showSaveDialog(owner, {
        title: 'Exportar configuración DevBar',
        defaultPath: `devbar-config-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const data = configStore.exportConfig();
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('config:import', async () => {
    const owner = configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();
    let res;
    try {
      res = await dialog.showOpenDialog(owner, {
        title: 'Importar configuración DevBar',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    let raw;
    try {
      raw = fs.readFileSync(res.filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, error: `No se pudo leer el archivo: ${err.message}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return { ok: false, error: 'Archivo no es JSON válido' };
    }
    const v = validateImportedConfig(parsed);
    if (!v.ok) return { ok: false, error: v.error };

    const token = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    pendingImports.set(token, v.payload);
    // Clear stale tokens after 5 minutes
    setTimeout(() => pendingImports.delete(token), 5 * 60 * 1000);

    return { ok: true, token, preview: summarizeImport(v.payload), path: res.filePaths[0] };
  });

  ipcMain.handle('config:confirmImport', async (_e, { preview }) => {
    const owner = configWindow || (mb && mb.window) || BrowserWindow.getFocusedWindow();
    const detail =
      `Esto sobreescribirá TODA tu configuración actual:\n\n` +
      `· ${preview.groupsCount} grupos\n` +
      `· ${preview.commandsCount} comandos\n` +
      `· ${preview.actionsCount} acciones\n` +
      `${preview.hasGlobalSettings ? '· ajustes globales\n' : ''}` +
      `\nSe guardará una copia en pre-import-backup.json antes de aplicar.`;
    let res;
    try {
      res = await dialog.showMessageBox(owner, {
        type: 'warning',
        buttons: ['Cancelar', 'Importar'],
        defaultId: 0,
        cancelId: 0,
        message: 'Importar configuración',
        detail,
      });
    } catch (err) {
      return { confirmed: false };
    }
    return { confirmed: res.response === 1 };
  });

  ipcMain.handle('config:applyImport', async (_e, { token }) => {
    const payload = pendingImports.get(token);
    if (!payload) {
      return { ok: false, error: 'La importación expiró — vuelve a seleccionar el archivo' };
    }
    pendingImports.delete(token);
    try {
      const backupPath = configStore.writeImportBackup();
      await processManager.stopAll();
      configStore.replaceConfig(payload);
      syncRepoWatchers();
      applyAutostart(configStore.getGlobalSettings().autostart);
      broadcast();
      return { ok: true, backupPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Icons ────────────────────────────────────────────────────────────
  ipcMain.handle('icons:get', () => {
    return require('./icon-battery').ICON_BATTERY;
  });

  // ── Folder picker ─────────────────────────────────────────────────────
  ipcMain.handle('dialog:pickFolder', async (_e, { defaultPath } = {}) => {
    const expanded = defaultPath ? expandTilde(defaultPath) : undefined;
    const focused = BrowserWindow.getFocusedWindow();
    let res;
    try {
      res = await dialog.showOpenDialog(focused, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: expanded,
        title: 'Selecciona una carpeta',
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  // ── App ───────────────────────────────────────────────────────────────
  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // ── Config dirty-close helpers ─────────────────────────────────────────
  ipcMain.handle('config:confirmDirty', async (e, { context }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const message = 'Tienes cambios sin guardar.';
    const detail = context === 'window-close'
      ? '¿Quieres guardarlos antes de cerrar la ventana?'
      : '¿Quieres guardarlos antes de cambiar de grupo?';
    let res;
    try {
      res = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancelar', 'Descartar', 'Guardar'],
        cancelId: 0,
        defaultId: 2,
        message,
        detail,
      });
    } catch (err) {
      return { choice: 'cancel' };
    }
    return { choice: ['cancel', 'discard', 'save'][res.response] };
  });

  ipcMain.handle('window:confirmCloseConfig', () => {
    if (!configWindow || configWindow.isDestroyed()) return { ok: true };
    configWindow.__forceClose = true;
    configWindow.close();
    return { ok: true };
  });
}

// ─────────────────────── Auto-start at boot ──────────────────────────

/**
 * Spawn all commands flagged with autoStart:true.
 * Called once per app launch, after the tray is ready and renderers have painted.
 *
 * - Actions are NOT eligible (running `pnpm install` at every boot would be wrong).
 * - Single-mode groups: only spawn the first flagged command even if somehow more
 *   than one has autoStart:true (enforceSingleModeAutoStart should prevent that,
 *   but this is a belt-and-suspenders guard).
 * - Errors per command are logged and swallowed so the remaining commands still start.
 * - For groups with preSteps, the pipeline runs first (per group, in parallel via
 *   Promise.all — distinct groups are independent; ADR-3). If the pipeline fails,
 *   the group's autoStart commands are NOT started and a toast is shown.
 */
async function autoStartAllMarkedCommands() {
  // Only run pre-scripts when DevBar was launched by macOS at login —
  // i.e. on system boot — not on every manual app restart. This protects
  // the user from re-running expensive `make setup` style scripts every
  // time they quit and reopen DevBar.
  const wasOpenedAtLogin =
    process.platform === 'darwin' &&
    !!(app.getLoginItemSettings && app.getLoginItemSettings().wasOpenedAtLogin);

  const groups = configStore.listGroups();
  await Promise.all(groups.map(async (group) => {
    const eligible = (group.commands || []).filter((c) => c.autoStart === true);
    if (eligible.length === 0) return;

    // Run pre-scripts pipeline if:
    // - the group has preSteps configured
    // - the user opted in via `preScriptsAutoRun: true`
    // - and DevBar was opened at login (not a manual restart)
    const shouldRunPre =
      group.preSteps && group.preSteps.length > 0 &&
      group.preScriptsAutoRun === true &&
      wasOpenedAtLogin;
    if (shouldRunPre) {
      const res = await preScriptRunner.run(group.id);
      if (!res.ok) {
        broadcastToast('error', `Pre-scripts ${group.name}: ${res.error || 'failed'}`);
        return; // skip starting commands for this group
      }
    }

    const toStart = group.mode === 'single' ? eligible.slice(0, 1) : eligible;
    for (const cmd of toStart) {
      const pid = makeCommandId(group.id, cmd.id);
      try {
        processManager.start(pid);
      } catch (err) {
        console.error(`autoStart failed for ${group.name}/${cmd.name}:`, err);
      }
    }
  }));
}

// ─────────────────────── App lifecycle ───────────────────────────────

app.on('ready', () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
    updateDockVisibility();
  }
});

app.whenReady().then(() => {
  registerIpc();
  applyAutostart(configStore.getGlobalSettings().autostart);
  processManager.on('change', () => broadcast());
  processManager.on('log', (payload) => broadcastLog(payload));
  processManager.on('action:done', ({ processId, code, group, target }) => {
    // Pre-script exits are handled by pre-script-runner (pipeline aggregator).
    // Do not toast for individual pre-script script exits — the pipeline runner
    // handles success/failure toasting at the pipeline level.
    const parsed = parseProcessId(processId);
    if (parsed.kind === 'prescript') {
      broadcast();
      return;
    }
    const kind = code === 0 ? 'ok' : 'error';
    const message = `${group ? group.name : '?'} · ${target ? target.name : '?'} exited ${code}`;
    broadcastToast(kind, message);
    broadcast();
  });
  repoWatcher.on('change', (repoPath) => broadcastBranchesChanged(repoPath));
  syncRepoWatchers();

  trayIcon.preload();

  mb = menubar({
    index: `file://${path.join(__dirname, '..', 'renderer', 'tray.html')}`,
    icon: trayIcon.defaultIcon(),
    tooltip: 'DevBar',
    preloadWindow: true,
    browserWindow: {
      width: 410,
      height: 500,
      transparent: false,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });

  mb.on('ready', () => {
    mb.tray.setImage(trayIcon.defaultIcon());
    mb.tray.setTitle('');

    mb.tray.on('right-click', () => {
      mb.tray.popUpContextMenu(buildTrayContextMenu());
    });
    broadcast();

    // Auto-start commands marked with autoStart:true.
    // Delay 300 ms so the renderer can paint its initial empty state first.
    // Only commands are eligible — actions are one-shots and must not run at boot.
    setTimeout(() => autoStartAllMarkedCommands(), 300);
  });

  mb.on('after-create-window', () => {
    // Capture renderer console for the tray popover.
    if (mb.window) logger.attachWindowConsole(mb.window, 'tray');
    broadcast();
  });
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', async () => {
  repoWatcher.closeAll();
  // Cancel any running pre-script pipelines
  for (const groupId of preScriptRunner.running.keys()) {
    try { preScriptRunner.cancel(groupId); } catch (_) {}
  }
  // Stop all running processes
  const groups = configStore.listGroups();
  for (const group of groups) {
    for (const cmd of group.commands || []) {
      const pid = makeCommandId(group.id, cmd.id);
      try { await processManager.stop(pid); } catch (_) {}
    }
  }
});
