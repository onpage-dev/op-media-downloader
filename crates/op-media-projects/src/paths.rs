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

use crate::store::STORE_FILE;
use crate::{info, warn};

/// The app's identifier: its data folder is named after it
pub const IDENTIFIER: &str = "com.onpage.mediadownloader";

pub const KEYRING_SERVICE: &str =
    if cfg!(debug_assertions) { "com.onpage.mediadownloader.dev" } else { "com.onpage.mediadownloader" };

/// The names the Electron app had: its package name, its product name
pub const ELECTRON_NAMES: [&str; 2] = ["op-media-downloader", "On Page Media Downloader"];

#[derive(Debug, Clone)]
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
    /// The app's own data: the folder of the installed app, or of the
    /// development builds (`dev`). The same folders as Tauri's `config_dir`
    /// and `app_data_dir`, so the app and `opmd` find the same projects.
    pub fn resolve(dev: bool) -> AppPaths {
        let config = dirs::config_dir().unwrap_or_else(std::env::temp_dir);
        let (data, legacy) = if dev {
            let data = std::env::var_os("OPMD_USER_DATA")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| config.join("op-media-downloader-dev"));
            (data.clone(), Some(data))
        } else {
            let data = dirs::data_dir().map(|dir| dir.join(IDENTIFIER)).unwrap_or_else(|| config.join(IDENTIFIER));
            let legacy = ELECTRON_NAMES.iter().map(|name| config.join(name)).find(|dir| dir.join(STORE_FILE).is_file());
            (data, legacy)
        };
        AppPaths::with_legacy(data, legacy)
    }

    /// A data folder of its own (`opmd --data-dir`: a server, a NAS), without the Electron app's
    pub fn at(data: PathBuf) -> AppPaths {
        AppPaths::with_legacy(data, None)
    }

    fn with_legacy(data: PathBuf, legacy: Option<PathBuf>) -> AppPaths {
        AppPaths { cache: data.join("cache"), logs: data.join("logs"), data, legacy }
    }

    /// First start of the installed app: the Electron app's settings and caches are copied, never moved
    pub fn import_legacy(&self) {
        let Some(legacy) = &self.legacy else { return };
        if legacy == &self.data || self.data.join(STORE_FILE).exists() {
            return;
        }
        if let Err(error) =
            fs::create_dir_all(&self.data).and_then(|_| fs::copy(legacy.join(STORE_FILE), self.data.join(STORE_FILE)))
        {
            warn!("The settings of the Electron app could not be imported from {}: {error}", legacy.display());
            return;
        }
        let caches = copy_caches(&legacy.join("cache"), &self.cache);
        info!("Imported the settings of the Electron app from {} ({caches} listing caches)", legacy.display());
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
