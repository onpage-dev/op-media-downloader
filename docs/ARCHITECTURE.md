# On Page Media Downloader 2 — Architecture

The app keeps a local or network folder in sync with the files of the media fields of an On Page project, read through an API token (which honours the token's View).

## Parts

One process, built with Tauri 2: Rust for everything but the interface, which runs in the system's webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux).

| Part         | Code                      | Owns                                                                                                                                                                                                                                                         |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **App**      | `src-tauri`               | Windows (title bar drawn by the page, native controls on macOS), tray icon and panel, notifications, taskbar/Dock progress, macOS menu, settings and projects store (tokens in the system's credential store), the import from 1.x, the commands of the page |
| **Service**  | `crates/op-media-service` | Everything that touches On Page or the folders: listing, scanning, planning, downloading, linking, removing, folder inspection, token checks. A library on its own Tokio runtime, meant for op-media-sync too                                                |
| **Renderer** | `src/renderer`            | The sync-manager UI: toolbar, filters, jobs table, inspector, status bar, dialogs, tray panel view. `window.desktop` (`src/renderer/src/desktop/tauri.ts`) maps `src/shared/desktop-api.ts` to the app's commands and events                                 |

Contracts: `src/shared/models.ts` (domain, the same JSON as `crates/op-media-service/src/models.rs`), `src/shared/desktop-api.ts` (renderer ⇄ app), `src/shared/status.ts` (one vocabulary of states for every surface; the app has its Rust twin for the tray and the notifications). Each command of the page has its own Tauri permission, granted to the app's two windows only (`src-tauri/capabilities`); the page loads nothing but its own files (CSP in `tauri.conf.json`).

The app never does file system work on project folders on its own threads: the service runs it on its runtime, where a share that hangs keeps a blocking thread waiting and nothing else (minutes of CPU and I/O with 100k+ files never freeze the window).

## Projects and storage

- **App store** (`op-media-downloader-config.json` in the app's data folder, the same file as 1.x and 2.0): settings, project configurations, the last plan summary and result of each project (so the window shows them even when a network folder is offline). The tokens are in the system's credential store, one entry per project id (in the file only where there is none).
- **Listing cache** (`<data>/cache/<project-id>.json.gz`): what the last complete listing found, for incremental listings and for the duplicates tab after a restart. Local and per machine. In memory the service keeps the last listing and its names (100+ MB with 200k files) for 30 minutes only, the time «Scarica» reuses them; then they are dropped.
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
{
  "version": 2,
  "project_id": "…",
  "onpage_project": { "id": 77, "label": "Catalogo" },
  "updated_at": "…",
  "files": { "Product-123.jpg": { "token": "…", "size": 845123, "mode": "link", "remote_name": "Product-123.jpg" } }
}
```

## Safety rules (never break these)

1. **The app only removes what it created**: names listed in `manifest.json` and contents in `data/`. Any other entry of the folder is never modified, renamed or deleted, by syncs or by deleting a project.
2. **A name that exists in the folder but is not in the manifest is never overwritten.** It is adopted (added to the manifest) only when it is the same file as `data/<token>` (same inode) or has exactly the expected size; otherwise it is a _conflict_, reported and left alone.
3. **Removals above a threshold wait for the user**: more than 50 names _and_ more than 25% of the manifest → the plan stops at `cleanup_needs_confirmation` (protects against a wrong token, a changed View or a half-read listing). A confirmation covers exactly the names the plan held back when the user saw it, and lasts one job: a removal outside those names (a View that shrank again) counts against the threshold again.
4. **No removal after an incomplete listing**: if any resource could not be read, the plan has downloads and links only, and the project shows `listing_incomplete` (the collections not read, three at most, then "+N") until a complete listing.
5. **Never on protected folders**: drive roots, the home folder, system folders, a folder used by (or nested in / around) another project.
6. **One writer per folder**: `data/.lock` with host, pid, instance and a heartbeat every 30 s. A lock that looks stale (no heartbeat for 2 minutes by its own clock) is watched for one more heartbeat before it is taken, because two computers' clocks can differ; a lock of this computer whose process is gone is taken at once. A run whose heartbeat cannot be written for most of the stale time, or whose lock was taken by another computer, stops at once (`folder_locked`): the transfers in flight abort, nothing more is linked, removed or written to the manifest, and the registry is left to the new owner.
7. **Nothing half-written under a name**: a download goes to `<token>.<random>.download`, every byte written, the size checked, the file flushed to the disk, then renamed (retrying the transient Windows locks EPERM/EBUSY/EACCES); copies go through a `.opmd-` temporary name the same way; the manifest and the lock are written to a temporary file, flushed, then renamed. After a power cut or an unplugged disk a name holds its whole file or is not there.
8. **Never act on partial knowledge**: a manifest that exists but cannot be read now (an antivirus, a share that hiccups) stops the job instead of starting from an empty registry; a broken one (cut by a power cut) is rebuilt by adoption (rule 2), removing nothing; one written by a newer version of the app (`version` above 2) stops the job (`folder_protected`) and is left as it is.
9. **One On Page project per folder**: the manifest names the On Page project of the folder (`onpage_project`, by id: a renamed project keeps its folder and the label follows). A new folder gets it with its first file, so a «Sincronizza» alone still leaves no trace; a manifest that exists gets it at the next write. A job whose token is of another On Page project stops before anything is linked, removed or written (`folder_other_project`, the detail names the folder's project), unless the user chose the folder for this token: a new project, another token or another folder in the project's settings, or «Usa questa cartella» on the issue. The app keeps that choice (`take_over_folder`) until a job finds the manifest on the disk naming the token's project; from then on the names of the old project are removals like any other (rules 1 and 3, or kept with `keep_old_files`). Two computers syncing the same On Page project share a folder as before.

## Core flows

### «Sincronizza» (`sync`)

1. **Prepare**: inspect the folder (reachable, writable, not protected), take the lock, remove orphan `*.download`, load the manifest (or migrate `link.json`), load the listing cache.
2. **List** (On Page): load the schema; signature = media fields per resource + langs + view. For each resource with media fields, `ids()` of the things with at least one media value. Read the things that are new (not in the cache) or changed (`_updated_at` after the last complete listing, minus a 10 minute margin); everything when there is no cache, the signature changed, the cache is older than 7 days or the user asks for a full listing. On Page updates a thing's `_updated_at` whenever the value of one of its media fields changes, file name included (confirmed by On Page). Pages of 1,000 ids, 2 in parallel, only the media fields. Each request is retried (up to 6 attempts, 2 minutes per attempt) with exponential backoff and jitter on network errors, timeouts, 5xx and **429**; on 429 the wait is the longer of the backoff and `Retry-After` (capped at 2 minutes), and the project shows `rate_limited` meanwhile. The parallelism does not change. A collection that keeps failing makes the listing incomplete (rule 4; it keeps what the cache knew); a refused token or no network ends the listing; all collections failing is `listing_failed`. The cache is replaced only after a complete listing.
3. **Resolve names**: deterministic order (resources and fields in schema order, things by id, langs in schema order, files in value order); the first file of each case-insensitive name wins, the others become a **duplicate group**. Names are made safe for Windows on every platform (no path separators or `..`, no `<>:"/\|?*` and control characters, no reserved names, no trailing dots or spaces, at most 200 UTF-8 bytes keeping the extension); names that collide after this are duplicates too. Linear in the number of files, also when a name's file is used by 100k things.
4. **Scan**: first the folder's On Page project (rule 9); then one asynchronous listing of the folder and one of `data/`; `stat` only to decide an adoption (rule 2). «Scarica» and «Conferma» go through the same compare.
5. **Plan** (pure function, unit tested on 100k+ synthetic files): contents to download (one per token), names to link or relink, names and contents to remove (only with `keep_old_files` off, rules 1, 3, 4), names up to date, conflicts.
6. When nothing needs downloading, links and removals are applied right away (within the threshold) and the sync is a completed run. Otherwise the project waits in «Da scaricare» with the plan.

### «Scarica» (`download`)

Reuses the listing of the last «Sincronizza» when it is younger than 30 minutes (lists again otherwise), compares the folder again, then:

1. **Download** the tokens, `concurrency` at a time (setting, default 4): reqwest with rustls and the system's root certificates, the proxy of the environment (`HTTPS_PROXY`…) and of the system settings on Windows and macOS (PAC scripts are not read), 30 s to the first byte, 60 s without data aborts; up to 4 attempts with backoff for network errors, timeouts, 5xx and 429; 404 is final (`not_found`). Each token is downloaded once, then linked to all its names. The disk work of a download (the temporary file, the writes, the flush, the rename) is never retried as network work: its errors go through the folder checks of the fault table, and the HTTP connection is closed at once.
2. **Link**: a hard link, or a copy where the folder does not take hard links (the project gets the `copies_instead_of_links` warning). Decided once per job by a probe link inside `data/` (a temporary file, linked, both removed); a name that cannot be linked fails alone.
3. **Remove** what the plan allows.
4. Checkpoint the manifest when 500 changes piled up and 5 s passed since the last write, or after 30 s with any change, never more often than ten times what the last write took (a big manifest on a slow share); at the end write it (3 attempts), release the lock and send the result.

**Stop** aborts the transfers in flight, deletes their temp files and saves the manifest; what is left (the plan of the next «Scarica») comes from the plan and the manifest, without reading the folder again. A stop also ends at once the wait for a lock that looks stale and for a folder that does not answer. The phase stays «Interruzione» until the job ends.

### «Conferma» (`confirm_cleanup`)

Removes the names the plan held back when the user saw them (rule 3), and only those; a removal outside them waits again above the threshold. With nothing to download it applies the whole plan, like «Sincronizza»; otherwise only the removals, and the downloads and links wait for «Scarica». The confirmation ends with the job, whatever its outcome; one sent while another job runs is ignored.

### Deleting a project's files (`delete_project_files`)

Refused while a job of the project runs (`project_busy`); no job of the project starts while it runs. Refused too, with nothing removed, when the manifest names another On Page project than the one the project last synced (`folder_other_project`): the folder was taken over since, and its names are that project's now. The folder lock is held until `data/` is empty and `.lock` goes last, then `data/` itself and the folder when nothing else is left in it. Only names of the manifest (as the disk gives them back, NFC or NFD) and the app's entries of `data/` are removed, a few at a time.

### Faults of folders and disks

The service (`crates/op-media-service`) handles every case below: `error.rs` names each file system error by its POSIX code as libuv does on every system (a Windows `ERROR_NETNAME_DELETED` is `ECONNRESET`, `ERROR_SHARING_VIOLATION` is `EBUSY`…) and decides what it means. After any of them no name holds half a file, the issue is the right one, and the next run ends the work. The cases that the fake On Page and a real folder can produce have an end-to-end test (`crates/op-media-service/src/engine/tests.rs`: stop, cut connections, 429, 404, a broken or newer registry, another computer's lock, leftovers, conflicts, incomplete listings); the decisions on codes have unit tests. The fault-injection suite of 2.0 (a mocked file system: disk full in the middle of a write, a share that drops, EIO) is not ported yet.

| Fault                                                                                                                                              | What happens                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Not enough free space for the plan                                                                                                                 | Checked before downloading: `disk_full` with the bytes needed, nothing downloaded                                                                                                                                                                                  |
| Disk full during the run (ENOSPC, EDQUOT)                                                                                                          | The run stops: `disk_full`; the transfers in flight stop, the files done stay                                                                                                                                                                                      |
| ENOSPC with room left (4 GB limit of FAT32), EFBIG                                                                                                 | That file fails (`file_too_large`), its connection is closed, the run goes on                                                                                                                                                                                      |
| A share drops or stops answering, a disk is unplugged, the folder is deleted (ENOENT, EIO, ENXIO, ENODEV, ESTALE, ECONNRESET, ETIMEDOUT, UNKNOWN…) | When the folder does not answer within 15 s: `folder_unreachable`, the transfers in flight stop; otherwise that file fails and the run goes on. A share's socket error on a write (ECONNRESET, ETIMEDOUT, EPIPE) is the folder's, never retried as a network error |
| Read-only folder (EACCES, EPERM, EROFS)                                                                                                            | When a probe file cannot be created: `folder_not_writable`; otherwise that file fails                                                                                                                                                                              |
| An antivirus or the indexer holding a new file                                                                                                     | Retried for up to ~8 s                                                                                                                                                                                                                                             |
| Windows: a file open in another program                                                                                                            | Not replaced or removed now (`in_use`); it stays in the registry and the next run retries                                                                                                                                                                          |
| A write that takes fewer bytes than given                                                                                                          | Written in a loop                                                                                                                                                                                                                                                  |
| A content with more than 1023 names (NTFS)                                                                                                         | That name gets a copy; the others stay links                                                                                                                                                                                                                       |
| FAT, exFAT, SMB without hard links                                                                                                                 | Found by the probe link in `data/`: every name is a copy (through a temporary name); `copies_instead_of_links`                                                                                                                                                     |
| A name the folder refuses to link (EINVAL…) where links work                                                                                       | That name fails (`link_error`); the others stay links                                                                                                                                                                                                              |
| Another computer takes the folder during the run                                                                                                   | The transfers in flight stop; nothing more is linked, removed or registered; `folder_locked`; its lock stays                                                                                                                                                       |
| Leftovers of a crash (`*.download`, `.opmd-*`, temporary manifest and lock)                                                                        | Removed at the next run; one that cannot be removed never blocks a download                                                                                                                                                                                        |
| Manifest that cannot be saved at the end                                                                                                           | The run fails (the files stay); the next run registers them by adoption                                                                                                                                                                                            |
| Manifest of a newer version of the app                                                                                                             | The job ends: `folder_protected` («synced by a newer version of the app»); the manifest is left as it is                                                                                                                                                           |
| Errors of the file system before the work starts (lock, manifest, scan)                                                                            | Mapped to the issues above, never «file list not read»; unknown errors are `unexpected` with the detail                                                                                                                                                            |

### Progress and activity

- Counters per name, bytes from `Content-Length` or the known size, speed smoothed over ~5 s, ETA from the remaining bytes. State sent at most 4 times per second per project.
- Activity: the last 1,000 events per project (downloading with progress, downloaded, linked, removed, failed, conflict), sent in batches every 250 ms; an event that left the 1,000 leaves the next batch too. Failed files are kept in full for «Riprova i falliti».
- The counts of the plan's warnings (duplicates, name conflicts, removals to confirm) are read from the plan summary the app gets, so the two always agree.

### Service modules

`crates/op-media-service`, a library the app embeds (and op-media-sync can):

| Module                                                                 | Does                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/mod.rs`                                                        | `MediaService`: its own Tokio runtime, a slot per project, starts, stops and forgets jobs (one per project), answers the requests      |
| `engine/slot.rs`                                                       | A job (the user's stop and its own failure, one cancellation token), the project slot, the runtime the app sees: throttled, in batches |
| `engine/flows.rs`, `engine/session.rs`                                 | «Sincronizza», «Scarica» (also «Riprova i falliti»), «Conferma»; a job's hold on the folder: checks, lock, manifest, plan, final save  |
| `sync/listing.rs`, `sync/names.rs`, `sync/plan.rs`, `sync/executor.rs` | Read On Page, resolve the names, plan (pure), execute the plan                                                                         |
| `sync/listing_store.rs`, `sync/remote_index.rs`                        | The last listing in memory (30 minutes) and the gzip cache on disk                                                                     |
| `sync/duplicates.rs`, `sync/activity.rs`, `sync/progress.rs`           | The duplicates tab, the activity and the failed files, counters and speed                                                              |
| `folder/`                                                              | Lock, manifest, scan, links or copies, the owner of `data/`, folder inspection, deleting a project's files                             |
| `onpage.rs`, `transfer.rs`, `http.rs`, `fsx.rs`                        | The On Page API (onpage-js's calls), one atomic download, retries, file system helpers                                                 |
| `testing.rs`, `bin/fake_onpage.rs`                                     | The fake On Page for tests and for trying the app (`cargo run -p op-media-service --features fake-server --bin fake-onpage`)           |

A job that panics ends as an `unexpected` failure; the others go on.

## States

`src/shared/status.ts` turns a project into one of the keys of the state vocabulary (Aggiornato, Da scaricare, In corso, Interruzione, Attenzione, Errore, Mai sincronizzato, Offline) with its tone, used by the table, the inspector, the tray, the taskbar and the notifications.

## Migration from 1.x

On its first start the installed app copies the Electron app's settings file and listing caches from its folder (`op-media-downloader` or `On Page Media Downloader` in the system's config folder), which stays as it is. It then reads the 1.x keys (`storage_data`, `user_properties`) when there are some: every project keeps its id, label, folder and `keep_old_files`; `simultaneous_downloads` becomes `concurrency` (at least 4 if it was the 1.x default of 1), `dark_mode` becomes the theme. Tokens in clear (1.x), and those the Electron previews of 2.0 encrypted with `safeStorage` (Chromium's os_crypt: the key protected by DPAPI in `Local State` on Windows, the Keychain on macOS, the fixed key of `v10` on Linux) move to the credential store; a token that cannot be decrypted on this computer leaves the project asking for one. The service imports `data/link.json` into `data/manifest.json` the first time it works on a folder, and names the On Page project of the folder then (rule 9). Development builds never read the installed app's data: they use `op-media-downloader-dev` or `OPMD_USER_DATA`, and credential entries of their own.
