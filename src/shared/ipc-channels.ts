/** IPC channel names shared by the preload and the main process */
export const INVOKE = {
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  projectsUpdate: 'projects:update',
  projectsRemove: 'projects:remove',
  projectsRevealToken: 'projects:reveal-token',
  syncSync: 'sync:sync',
  syncSyncAll: 'sync:sync-all',
  syncDownload: 'sync:download',
  syncRetryFailed: 'sync:retry-failed',
  syncConfirmCleanup: 'sync:confirm-cleanup',
  syncStop: 'sync:stop',
  syncGetActivity: 'sync:get-activity',
  syncGetFailed: 'sync:get-failed',
  syncGetDuplicates: 'sync:get-duplicates',
  foldersPick: 'folders:pick',
  foldersInspect: 'folders:inspect',
  foldersOpen: 'folders:open',
  tokensVerify: 'tokens:verify',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appVersion: 'app:version',
  appCheckForUpdates: 'app:check-for-updates',
  appStatus: 'app:status',
  appOpenExternal: 'app:open-external',
  appCopyText: 'app:copy-text',
} as const

export const SEND = {
  setSelection: 'app:set-selection',
  showMainWindow: 'app:show-main-window',
  quit: 'app:quit',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
} as const

export const EVENTS = {
  projectsChanged: 'projects:changed',
  syncActivity: 'sync:activity',
  settingsChanged: 'settings:changed',
  appStatus: 'app:status',
  appCommand: 'app:command',
  windowFocus: 'window:focus',
} as const
