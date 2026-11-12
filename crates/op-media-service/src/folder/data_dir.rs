//! Who owns `<folder>/data`. The app removes contents from data/ freely, so
//! it must be sure the folder is its own: a `data` folder the user already
//! had in the chosen folder is never used, emptied or deleted.

use std::path::Path;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};

use regex::Regex;

use super::manifest::{LINK_JSON_FILE, LOCK_FILE, MANIFEST_FILE, TEMP_PREFIX};
use super::synced::SYNCED_FILE;
use crate::error::Result;
use crate::sync::queue::run_queue;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataDirOwner {
    Missing,
    Ours,
    Foreign,
}

/// An On Page storage token (hex, optionally with an extension) or one of its temporary files
static TOKEN_LIKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{24,64}(\.[A-Za-z0-9]{1,10})?(\.download|\.tmp)?$").expect("valid"));

pub fn is_own_data_entry(name: &str) -> bool {
    [MANIFEST_FILE, LINK_JSON_FILE, LOCK_FILE, SYNCED_FILE].contains(&name)
        || name.starts_with(TEMP_PREFIX)
        // Temporary copies of the manifest, the lock and synced.json (a write cut by a crash or a dropped share)
        || name.starts_with(&format!("{MANIFEST_FILE}."))
        || name.starts_with(&format!("{LOCK_FILE}."))
        || name.starts_with(&format!("{SYNCED_FILE}."))
        || TOKEN_LIKE.is_match(name)
}

async fn names(dir: &Path) -> std::io::Result<Vec<String>> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std::fs::read_dir(dir)?
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<Vec<_>>>()
    })
    .await
    .unwrap_or_else(|e| Err(std::io::Error::other(e)))
}

/// `Ours` when data/ holds the manifest or the 1.x link.json, or only tokens
/// and service files (a 1.x first download interrupted before link.json was
/// written); `Foreign` when it holds anything else.
pub async fn data_dir_owner(data_dir: &Path) -> Result<DataDirOwner> {
    // The registry is there: no need to list tens of thousands of contents
    for own in [MANIFEST_FILE, LINK_JSON_FILE] {
        if tokio::fs::metadata(data_dir.join(own)).await.is_ok_and(|m| m.is_file()) {
            return Ok(DataDirOwner::Ours);
        }
    }
    let entries = match names(data_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DataDirOwner::Missing);
        }
        Err(error) => return Err(error.into()),
    };
    if entries.iter().any(|n| n == MANIFEST_FILE || n == LINK_JSON_FILE) {
        return Ok(DataDirOwner::Ours);
    }
    Ok(if entries.iter().all(|n| is_own_data_entry(n)) { DataDirOwner::Ours } else { DataDirOwner::Foreign })
}

/// Removes what the app put in data/, a few at a time (a share answers each
/// call slowly), and data/ itself when nothing else is left. The lock is not
/// removed: its holder releases it last, once data/ is empty.
pub async fn remove_own_data_entries(data_dir: &Path) -> (u64, u64) {
    let Ok(entries) = names(data_dir).await else {
        return (0, 0);
    };
    let removed = AtomicU64::new(0);
    let kept = AtomicU64::new(0);
    let entries: Vec<String> = entries.into_iter().filter(|n| n != LOCK_FILE).collect();
    let _ = run_queue(&entries, 8, None, |name, _| {
        let removed = &removed;
        let kept = &kept;
        async move {
            if !is_own_data_entry(name) {
                kept.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            let path = data_dir.join(name);
            let gone = match tokio::fs::remove_file(&path).await {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                // Never a whole folder: only what the app wrote
                Err(_) => false,
            };
            if gone {
                removed.fetch_add(1, Ordering::Relaxed)
            } else {
                kept.fetch_add(1, Ordering::Relaxed)
            };
            Ok(())
        }
    })
    .await;
    let (removed, kept) = (removed.into_inner(), kept.into_inner());
    if kept == 0 {
        let _ = tokio::fs::remove_dir(data_dir).await;
    }
    (removed, kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn knows_its_own_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        assert_eq!(data_dir_owner(&data).await.unwrap(), DataDirOwner::Missing);
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("0123456789abcdef01234567"), b"").unwrap();
        std::fs::write(data.join("0123456789abcdef01234567.1a2b3c4d.download"), b"").unwrap();
        assert_eq!(data_dir_owner(&data).await.unwrap(), DataDirOwner::Ours);
        std::fs::write(data.join("tesi.docx"), b"").unwrap();
        assert_eq!(data_dir_owner(&data).await.unwrap(), DataDirOwner::Foreign);
        std::fs::write(data.join(MANIFEST_FILE), b"{}").unwrap();
        assert_eq!(data_dir_owner(&data).await.unwrap(), DataDirOwner::Ours);
        let (removed, kept) = remove_own_data_entries(&data).await;
        assert_eq!((removed, kept), (3, 1));
        assert!(data.join("tesi.docx").exists());
    }
}
