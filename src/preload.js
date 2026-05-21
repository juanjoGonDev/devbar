'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Groups ──────────────────────────────────────────────────────────
  listGroups: () => ipcRenderer.invoke('groups:list'),
  getGroupStates: () => ipcRenderer.invoke('groups:states'),
  saveGroup: (groupData) => ipcRenderer.invoke('groups:save', groupData),
  deleteGroup: (groupId) => ipcRenderer.invoke('groups:delete', groupId),
  reorderGroups: (groupIds) => ipcRenderer.invoke('groups:reorder', groupIds),

  // ── Commands ─────────────────────────────────────────────────────────
  saveCommand: (groupId, commandData) => ipcRenderer.invoke('commands:save', { groupId, commandData }),
  deleteCommand: (groupId, commandId) => ipcRenderer.invoke('commands:delete', { groupId, commandId }),
  reorderCommands: (groupId, commandIds) => ipcRenderer.invoke('commands:reorder', { groupId, commandIds }),
  setCommandAutoStart: (groupId, commandId, enabled) =>
    ipcRenderer.invoke('commands:setAutoStart', { groupId, commandId, enabled }),

  // ── Actions ──────────────────────────────────────────────────────────
  saveAction: (groupId, actionData) => ipcRenderer.invoke('actions:save', { groupId, actionData }),
  deleteAction: (groupId, actionId) => ipcRenderer.invoke('actions:delete', { groupId, actionId }),
  reorderActions: (groupId, actionIds) => ipcRenderer.invoke('actions:reorder', { groupId, actionIds }),
  runAction: (groupId, actionId) => ipcRenderer.invoke('actions:run', { groupId, actionId }),

  // ── Process control ───────────────────────────────────────────────────
  startProcess: (processId) => ipcRenderer.invoke('process:start', processId),
  stopProcess: (processId) => ipcRenderer.invoke('process:stop', processId),

  // ── Git (group level) ─────────────────────────────────────────────────
  listBranches: (groupId) => ipcRenderer.invoke('git:listBranches', groupId),
  currentBranch: (groupId) => ipcRenderer.invoke('git:currentBranch', groupId),
  switchBranch: (groupId, branch) => ipcRenderer.invoke('git:switchBranch', { groupId, branch }),

  // ── Silence ───────────────────────────────────────────────────────────
  addSilencePattern: (groupId, commandId, level, pattern) =>
    ipcRenderer.invoke('silence:add', { groupId, commandId, level, pattern }),
  removeSilencePattern: (groupId, commandId, level, pattern) =>
    ipcRenderer.invoke('silence:remove', { groupId, commandId, level, pattern }),
  setCommandSilence: (groupId, commandId, level, enabled) =>
    ipcRenderer.invoke('silence:setCommand', { groupId, commandId, level, enabled }),
  setGroupSilence: (groupId, level, enabled) =>
    ipcRenderer.invoke('silence:setGroup', { groupId, level, enabled }),

  // ── Logs ──────────────────────────────────────────────────────────────
  getLogs: (processId) => ipcRenderer.invoke('logs:get', processId),

  // ── Window management ─────────────────────────────────────────────────
  openConfig: () => ipcRenderer.invoke('window:openConfig'),
  hideTray: () => ipcRenderer.invoke('window:hideTray'),
  openLogs: (processId) => ipcRenderer.invoke('window:openLogs', processId),
  setTrayHeight: (h) => ipcRenderer.invoke('tray:setHeight', h),

  // ── Settings ──────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  // ── Icons ─────────────────────────────────────────────────────────────
  getIconBattery: () => ipcRenderer.invoke('icons:get'),

  // ── Config Export / Import ────────────────────────────────────────────
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  confirmImport: (args) => ipcRenderer.invoke('config:confirmImport', args),
  applyImportedConfig: (args) => ipcRenderer.invoke('config:applyImport', args),

  // ── Folder picker ─────────────────────────────────────────────────────
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', { defaultPath }),

  // ── App ───────────────────────────────────────────────────────────────
  quit: () => ipcRenderer.invoke('app:quit'),

  // ── Event subscriptions ───────────────────────────────────────────────
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('groups:update', handler);
    return () => ipcRenderer.removeListener('groups:update', handler);
  },
  onLog: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('logs:line', handler);
    return () => ipcRenderer.removeListener('logs:line', handler);
  },
  onBranchesChanged: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('branches:changed', handler);
    return () => ipcRenderer.removeListener('branches:changed', handler);
  },
  onActionDone: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('action:done', handler);
    return () => ipcRenderer.removeListener('action:done', handler);
  },
  onToast: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('groups:toast', handler);
    return () => ipcRenderer.removeListener('groups:toast', handler);
  },
});
