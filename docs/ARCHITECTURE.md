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
- **Listing cache** (`userData/cache/<project-id>.json.gz`): what the last complete listing found, for incremental listings and for the duplicates tab after a restart. Local and per machine. In memory the engine keeps the last listing and its names (100+ MB with 200k files) for 30 minutes only, the time «Scarica» reuses them; then they are dropped.
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
3. **Removals above a threshold wait for the user**: more than 50 names *and* more than 25% of the manifest → the plan stops at `cleanup_needs_confirmation` (protects against a wrong token, a changed View or a half-read listing). A confirmation covers exactly the names the plan held back when the user saw it, and lasts one job: a removal outside those names (a View that shrank again) counts against the threshold again.
4. **No removal after an incomplete listing**: if any resource could not be read, the plan has downloads and links only, and the project shows `listing_incomplete` (the collections not read, three at most, then "+N") until a complete listing.
5. **Never on protected folders**: drive roots, the home folder, system folders, a folder used by (or nested in / around) another project.
6. **One writer per folder**: `data/.lock` with host, pid, instance and a heartbeat every 30 s. A lock that looks stale (no heartbeat for 2 minutes by its own clock) is watched for one more heartbeat before it is taken, because two computers' clocks can differ; a lock of this computer whose process is gone is taken at once. A run whose heartbeat cannot be written for most of the stale time, or whose lock was taken by another computer, stops at once (`folder_locked`): the transfers in flight abort, nothing more is linked, removed or written to the manifest, and the registry is left to the new owner.
7. **Nothing half-written under a name**: a download goes to `<token>.<random>.download`, every byte written, the size checked, the file flushed to the disk, then renamed (retrying the transient Windows locks EPERM/EBUSY/EACCES); copies go through a `.opmd-` temporary name the same way; the manifest and the lock are written to a temporary file, flushed, then renamed. After a power cut or an unplugged disk a name holds its whole file or is not there.
8. **Never act on partial knowledge**: a manifest that exists but cannot be read now (an antivirus, a share that hiccups) stops the job instead of starting from an empty registry; a broken one (cut by a power cut) is rebuilt by adoption (rule 2), removing nothing; one written by a newer version of the app (`version` above 2) stops the job (`folder_protected`) and is left as it is.

## Core flows

### «Sincronizza» (`sync`)
1. **Prepare**: inspect the folder (reachable, writable, not protected), take the lock, remove orphan `*.download`, load the manifest (or migrate `link.json`), load the listing cache.
2. **List** (On Page): load the schema; signature = media fields per resource + langs + view. For each resource with media fields, `ids()` of the things with at least one media value. Read the things that are new (not in the cache) or changed (`_updated_at` after the last complete listing, minus a 10 minute margin); everything when there is no cache, the signature changed, the cache is older than 7 days or the user asks for a full listing. On Page updates a thing's `_updated_at` whenever the value of one of its media fields changes, file name included (confirmed by On Page). Pages of 1,000 ids, 2 in parallel, only the media fields. Each request is retried (up to 6 attempts, 2 minutes per attempt) with exponential backoff and jitter on network errors, timeouts, 5xx and **429**; on 429 the wait is the longer of the backoff and `Retry-After` (capped at 2 minutes), and the project shows `rate_limited` meanwhile. The parallelism does not change. A collection that keeps failing makes the listing incomplete (rule 4; it keeps what the cache knew); a refused token or no network ends the listing; all collections failing is `listing_failed`. The cache is replaced only after a complete listing.
3. **Resolve names**: deterministic order (resources and fields in schema order, things by id, langs in schema order, files in value order); the first file of each case-insensitive name wins, the others become a **duplicate group**. Names are made safe for Windows on every platform (no path separators or `..`, no `<>:"/\|?*` and control characters, no reserved names, no trailing dots or spaces, at most 200 UTF-8 bytes keeping the extension); names that collide after this are duplicates too. Linear in the number of files, also when a name's file is used by 100k things.
4. **Scan**: one asynchronous listing of the folder and one of `data/`; `stat` only to decide an adoption (rule 2).
5. **Plan** (pure function, unit tested on 100k+ synthetic files): contents to download (one per token), names to link or relink, names and contents to remove (only with `keep_old_files` off, rules 1, 3, 4), names up to date, conflicts.
6. When nothing needs downloading, links and removals are applied right away (within the threshold) and the sync is a completed run. Otherwise the project waits in «Da scaricare» with the plan.

