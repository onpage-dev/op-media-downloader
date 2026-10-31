# Changelog

## 2.0.0

A new app: a desktop sync manager for On Page media, rebuilt around a sync engine that runs in its own process.

### Sync engine
- Runs in an Electron utility process: the window never freezes, also with 100k+ files or slow network folders.
- **Incremental listing**: after the first full read, only new and changed items are read from On Page (`ids()` + `_updated_at`), with a local cache; paged requests, retries with backoff and respect of the API rate limits (HTTP 429).
- **One plan** per sync: what to download, relink and remove, computed once and shown before downloading.
- Downloads through Chromium's network stack (system proxy and PAC), 4 at a time by default, with timeouts, retries, size checks and atomic renames; **Stop** aborts the transfers in flight.
- **Safe removals**: the app only removes what it created (`data/manifest.json`); files of other people or apps in the folder are never touched, also when a project is deleted. Large removals wait for a confirmation.
- The registry of created files is saved during the run (atomically), so an interrupted session resumes without redoing the work.
- A folder lock prevents two computers from syncing the same folder at the same time.
- Folder checks: network or local, hard link support (copies take twice the space), free space, protected and overlapping folders.
- File names made safe for every file system; names already used by other files are reported, never overwritten.

### Interface
- Sync-manager window: toolbar, filters by state and destination, a table of projects with inline progress, speed and time left, an inspector (overview, live activity, failed files with **Retry**, duplicates, project settings) and a status bar.
- On Page design system: colours, type, icons and components; light and dark theme, following the system by default.
- New project in three steps: the token is verified and the folder checked before saving.
- Settings in sections: start with the system, notification area icon, notifications, parallel downloads, automatic retry, theme, language, updates.

### Desktop integration
- Integrated title bar, remembered window size and position, a single instance.
- Notification area icon with the state of the projects and a quick panel; closing the window can keep the app running there.
- System notifications at the end of a sync, for failed files and errors; progress on the taskbar button and on the Dock.
- Jump list (Windows), menu bar and shortcuts (macOS), keyboard shortcuts, drop a folder on the window to create a project.

### Migration from 1.x
- Projects, folders and settings are kept; API tokens move to the system's encrypted storage. Downloaded files are reused: nothing is downloaded again.
- 1.x cannot read the migrated settings anymore.

### Development
- Electron 45, electron-vite 6, Vite 8, Vue 3.5, TypeScript 5.9, Vitest.
- CI on pull requests (typecheck, tests, build); the release workflow uses Node 22 and current actions.
- Installing the dependencies needs a Font Awesome Pro token in the user `.npmrc`; CI reads it from the `FONTAWESOME_NPM_AUTH_TOKEN` repository secret.
