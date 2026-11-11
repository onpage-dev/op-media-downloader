//! One listing of the project folder and one of data/ per job.

use rustc_hash::{FxHashMap, FxHashSet};
use std::path::Path;

use super::manifest::{DATA_DIR, LINK_JSON_FILE, LOCK_FILE, MANIFEST_FILE, TEMP_PREFIX};
use crate::error::{Error, Result};
use crate::sync::names::{is_safe_token, name_key};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryType {
    File,
    Dir,
    Other,
}

#[derive(Debug, Clone)]
pub struct FolderEntry {
    pub name: String,
    pub kind: EntryType,
}

#[derive(Debug, Clone, Default)]
pub struct FolderScan {
    /// Entries of the project folder by case-insensitive key, data/ excluded
    pub entries: FxHashMap<String, FolderEntry>,
    /// Tokens present in data/
    pub data_tokens: FxHashSet<String>,
    /// `<token>.download` and other leftovers of interrupted runs, in data/
    pub data_leftovers: Vec<String>,
    /// `.opmd-*` temporary names in the project folder
    pub folder_leftovers: Vec<String>,
}

/// The entries of a folder (name, type), not following links; a missing folder is empty.
/// Names that are not valid Unicode cannot be the app's and are left out
pub async fn read_entries(dir: &Path) -> Result<Vec<(String, EntryType)>> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || -> std::io::Result<Vec<(String, EntryType)>> {
        let iter = match std::fs::read_dir(&dir) {
            Ok(iter) => iter,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut out = Vec::new();
        for entry in iter {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let kind = match entry.file_type() {
                Ok(t) if t.is_file() => EntryType::File,
                Ok(t) if t.is_dir() => EntryType::Dir,
                _ => EntryType::Other,
            };
            out.push((name, kind));
        }
        Ok(out)
    })
    .await
    .map_err(|e| Error::Other(e.to_string()))?
    .map_err(Error::Io)
}

pub async fn scan_folder(folder: &Path) -> Result<FolderScan> {
    let mut scan = FolderScan::default();
    // The two listings at the same time: on a share each one waits for the server
    let data_dir = folder.join(DATA_DIR);
    let (names, data) = tokio::join!(read_entries(folder), read_entries(&data_dir));
    let (names, data) = (names?, data?);
    for (name, kind) in names {
        let key = name_key(&name);
        if key == DATA_DIR {
            continue;
        }
        if name.starts_with(TEMP_PREFIX) {
            scan.folder_leftovers.push(name);
            continue;
        }
        // Case-sensitive folders can hold two names with one key: keep the first
        scan.entries.entry(key).or_insert(FolderEntry { name, kind });
    }
    for (name, kind) in data {
        if kind != EntryType::File || [MANIFEST_FILE, LINK_JSON_FILE, LOCK_FILE].contains(&name.as_str()) {
            continue;
        }
        if name.ends_with(".download") || name.ends_with(".tmp") || name.starts_with(TEMP_PREFIX) {
            scan.data_leftovers.push(name);
            continue;
        }
        if is_safe_token(&name) {
            scan.data_tokens.insert(name);
        }
    }
    Ok(scan)
}
