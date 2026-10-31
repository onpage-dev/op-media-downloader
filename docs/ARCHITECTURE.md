# On Page Media Downloader 2 — Architecture

The app keeps a local or network folder in sync with the files of the media fields of an On Page project, read through an API token (which honours the token's View).

## Processes

| Process | Code | Owns |
|---|---|---|
| **Main** | `src/main` | Windows (integrated title bar), tray panel, notifications, taskbar/dock progress, menus and shortcuts, settings and projects store (tokens encrypted with `safeStorage`), migration from 1.x, the engine's lifecycle, IPC with the renderer |
| **Engine** | `src/engine` (Electron `utilityProcess`, built to `out/main/engine.js`) | Everything that touches On Page or the folders: listing, scanning, planning, downloading, linking, removing, folder inspection, token checks |
| **Preload** | `src/preload` | `window.desktop` (`src/shared/desktop-api.ts`): a narrow typed API, no `ipcRenderer`, no Node. The renderer is sandboxed |
| **Renderer** | `src/renderer` | The sync-manager UI: toolbar, filters, jobs table, inspector, status bar, dialogs, tray panel view |

Contracts live in `src/shared`: `models.ts` (domain), `engine-protocol.ts` (main ⇄ engine), `desktop-api.ts` (renderer ⇄ main), `status.ts` (one vocabulary of states for every surface).

The main process never does file system work on project folders and never blocks: the engine can take minutes of CPU and I/O (100k+ files, slow network shares) without freezing the window.

## Projects and storage

- **App store** (`electron-store`, `op-media-downloader-config.json` in `userData`, same file as 1.x): settings, project configurations, encrypted tokens, the last plan summary and result of each project (so the window shows them even when a network folder is offline).
- **Listing cache** (`userData/cache/<project-id>.json.gz`): what the last listing found, for incremental listings. Local and per machine.
- **Project folder** (local or network):

```text
<folder>/
├── data/
│   ├── <token>               content of a file, named by its On Page token (one per content)
│   ├── <token>.download      temporary while downloading, renamed when complete
│   ├── manifest.json         registry of what the app created (see below)
│   ├── .lock                 who is syncing the folder right now
│   └── link.json             1.x registry, read once for the migration and then left alone
├── Product-123.jpg           hard link to data/<token> (a copy where links are not supported)
└── …                         one name per file, flat
```

`manifest.json` (written atomically: temp file + rename; checkpointed during a run):

```json
{ "version": 2, "project_id": "…", "updated_at": "…",
  "files": { "Product-123.jpg": { "token": "…", "size": 845123, "mode": "link", "remote_name": "Product-123.jpg" } } }
```

## Safety rules (never break these)

1. **The app only removes what it created**: names listed in `manifest.json` and contents in `data/`. Any other entry of the folder is never modified, renamed or deleted, by syncs or by deleting a project.
2. **A name that exists in the folder but is not in the manifest is never overwritten.** It is adopted (added to the manifest) only when it is the same file as `data/<token>` (same inode) or has exactly the expected size; otherwise it is a *conflict*, reported and left alone.
3. **Removals above a threshold wait for the user**: more than 50 names *and* more than 25% of the manifest → the plan stops at `cleanup_needs_confirmation` (protects against a wrong token, a changed View or a half-read listing).
4. **No removal after an incomplete listing**: if any resource could not be read, the plan has downloads and links only.
5. **Never on protected folders**: drive roots, the home folder, system folders, a folder used by (or nested in / around) another project.
6. **One writer per folder**: `data/.lock` with host, pid, instance and a heartbeat every 30 s; a lock older than 2 minutes without heartbeat can be taken over.
7. **Downloads land atomically**: write `<token>.download`, check the size when known, rename (retrying EPERM/EBUSY/EACCES), then link.

## Core flows

### «Sincronizza» (`sync`)
1. **Prepare**: inspect the folder (reachable, writable, not protected), take the lock, remove orphan `*.download`, load the manifest (or migrate `link.json`), load the listing cache.
2. **List** (On Page): load the schema; signature = media fields per resource + langs + view. For each resource with media fields, `ids()` of the things with at least one media value. Read the things that are new (not in the cache) or changed (`_updated_at` after the last complete listing, minus a 10 minute margin); everything when there is no cache, the signature changed, the cache is older than 7 days or the user asks for a full listing. Pages of 1,000–2,000 ids, 2 in parallel, only the media fields. Retries with exponential backoff and jitter; on **429** wait (honouring `Retry-After` and the load metrics in the body) and lower the parallelism. The cache is replaced only after a complete listing.
3. **Resolve names**: deterministic order (resources and fields in schema order, things by id, langs in schema order, files in value order); the first file of each case-insensitive name wins, the others become a **duplicate group**. Names are made safe for Windows on every platform (no path separators or `..`, no `<>:"/\|?*` and control characters, no reserved names, no trailing dots or spaces, at most 200 characters keeping the extension); names that collide after this are duplicates too.
4. **Scan**: one asynchronous listing of the folder and one of `data/`; `stat` only to decide an adoption (rule 2).
5. **Plan** (pure function, unit tested on 100k+ synthetic files): contents to download (one per token), names to link or relink, names and contents to remove (only with `keep_old_files` off, rules 1, 3, 4), names up to date, conflicts.
6. When nothing needs downloading, links and removals are applied right away (within the threshold) and the sync is a completed run. Otherwise the project waits in «Da scaricare» with the plan.

### «Scarica» (`download`)
Re-plans first when the plan is older than 30 minutes, then:
1. **Download** the tokens, `concurrency` at a time (setting, default 4): Electron `net.fetch` (system proxy and PAC, like the browser), 30 s to the first byte, 60 s without data aborts; up to 4 attempts with backoff for network errors, timeouts, 5xx and 429; 404 is final (`not_found`). Each token is downloaded once, then linked to all its names.
2. **Link** (`link`, falling back to a copy when the folder does not support hard links; the project gets the `copies_instead_of_links` warning).
3. **Remove** what the plan allows.
4. Checkpoint the manifest every 500 operations or 5 seconds; at the end write it, release the lock and send the result.

Disk full stops the run (`disk_full`); a folder that disappears stops it (`folder_unreachable`) keeping the work done. **Stop** aborts the transfers in flight, deletes their temp files and saves the manifest.

### Progress and activity
- Counters per name, bytes from `Content-Length` or the known size, speed smoothed over ~5 s, ETA from the remaining bytes. State sent at most 4 times per second per project.
- Activity: the last 1,000 events per project (downloading with progress, downloaded, linked, removed, failed, conflict), sent in batches every 250 ms. Failed files are kept in full for «Riprova i falliti».

## States

`src/shared/status.ts` turns a project into one of the keys of the state vocabulary (Aggiornato, Da scaricare, In corso, Interruzione, Attenzione, Errore, Mai sincronizzato, Offline) with its tone, used by the table, the inspector, the tray, the taskbar and the notifications.

## Migration from 1.x

On first start main reads the 1.x store (`storage_data`, `user_properties`): every project keeps its id, label, folder and `keep_old_files`; the token moves to encrypted storage; `simultaneous_downloads` becomes `concurrency` (at least 4 if it was the 1.x default of 1), `dark_mode` becomes the theme. The engine imports `data/link.json` into `data/manifest.json` the first time it works on a folder.
