//! # op-media-service
//!
//! The download management of On Page Media Downloader, as a library that
//! other On Page desktop apps (op-media-sync) can build on. Layers, from the
//! bottom:
//!
//! | Module      | Does                                                                                     |
//! | ----------- | ---------------------------------------------------------------------------------------- |
//! | [`http`]    | Retry policies, backoff with jitter, `Retry-After`, timeouts                              |
//! | [`onpage`]  | The On Page API through a token (schema, things, storage links)                          |
//! | [`transfer`]| One file from a URL to the disk, atomically: temporary name, size check, flush, rename   |
//! | [`fsx`]     | File system helpers for slow and unreliable folders (network shares, removable disks)    |
//! | [`folder`]  | A synced folder: lock across computers, registry (`manifest.json`), scan, links, checks |
//! | [`sync`]    | The Media Downloader flows: listing, names, plan, execution, duplicates                   |
//! | [`MediaService`] | The engine: one job per project, projects side by side, state and activity events  |
//!
//! Everything that touches On Page or a folder runs on the service's own
//! Tokio runtime: the user of the service never blocks, whatever a network
//! share does. The rules the service keeps (it only removes what it created,
//! one writer per folder, nothing half-written under a name…) are in
//! `docs/ARCHITECTURE.md`.

/// A disk fault a test armed for this operation (`faults`): `?` returns it
/// as the disk's error. Nothing in release builds
#[cfg(any(test, feature = "fake-server"))]
macro_rules! fault {
    ($op:ident, $path:expr) => {
        crate::faults::check(crate::faults::Op::$op, $path)?
    };
}
#[cfg(not(any(test, feature = "fake-server")))]
macro_rules! fault {
    ($op:ident, $path:expr) => {};
}

pub mod error;
pub mod folder;
pub mod fsx;
pub mod http;
pub mod models;
pub mod onpage;
pub mod sync;
pub mod transfer;

mod engine;

/// The fake On Page server: tests, and `cargo run -p op-media-service --features fake-server --bin fake-onpage`
#[cfg(any(test, feature = "fake-server"))]
pub mod testing;

/// Disk faults on demand for the tests (a disk full mid-write, a share that drops…)
#[cfg(any(test, feature = "fake-server"))]
pub mod faults;

pub use engine::{EventSink, MediaService, ServiceConfig, ServiceEvent, Timings};
pub use models::*;
