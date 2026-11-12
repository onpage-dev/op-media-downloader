# op-media-service

The download management of On Page Media Downloader as a Rust library, written to be shared by the On Page desktop
apps: Media Downloader uses all of it, op-media-sync (the DAM of the customer's projects mounted as a network folder,
synced both ways) can take the layers it needs.

```toml
[dependencies]
op-media-service = { path = "../op-media-downloader/crates/op-media-service" }
```

## Layers

| Module         | What it gives                                                                                                    | Reusable as is         |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `http`         | Retry policies, exponential backoff with jitter, `Retry-After` within a limit, cancellation at every wait        | yes                    |
| `onpage`       | The On Page API through a token, as onpage-js speaks it: schema, `things` queries (ids, pages), storage links    | yes (DAM calls to add) |
| `transfer`     | One URL to one file, atomically: temporary name, timeouts before the first byte and between chunks, size, flush  | yes                    |
| `fsx`          | Atomic writes, renames that wait out antivirus locks, reachability with a timeout, free space                    | yes                    |
| `folder`       | A synced folder: lock across computers (heartbeat, stale locks), registry `manifest.json`, scan, links or copies | yes                    |
| `sync`         | The Media Downloader flows: listing of media fields, safe names and duplicates, the plan, its execution          | Media Downloader's     |
| `MediaService` | The engine: one job per project, projects side by side, throttled state and batched activity as events           | Media Downloader's     |
| `testing`      | A fake On Page (API and storage on one host) with switches for 429, 500, cut connections, silent servers, 404    | tests (`fake-server`)  |

Everything runs on Tokio. `MediaService::new` starts a runtime of its own, so a network share that hangs never blocks
the app; `MediaService::with_handle` runs on a runtime the caller gives.

## The engine in a few lines

```rust
use std::sync::Arc;
use op_media_service::{MediaService, ServiceConfig, ServiceEvent, ServiceProject, Timings};

let service = MediaService::new(
    ServiceConfig {
        cache_dir: "cache".into(),
        concurrency: 4,
        instance_id: uuid::Uuid::new_v4().to_string(),
        api_domain: None,
        project_folders: vec![],
        timings: Timings::default(),
    },
    Arc::new(|event: ServiceEvent| match event {
        ServiceEvent::State { project_id, runtime } => { /* phase, progress, plan, issues */ }
        ServiceEvent::Activity { project_id, entries } => { /* what happened to which file */ }
        ServiceEvent::Result { project_id, result } => { /* a job ended */ }
        ServiceEvent::Log { level, message, project_id } => { /* for the log file */ }
    }),
)?;
service.sync(project.clone(), false); // «Sincronizza»: list, compare, plan
service.download(project);            // «Scarica»: execute the plan
```

Requests (`inspect_folder`, `verify_token`, `duplicates`, `delete_project_files`) are `async` and answer with the
types of `models`, serialized exactly as `src/shared/models.ts` of the app.

## The rules it keeps

The service only removes what it created, never overwrites a name it does not know, waits for the user before large
removals, removes nothing after an incomplete listing, refuses protected folders, keeps one writer per folder (also
across computers), never leaves half a file under a name, never acts on a registry it cannot read, and keeps a folder
to one On Page project. Each rule and each fault of folders and disks is described in `docs/ARCHITECTURE.md`.

## For op-media-sync

What sync both ways needs and the service does not have yet:

- **Uploads**: an `onpage` call to send a file to the DAM and a `transfer` in the other direction (the same temporary
  name, size and retry rules); the DAM endpoints (`dam_nodes`, folders, moves) in `onpage`.
- **A registry of both sides**: `folder::manifest` records what the app wrote; a two-way sync also needs the remote
  version of each name (DAM node id, its `updated_at`) to tell which side changed, and a policy for conflicts.
- **Change detection on disk**: the service scans when asked; a mounted folder needs file system events (the `notify`
  crate) or the virtual drive's own callbacks (Windows Cloud Files API, macOS File Provider, FUSE on Linux).

The lock, the atomic writes, the retries, the cancellation of transfers in flight, the fake server and the fault rules
carry over as they are.

## Tests

```bash
cargo test -p op-media-service
```

Unit tests per module, and the engine end to end against the fake On Page (`src/engine/tests.rs`). The fake server
also runs alone, to try the app without real data:

```bash
cargo run -p op-media-service --features fake-server --bin fake-onpage -- --port 4310 --things 3000
```
