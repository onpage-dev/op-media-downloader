# Changelog

## 2.0.0

A new app: a desktop sync manager for On Page media, written in Rust with Tauri around a download service that other On Page apps can use.

### Download service

- `op-media-service` (`crates/op-media-service`), a Rust library on a runtime of its own: the window never freezes, also with 100k+ files or slow network folders. A job that fails unexpectedly ends with an error on its project; the others go on. op-media-sync will build on it.
- **Incremental listing**: after the first full read, only new and changed items are read from On Page (`ids()` + `_updated_at`), with a local cache; paged requests, retries with backoff and respect of the API rate limits (HTTP 429).
- **One plan** per sync: what to download, relink and remove, computed once and shown before downloading.
- Downloads with the system's proxy settings and the certificates it trusts (proxy auto-configuration scripts are not read), 4 at a time by default, with timeouts, retries, size checks and atomic renames; **Stop** aborts the transfers in flight.
- **Safe removals**: the app only removes what it created (`data/manifest.json`); files of other people or apps in the folder are never touched, also when a project is deleted. Large removals wait for a confirmation, which covers exactly the files the user was shown. Nothing is removed after an incomplete listing, and the project says which collections were not read.
- The registry of created files is saved during the run (atomically), so an interrupted session resumes without redoing the work.
- A folder lock prevents two computers from syncing the same folder at the same time, also when their clocks differ; a computer that loses the lock stops at once, without touching the folder again.
- **One On Page project per folder**: the folder's registry names its On Page project. A token of another project stops before touching anything; when the user chooses the folder for it (a new project, another token or folder, or «Use this folder»), the folder follows the new project. Deleting a project's files leaves alone a folder another project took over.
- Built for real folders: full disks, shares that drop, unplugged disks, read-only folders, antivirus and files open in other programs, disks without hard links. Files are flushed to the disk before they get their name, free space is checked before downloading, a registry written by a newer version of the app is left as it is. The main cases are covered by end-to-end tests against a fake On Page server, which also runs alone to try the app without real data.
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
- Failed files and duplicate names come a page at a time, with a search: projects with tens of thousands of them stay fast. A name shared by many files shows its first 10 (**Show 100 more** for the next ones), and the rows show at once: the names of the items that use them arrive from On Page right after.

### Desktop integration

- A new app icon with the current On Page mark, drawn for each system: Apple's rounded square on macOS, a tile that still reads at 16 px on Windows, GNOME's grid on Linux. In the macOS menu bar the mark takes the menu bar's colour, like the system's icons: a hollow dot while syncing, a full one when a project needs a look. In dark mode the window shows it on a dark tile, and so does the Windows notification area when the taskbar is dark.
- Integrated title bar (the window controls drawn by the app on Windows and Linux), remembered window size and position, a single instance.
- Notification area icon with the state of the projects and a quick panel; closing the window can keep the app running there.
- System notifications at the end of a sync, for failed files and errors; progress on the taskbar button and on the Dock.
- Menu bar and shortcuts (macOS), keyboard shortcuts, drop a folder on the window to create a project.
- A settings file that cannot be read is set aside and the app starts clean, saying where it went; a failure at start-up shows a message with the log instead of leaving the app running without a window.

### Terminal and AI agents

- `opmd`, the command line: everything the app does with its projects (add, edit, remove, **Sync**, **Download**, **Retry failed**, **Confirm**, stop, activity, failed files, duplicates, folder and token checks, settings), with progress and clean stops, JSON output and exit codes for scripts. With the app open it hands the commands to it; with the app closed it works on its own, on the same projects. With `--data-dir` it keeps projects of its own, for a server without the app (`OPMD_NO_KEYRING` keeps the tokens in its settings file where there is no credential store).
- An MCP server for AI agents with the same operations as tools (those that delete files marked as destructive): in the app while it is open (_Settings › AI agents_, on this computer only, with a secret; a button copies the command for Claude Code), and `opmd mcp`, which an agent can start with the app open or closed.
- The app and `opmd` share the settings file safely: changes are merged under a lock, and the app shows the other's changes within a second.
- `opmd` comes with the app: on the PATH on Windows (the installer adds it and the uninstaller takes it off), in `/usr/bin` with the .deb, inside the app on macOS (the settings show the link to make). Each release also has `opmd` alone for Linux and Windows servers.

### Security

- API tokens in the system's credential store (Windows Credential Manager, macOS Keychain, Secret Service on Linux), one entry per project, never in the settings file (unless the system has none: then the file is its owner's only on Unix).
- The MCP server for agents listens on 127.0.0.1 only, refuses web pages (`Origin`) and requests without the app's secret; no tool ever answers a token.
- The interface runs in the system's webview with a strict Content Security Policy; each of its commands has a permission of its own, granted to the app's windows only, and every argument is validated.
- Only https links to On Page and GitHub open from the app.
- A native binary: no Node.js runtime, no JavaScript outside the interface.

### Migration from 1.x

- On its first start 2.0 copies the projects, folders and settings of 1.x, whose folder is left as it is; API tokens move to the system's credential store. Downloaded files are reused: nothing is downloaded again.
- The 2.0 installer installs beside 1.x: uninstall 1.x once 2.0 shows your projects.

### Development

- Rust with Tauri 2.12 (the app) and Tokio (the download service); Vite 8, Vue 3.5, Tailwind CSS 4, TypeScript 6, ESLint 10, Vitest 5 for the interface.
- Clippy with warnings as errors, strict types (no implicit `any`) and type-aware lint: a promise nobody handles is an error. 135 tests: the download service (15 end to end against the fake On Page), the app and the interface.
- CI on Windows, macOS and Linux: dependency audit, typecheck, lint, rustfmt and Prettier, Clippy, tests, build and an unsigned package. Rust stable and Node 24; actions pinned by commit, Dependabot for dependencies and actions.
- Releases from a tag `vX.Y.Z`: Windows, macOS (signed and notarized) and Linux installers with SHA-256 checksums and build provenance, published only once every installer is attached; secrets reach only the steps that need them.
- Third-party notices (`THIRD_PARTY_NOTICES.txt`, with the Rust crates and the fonts' OFL) are generated at build time and shipped with the app.
- Building needs no token: without one the app uses Font Awesome Free icons. With the `FONTAWESOME_NPM_AUTH_TOKEN` secret (CI, releases) the Pro light icons of the design system are generated at build time, never committed.
- README with screenshots of the app on demo data.
