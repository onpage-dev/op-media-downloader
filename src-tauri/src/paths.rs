//! Where the app keeps its data, and where the Electron app (1.x and 2.0)
//! kept its own.
//!
//! The installed app uses its data folder (`<app data>/com.onpage.mediadownloader`)
//! and, at its first start, imports the Electron app's settings file and
//! listing caches from `<config>/op-media-downloader` (or the product name).
//! Development builds never touch the data of the installed app (1.x keeps its
//! projects and tokens there, and the import would move them): they use
//! `<config>/op-media-downloader-dev`, the folder of the Electron app's
//! development runs, or the one in OPMD_USER_DATA, and a credential store
//! entry of their own.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::store::STORE_FILE;
use crate::{info, warn};

pub const KEYRING_SERVICE: &str = if cfg!(debug_assertions) {
    "com.onpage.mediadownloader.dev"
} else {
    "com.onpage.mediadownloader"
};

/// The names the Electron app had: its package name, its product name
pub const ELECTRON_NAMES: [&str; 2] = ["op-media-downloader", "On Page Media Downloader"];

pub struct AppPaths {
    /// Settings file
    pub data: PathBuf,
    /// Listing caches, one per project
    pub cache: PathBuf,
    pub logs: PathBuf,
    /// The Electron app's folder, when there is one (its `Local State` holds the key of its tokens)
    pub legacy: Option<PathBuf>,
}

impl AppPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> AppPaths {
        let config = app
            .path()
            .config_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        let (data, legacy) = if cfg!(debug_assertions) {
            let data = std::env::var_os("OPMD_USER_DATA")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| config.join("op-media-downloader-dev"));
            (data.clone(), Some(data))
        } else {
            let data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| config.join("com.onpage.mediadownloader"));
            let legacy = ELECTRON_NAMES
                .iter()
                .map(|name| config.join(name))
                .find(|dir| dir.join(STORE_FILE).is_file());
            (data, legacy)
        };
        AppPaths {
            cache: data.join("cache"),
            logs: data.join("logs"),
            data,
            legacy,
        }
    }

    /// First start of the installed app: the Electron app's settings and caches are copied, never moved
    pub fn import_legacy(&self) {
        let Some(legacy) = &self.legacy else { return };
        if legacy == &self.data || self.data.join(STORE_FILE).exists() {
            return;
        }
        if let Err(error) = fs::create_dir_all(&self.data)
            .and_then(|_| fs::copy(legacy.join(STORE_FILE), self.data.join(STORE_FILE)))
        {
            warn!(
                "The settings of the Electron app could not be imported from {}: {error}",
                legacy.display()
            );
            return;
        }
        let caches = copy_caches(&legacy.join("cache"), &self.cache);
        info!(
            "Imported the settings of the Electron app from {} ({caches} listing caches)",
            legacy.display()
        );
    }
}

fn copy_caches(from: &Path, to: &Path) -> usize {
    let Ok(entries) = fs::read_dir(from) else {
        return 0;
    };
    let _ = fs::create_dir_all(to);
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".json.gz"))
        .filter(|entry| fs::copy(entry.path(), to.join(entry.file_name())).is_ok())
        .count()
}

/// The third-party notices: a resource of the bundle, in the repository in development
pub fn licenses_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("THIRD_PARTY_NOTICES.txt"),
        );
    }
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("THIRD_PARTY_NOTICES.txt"))
}
