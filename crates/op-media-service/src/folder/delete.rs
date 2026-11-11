//! Deleting a project's files: the names of the manifest and what the app
//! put in data/; the folder itself only when nothing else is left in it.
//! The folder lock is held until data/ is empty and goes last, so no other
//! instance starts on a half-deleted folder. A folder another On Page project
//! took over since the project's last sync is left as it is
//! (`folder_other_project`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::data_dir::{DataDirOwner, data_dir_owner, remove_own_data_entries};
use super::inspect::normalize;
use super::link::remove_name;
use super::lock::{FolderLock, LockOptions};
use super::manifest::{DATA_DIR, Manifest};
use super::scan::{EntryType, scan_folder};
use crate::error::{Error, Result};
use crate::fsx::{path_exists, unlink_quiet};
use crate::models::{DeleteFilesResult, ServiceProject};
use crate::sync::names::{name_key, same_name};
use crate::sync::queue::run_queue;

/// Removals at a time: a share answers each one slowly
const LANES: usize = 8;

pub struct DeleteOptions {
    pub instance_id: String,
    pub lock_stale: Duration,
    pub lock_heartbeat: Duration,
}

pub async fn delete_project_files(project: &ServiceProject, options: &DeleteOptions) -> Result<DeleteFilesResult> {
    let folder = normalize(&project.folder);
    let data_dir = folder.join(DATA_DIR);
    let mut result = DeleteFilesResult::default();
    if !path_exists(&folder).await {
        return Ok(result);
    }
    // A data/ folder the app did not create is left as it is, and so is everything else
    if data_dir_owner(&data_dir).await.unwrap_or(DataDirOwner::Foreign) == DataDirOwner::Ours {
        let lock = FolderLock::acquire(
            &data_dir,
            LockOptions {
                stale: options.lock_stale,
                heartbeat: options.lock_heartbeat,
                ..LockOptions::new(&options.instance_id, &project.id)
            },
        )
        .await?;
        let removed = AtomicU64::new(0);
        let work: Result<()> = async {
            let loaded = Manifest::load(&data_dir, &project.id).await?;
            // Taken over by another On Page project since: the names are that project's now
            if let (Some(bound), Some(last)) = (loaded.manifest.onpage_project(), project.onpage_project_id) {
                if bound.id != last {
                    return Err(Error::Other(format!("folder_other_project: {}", bound.label)));
                }
            }
            let scan = scan_folder(&folder).await?;
            let entries = loaded.manifest.names();
            run_queue(&entries, LANES, None, |name, _| {
                let (scan, folder, removed) = (&scan, &folder, &removed);
                async move {
                    // Exactly our name, as the disk gives it back (decomposed on macOS), and a plain file
                    let Some(entry) = scan.entries.get(&name_key(name)) else { return Ok(()) };
                    if entry.kind != EntryType::File || !same_name(&entry.name, name) {
                        return Ok(());
                    }
                    if remove_name(folder, &entry.name).await.unwrap_or(false) {
                        removed.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(())
                }
            })
            .await?;
            run_queue(&scan.folder_leftovers, LANES, None, |leftover, _| {
                let folder = &folder;
                async move {
                    let _ = unlink_quiet(&folder.join(leftover)).await;
                    Ok(())
                }
            })
            .await?;
            remove_own_data_entries(&data_dir).await;
            Ok(())
        }
        .await;
        lock.release().await;
        work?;
        result.removed_files = removed.into_inner();
        let _ = tokio::fs::remove_dir(&data_dir).await;
    }
    let left = crate::folder::scan::read_entries(&folder).await.map(|e| e.len()).unwrap_or(0);
    result.kept_entries = left as u64;
    if left == 0 {
        result.removed_folder = tokio::fs::remove_dir(&folder).await.is_ok();
    }
    Ok(result)
}