### «Scarica» (`download`)
Reuses the listing of the last «Sincronizza» when it is younger than 30 minutes (lists again otherwise), compares the folder again, then:
1. **Download** the tokens, `concurrency` at a time (setting, default 4): Electron `net.fetch` (system proxy and PAC, like the browser), 30 s to the first byte, 60 s without data aborts; up to 4 attempts with backoff for network errors, timeouts, 5xx and 429; 404 is final (`not_found`). Each token is downloaded once, then linked to all its names. The disk work of a download (the temporary file, the writes, the flush, the rename) is never retried as network work: its errors go through the folder checks of the fault table, and the HTTP connection is closed at once.
2. **Link**: a hard link, or a copy where the folder does not take hard links (the project gets the `copies_instead_of_links` warning). Decided once per job by a probe link inside `data/` (a temporary file, linked, both removed); a name that cannot be linked fails alone.
3. **Remove** what the plan allows.
4. Checkpoint the manifest when 500 changes piled up and 5 s passed since the last write, or after 30 s with any change, never more often than ten times what the last write took (a big manifest on a slow share); at the end write it (3 attempts), release the lock and send the result.

**Stop** aborts the transfers in flight, deletes their temp files and saves the manifest; what is left (the plan of the next «Scarica») comes from the plan and the manifest, without reading the folder again. A stop also ends at once the wait for a lock that looks stale and for a folder that does not answer. The phase stays «Interruzione» until the job ends.

### «Conferma» (`confirm_cleanup`)
Removes the names the plan held back when the user saw them (rule 3), and only those; a removal outside them waits again above the threshold. With nothing to download it applies the whole plan, like «Sincronizza»; otherwise only the removals, and the downloads and links wait for «Scarica». The confirmation ends with the job, whatever its outcome; one sent while another job runs is ignored.

### Deleting a project's files (`delete_project_files`)
Refused while a job of the project runs (`project_busy`); no job of the project starts while it runs. The folder lock is held until `data/` is empty and `.lock` goes last, then `data/` itself and the folder when nothing else is left in it. Only names of the manifest (as the disk gives them back, NFC or NFD) and the app's entries of `data/` are removed, a few at a time.

### Faults of folders and disks
Every case below has a fault-injection test (`src/engine/faults.test.ts`; the connection closed on a disk error in `download.test.ts`): after it, no name holds half a file, the issue is the right one, and the next run ends the work.

