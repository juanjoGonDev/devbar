import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { buildSilencePattern } from './silence-pattern.js';
import type { DevBarApi } from './ipc-contract.js';

function subscribe<T>(
  channel: string,
  callback: (payload: T) => void,
): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void =>
    callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
const api: DevBarApi = {
  listGroups: () => ipcRenderer.invoke('groups:list'),
  getGroupStates: () => ipcRenderer.invoke('groups:states'),
  saveGroup: (data) => ipcRenderer.invoke('groups:save', data),
  deleteGroup: (groupId) => ipcRenderer.invoke('groups:delete', groupId),
  reorderGroups: (groupIds) => ipcRenderer.invoke('groups:reorder', groupIds),
  saveCommand: (groupId, commandData) =>
    ipcRenderer.invoke('commands:save', { groupId, commandData }),
  deleteCommand: (groupId, commandId) =>
    ipcRenderer.invoke('commands:delete', { groupId, commandId }),
  reorderCommands: (groupId, commandIds) =>
    ipcRenderer.invoke('commands:reorder', { groupId, commandIds }),
  setCommandAutoStart: (groupId, commandId, enabled) =>
    ipcRenderer.invoke('commands:setAutoStart', {
      groupId,
      commandId,
      enabled,
    }),
  saveAction: (groupId, actionData) =>
    ipcRenderer.invoke('actions:save', { groupId, actionData }),
  deleteAction: (groupId, actionId) =>
    ipcRenderer.invoke('actions:delete', { groupId, actionId }),
  reorderActions: (groupId, actionIds) =>
    ipcRenderer.invoke('actions:reorder', { groupId, actionIds }),
  runAction: (groupId, actionId) =>
    ipcRenderer.invoke('actions:run', { groupId, actionId }),
  startProcess: (processId) => ipcRenderer.invoke('process:start', processId),
  stopProcess: (processId) => ipcRenderer.invoke('process:stop', processId),
  listBranches: (groupId) => ipcRenderer.invoke('git:listBranches', groupId),
  currentBranch: (groupId) => ipcRenderer.invoke('git:currentBranch', groupId),
  switchBranch: (groupId, branch) =>
    ipcRenderer.invoke('git:switchBranch', { groupId, branch }),
  addSilencePattern: (groupId, commandId, level, pattern) =>
    ipcRenderer.invoke('silence:add', { groupId, commandId, level, pattern }),
  removeSilencePattern: (groupId, commandId, level, pattern) =>
    ipcRenderer.invoke('silence:remove', {
      groupId,
      commandId,
      level,
      pattern,
    }),
  setCommandSilence: (groupId, commandId, level, enabled) =>
    ipcRenderer.invoke('silence:setCommand', {
      groupId,
      commandId,
      level,
      enabled,
    }),
  setGroupSilence: (groupId, level, enabled) =>
    ipcRenderer.invoke('silence:setGroup', { groupId, level, enabled }),
  getLogs: (processId) => ipcRenderer.invoke('logs:get', processId),
  getMergedLogs: (groupId) => ipcRenderer.invoke('logs:getMerged', groupId),
  getMergedSources: (groupId) =>
    ipcRenderer.invoke('logs:getMergedSources', groupId),
  clearLogs: (processId) => ipcRenderer.invoke('logs:clear', processId),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  isDev: () => ipcRenderer.invoke('app:isDev'),
  // Thin invokers; the simulation logic lives in src/dev, which packaged
  // builds do not ship, so these reject there.
  dev: {
    simulateUpdate: (version) =>
      ipcRenderer.invoke('dev:simulateUpdate', { version }),
    clearUpdate: () => ipcRenderer.invoke('dev:clearUpdate'),
    simulateTrayColor: (color) =>
      ipcRenderer.invoke('dev:simulateTrayColor', { color }),
    simulateBanner: (cta) => ipcRenderer.invoke('dev:simulateBanner', { cta }),
    simulateFallbackBanner: (cta) =>
      ipcRenderer.invoke('dev:simulateFallbackBanner', { cta }),
    simulateSuccess: () => ipcRenderer.invoke('dev:simulateSuccess'),
    simulatePrescriptConfirm: () =>
      ipcRenderer.invoke('dev:simulatePrescriptConfirm'),
    simulateToast: (kind) => ipcRenderer.invoke('dev:simulateToast', { kind }),
  },
  openConfig: () => ipcRenderer.invoke('window:openConfig'),
  openConfigChangelog: () => ipcRenderer.invoke('window:openConfigChangelog'),
  onConfigGoto: (cb) => subscribe('config:goto', cb),
  hideTray: () => ipcRenderer.invoke('window:hideTray'),
  openLogs: (arg) => ipcRenderer.invoke('window:openLogs', arg),
  openSilenced: (groupId, commandId) =>
    ipcRenderer.invoke('window:openSilenced', { groupId, commandId }),
  getSilencedForCommand: (groupId, commandId) =>
    ipcRenderer.invoke('silenced:getForCommand', { groupId, commandId }),
  setTrayHeight: (height) => ipcRenderer.invoke('tray:setHeight', height),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testNotification: () => ipcRenderer.invoke('notifications:test'),
  dismissNotification: () => ipcRenderer.invoke('notification:dismiss'),
  notificationAction: (action) =>
    ipcRenderer.invoke('notification:action', action),
  getUpdateStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  applyUpdate: () => ipcRenderer.invoke('updates:apply'),
  onUpdateStatus: (cb) => subscribe('updates:status', cb),
  getIconBattery: () => ipcRenderer.invoke('icons:get'),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  confirmImport: (args) => ipcRenderer.invoke('config:confirmImport', args),
  applyImportedConfig: (args) => ipcRenderer.invoke('config:applyImport', args),
  pickFolder: (defaultPath) =>
    ipcRenderer.invoke('dialog:pickFolder', { defaultPath }),
  runPreScripts: (groupId) => ipcRenderer.invoke('prescripts:run', { groupId }),
  cancelPreScripts: (groupId) =>
    ipcRenderer.invoke('prescripts:cancel', { groupId }),
  savePreStep: (groupId, data) =>
    ipcRenderer.invoke('preSteps:save', { groupId, data }),
  deletePreStep: (groupId, stepId) =>
    ipcRenderer.invoke('preSteps:delete', { groupId, stepId }),
  reorderPreSteps: (groupId, orderedIds) =>
    ipcRenderer.invoke('preSteps:reorder', { groupId, orderedIds }),
  savePreScript: (groupId, stepId, data) =>
    ipcRenderer.invoke('preScripts:save', { groupId, stepId, data }),
  deletePreScript: (groupId, stepId, scriptId) =>
    ipcRenderer.invoke('preScripts:delete', { groupId, stepId, scriptId }),
  reorderPreScripts: (groupId, stepId, orderedIds) =>
    ipcRenderer.invoke('preScripts:reorder', { groupId, stepId, orderedIds }),
  getPrescriptConfirmContext: (token) =>
    ipcRenderer.invoke('prescriptConfirm:getContext', token),
  resolvePrescriptConfirm: (token, decision) =>
    ipcRenderer.invoke('prescriptConfirm:resolve', { token, decision }),
  quit: () => ipcRenderer.invoke('app:quit'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getChangelog: () => ipcRenderer.invoke('updates:changelog'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openNotificationSettings: () =>
    ipcRenderer.invoke('app:openNotificationSettings'),
  confirmDirty: (context) =>
    ipcRenderer.invoke('config:confirmDirty', { context }),
  confirmCloseConfig: () => ipcRenderer.invoke('window:confirmCloseConfig'),
  onConfigCloseRequested: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on('config:closeRequested', handler);
    return () => ipcRenderer.removeListener('config:closeRequested', handler);
  },
  buildSilencePattern,
  onUpdate: (cb) => subscribe('groups:update', cb),
  onLog: (cb) => subscribe('logs:line', cb),
  onLogsSelect: (cb) => subscribe('logs:select', cb),
  onBranchesChanged: (cb) => subscribe('branches:changed', cb),
  onActionDone: (cb) => subscribe('action:done', cb),
  onToast: (cb) => subscribe('groups:toast', cb),
};
contextBridge.exposeInMainWorld('api', api);
