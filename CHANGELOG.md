# Changelog

## 2.0.0

A new app: a desktop sync manager for On Page media, rebuilt around a sync engine that runs in its own process.

### Sync engine

- Runs in an Electron utility process: the window never freezes, also with 100k+ files or slow network folders. If the engine ever crashes, a new one takes its place.
- **Incremental listing**: after the first full read, only new and changed items are read from On Page (`ids()` + `_updated_at`), with a local cache; paged requests, retries with backoff and respect of the API rate limits (HTTP 429).
- **One plan** per sync: what to download, relink and remove, computed once and shown before downloading.
- Downloads through Chromium's network stack (system proxy and PAC), 4 at a time by default, with timeouts, retries, size checks and atomic renames; **Stop** aborts the transfers in flight.
- **Safe removals**: the app only removes what it created (`data/manifest.json`); files of other people or apps in the folder are never touched, also when a project is deleted. Large removals wait for a confirmation, which covers exactly the files the user was shown. Nothing is removed after an incomplete listing, and the project says which collections were not read.
- The registry of created files is saved during the run (atomically), so an interrupted session resumes without redoing the work.
- A folder lock prevents two computers from syncing the same folder at the same time, also when their clocks differ; a computer that loses the lock stops at once, without touching the folder again.
- **One On Page project per folder**: the folder's registry names its On Page project. A token of another project stops before touching anything; when the user chooses the folder for it (a new project, another token or folder, or «Use this folder»), the folder follows the new project. Deleting a project's files leaves alone a folder another project took over.
- Built for real folders: full disks, shares that drop, unplugged disks, read-only folders, antivirus and files open in other programs, disks without hard links. Files are flushed to the disk before they get their name, free space is checked before downloading, a registry written by a newer version of the app is left as it is, and every case is covered by a fault-injection test.
- Folder checks: network or local, hard link support (copies take twice the space), free space, protected and overlapping folders, the On Page project the folder already belongs to.
- File names made safe for every file system; names already used by other files are reported, never overwritten.
- Deleting a project with its files runs in the background, with the folder locked until the end: the project leaves the list at once.

### Interface

- Sync-manager window: toolbar, filters by state and destination, a table of projects with inline progress, speed and time left, an inspector (overview, live activity, failed files with **Retry**, duplicates, project settings) and a status bar.
- On Page design system: colours, type, icons and components; light and dark theme, following the system by default.
- New project in three steps: the token is verified and the folder checked before saving.
- Settings in sections: start with the system, notification area icon, notifications, parallel downloads, automatic retry, theme, language, updates (with the licenses of the third-party software).
- The languages of On Page UI: Italian, English, German, Spanish, French, Russian, Swedish and Chinese; a new install starts in the system's language. Dates, sizes, speeds and durations are written the way each language writes them.
- Errors in plain words, in the window and in the forms, never raw system messages.
- Everything works with the keyboard: the projects table, menus, tabs and the language list; dialogs keep the focus inside, close with Esc and give it back. Shortcuts work with any keyboard layout.
- Failed files and duplicate names come a page at a time, with a search: projects with tens of thousands of them stay fast.

### Desktop integration

- Integrated title bar, remembered window size and position, a single instance.
- Notification area icon with the state of the projects and a quick panel; closing the window can keep the app running there.
- System notifications at the end of a sync, for failed files and errors; progress on the taskbar button and on the Dock.
- Jump list (Windows), menu bar and shortcuts (macOS), keyboard shortcuts, drop a folder on the window to create a project.
- A settings file that cannot be read is set aside and the app starts clean, saying where it went; a failure at start-up shows a message with the log instead of leaving the app running without a window; a window whose page crashes reloads.

### Security

- API tokens encrypted with the system's credential store.
- A sandboxed interface with a strict Content Security Policy and a narrow bridge to the rest of the app, whose every call is validated.
- Only https links to On Page and GitHub open from the app; every web permission, device and screen capture request is denied; the installed app refuses debugger switches.
- Electron fuses: no Node mode, no `NODE_OPTIONS` or `--inspect`, the app loads only from its archive, whose integrity is checked.

### Migration from 1.x

- On Windows the 2.0 installer keeps the installer id of 1.x, so it replaces 1.x instead of installing beside it.
- Projects, folders and settings are kept; API tokens move to the system's encrypted storage. Downloaded files are reused: nothing is downloaded again.
- 1.x cannot read the migrated settings anymore.

### Development

- Electron 45, electron-vite 6, Vite 8, Vue 3.5, Tailwind CSS 4, TypeScript 6, ESLint 10, Vitest 5, electron-store 12.
- Strict types (no implicit `any`) and type-aware lint: a promise nobody handles is an error. 259 tests: the engine (fault injection included), the main process and the interface.
- CI on Windows, macOS and Linux: dependency audit, typecheck, lint, formatting, tests, build and an unsigned package. Node 24, the Node of Electron 45; actions pinned by commit, Dependabot for dependencies and actions.
- Releases from a tag `vX.Y.Z`: Windows, macOS (signed and notarized) and Linux installers with SHA-256 checksums and build provenance, published only once every installer is attached; secrets reach only the steps that need them.
- Third-party notices (`THIRD_PARTY_NOTICES.txt`, with the fonts' OFL) are generated at build time and shipped with the app.
- Building needs no token: without one the app uses Font Awesome Free icons. With the `FONTAWESOME_NPM_AUTH_TOKEN` secret (CI, releases) the Pro light icons of the design system are generated at build time, never committed.
- README with screenshots of the app on demo data.
