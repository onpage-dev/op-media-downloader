//! The Media Downloader flows over a synced folder, step by step:
//!
//! - [`listing`]: reading the media of a project from On Page (incremental with a cache);
//! - [`names`]: from the remote files to safe, unique names, and the duplicates;
//! - [`plan`]: what the folder needs (a pure function, with the safety rules);
//! - [`executor`]: running a plan (links, downloads, removals) with progress and activity;
//! - [`listing_store`], [`remote_index`]: the last listing in memory and on disk;
//! - [`duplicates`]: the pages of the duplicates tab.

pub mod activity;
pub mod duplicates;
pub mod executor;
pub mod listing;
pub mod listing_store;
pub mod names;
pub mod plan;
pub mod progress;
pub mod queue;
pub mod remote_index;