| Fault | What happens |
|---|---|
| Not enough free space for the plan | Checked before downloading: `disk_full` with the bytes needed, nothing downloaded |
| Disk full during the run (ENOSPC, EDQUOT) | The run stops: `disk_full`; the transfers in flight stop, the files done stay |
| ENOSPC with room left (4 GB limit of FAT32), EFBIG | That file fails (`file_too_large`), its connection is closed, the run goes on |
| A share drops or stops answering, a disk is unplugged, the folder is deleted (ENOENT, EIO, ENXIO, ENODEV, ESTALE, ECONNRESET, ETIMEDOUT, UNKNOWN…) | When the folder does not answer within 15 s: `folder_unreachable`, the transfers in flight stop; otherwise that file fails and the run goes on. A share's socket error on a write (ECONNRESET, ETIMEDOUT, EPIPE) is the folder's, never retried as a network error |
| Read-only folder (EACCES, EPERM, EROFS) | When a probe file cannot be created: `folder_not_writable`; otherwise that file fails |
| An antivirus or the indexer holding a new file | Retried for up to ~8 s |
| Windows: a file open in another program | Not replaced or removed now (`in_use`); it stays in the registry and the next run retries |
| A write that takes fewer bytes than given | Written in a loop |
| A content with more than 1023 names (NTFS) | That name gets a copy; the others stay links |
| FAT, exFAT, SMB without hard links | Found by the probe link in `data/`: every name is a copy (through a temporary name); `copies_instead_of_links` |
| A name the folder refuses to link (EINVAL…) where links work | That name fails (`link_error`); the others stay links |
| Another computer takes the folder during the run | The transfers in flight stop; nothing more is linked, removed or registered; `folder_locked`; its lock stays |
| Leftovers of a crash (`*.download`, `.opmd-*`, temporary manifest and lock) | Removed at the next run; one that cannot be removed never blocks a download |
| Manifest that cannot be saved at the end | The run fails (the files stay); the next run registers them by adoption |
| Manifest of a newer version of the app | The job ends: `folder_protected` («synced by a newer version of the app»); the manifest is left as it is |
| Errors of the file system before the work starts (lock, manifest, scan) | Mapped to the issues above, never «file list not read»; unknown errors are `unexpected` with the detail |

### Progress and activity
- Counters per name, bytes from `Content-Length` or the known size, speed smoothed over ~5 s, ETA from the remaining bytes. State sent at most 4 times per second per project.
- Activity: the last 1,000 events per project (downloading with progress, downloaded, linked, removed, failed, conflict), sent in batches every 250 ms; an event that left the 1,000 leaves the next batch too. Failed files are kept in full for «Riprova i falliti».
- The counts of the plan's warnings (duplicates, name conflicts, removals to confirm) are read from the plan summary main gets, so the two always agree.

### Engine modules

| Module | Does |
|---|---|
| `index.ts` | The utility process: `net.fetch`, the port to main; an uncaught exception is logged and ends the process (main starts a new one) |
| `engine.ts`, `timings.ts` | Routes the messages, keeps a slot per project, starts, stops and forgets jobs (one per project), answers the requests; the timings and limits |
| `job.ts` | A job (the user's stop and its own abort on a fatal error or a lost lock, as one signal), the project slot, what a job sees of the engine |
| `state.ts` | The runtime main sees: phase, plan, progress, issues; throttled, activity in batches |
| `flows/` | `sync.ts`, `download.ts` (also «Riprova i falliti»), `cleanup.ts`; `steps.ts`: listing, compare, execution, results |
| `folder-session.ts` | A job's hold on the folder: checks, lock, manifest, scan and plan, the guard on every write, final save, release |
| `listing-store.ts` | The last listing in memory (30 minutes) and the gzip cache on disk |
| `listing.ts`, `names.ts`, `plan.ts`, `executor.ts` | Read On Page, resolve the names, plan (pure), execute the plan |
| `duplicates.ts`, `delete-files.ts`, `folder-inspect.ts` | The duplicates tab, deleting a project's files, the folder checks of the project form |
| `onpage.ts`, `http.ts` | onpage-js behind our transport (fetch adapter, timeouts, retries) |

## States

`src/shared/status.ts` turns a project into one of the keys of the state vocabulary (Aggiornato, Da scaricare, In corso, Interruzione, Attenzione, Errore, Mai sincronizzato, Offline) with its tone, used by the table, the inspector, the tray, the taskbar and the notifications.

## Migration from 1.x

On first start main reads the 1.x store (`storage_data`, `user_properties`): every project keeps its id, label, folder and `keep_old_files`; the token moves to encrypted storage; `simultaneous_downloads` becomes `concurrency` (at least 4 if it was the 1.x default of 1), `dark_mode` becomes the theme. The engine imports `data/link.json` into `data/manifest.json` the first time it works on a folder.
