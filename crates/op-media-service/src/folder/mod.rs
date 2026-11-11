//! A synced folder, independent of where its files come from:
//!
//! - [`lock`]: one writer per folder, also across computers on a share;
//! - [`manifest`]: the registry of what the app created (only those names are ever removed);
//! - [`scan`]: one listing of the folder and of `data/`;
//! - [`link`]: a content of `data/` under a name, as a hard link or a copy;
//! - [`data_dir`]: whether `data/` is the app's own;
//! - [`inspect`]: kind, space, hard links and problems of a folder;
//! - [`delete`]: removing what the app put in a folder.

pub mod data_dir;
pub mod delete;
pub mod inspect;
pub mod link;
pub mod lock;
pub mod manifest;
pub mod scan;
