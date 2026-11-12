//! `data/synced.json`: when a folder was last brought up to date in full (a
//! complete listing, the whole plan carried out), by which computer and app.
//! The automatic syncs of the other computers sharing the folder read it and
//! leave the folder alone for a while: one of them is enough.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::lock::{LOCK_STALE, hostname, is_stale, read_lock};
use super::manifest::DATA_DIR;
use crate::fsx::atomic_write;
use crate::models::{now_iso, parse_iso_ms};

pub const SYNCED_FILE: &str = "synced.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Synced {
    pub at: String,
    pub instance_id: String,
    #[serde(default)]
    pub host: String,
}

/// Why another app has the folder in hand now
#[derive(Debug, Clone, PartialEq)]
pub enum Elsewhere {
    /// Its job runs now (a lock with a recent heartbeat)
    Busy { host: String },
    /// It brought the folder up to date this long ago
    Synced { host: String, ago: Duration },
}

/// Written at the end of a job that brought the folder up to date; a failure only means the next app syncs too
pub async fn write(data_dir: &Path, instance_id: &str) {
    let synced = Synced { at: now_iso(), instance_id: instance_id.to_string(), host: hostname() };
    let Ok(bytes) = serde_json::to_vec(&synced) else { return };
    let _ = atomic_write(&data_dir.join(SYNCED_FILE), &bytes, None).await;
}

pub async fn read(data_dir: &Path) -> Option<Synced> {
    serde_json::from_slice(&tokio::fs::read(data_dir.join(SYNCED_FILE)).await.ok()?).ok()
}

/// Another app (not `instance_id`) is bringing the folder up to date now,
/// or another computer did within `within`: this computer's own syncs (the
/// app before a restart, `opmd`) are in the projects' last results already.
/// Nothing found, or a folder that does not answer: None (the job itself
/// will say what is wrong)
pub async fn elsewhere(folder: &Path, instance_id: &str, within: Duration, now_ms: i64) -> Option<Elsewhere> {
    let data_dir = folder.join(DATA_DIR);
    if let Some(lock) = read_lock(&data_dir).await
        && lock.instance_id != instance_id
        && !is_stale(&lock, now_ms, LOCK_STALE)
    {
        return Some(Elsewhere::Busy { host: lock.host });
    }
    let synced = read(&data_dir).await?;
    if synced.host == hostname() {
        return None;
    }
    let ago = now_ms - parse_iso_ms(&synced.at)?;
    let within = within.as_millis() as i64;
    // A clock ahead of ours by more than the interval is not believed (it would hold the folder
    // for as long); a little ahead counts as now
    if ago >= within || ago < -within {
        return None;
    }
    Some(Elsewhere::Synced { host: synced.host, ago: Duration::from_millis(ago.max(0) as u64) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::lock::LockInfo;
    use crate::folder::manifest::LOCK_FILE;
    use crate::models::now_ms;

    fn other(at: i64) -> Synced {
        Synced { at: crate::models::iso_ms(at), instance_id: "altro".into(), host: "pc-di-luca".into() }
    }

    #[tokio::test]
    async fn another_app_that_synced_or_syncs_the_folder_is_seen() {
        let folder = tempfile::tempdir().unwrap();
        let data = folder.path().join(DATA_DIR);
        std::fs::create_dir_all(&data).unwrap();
        let now = now_ms();
        let hour = Duration::from_secs(3600);
        assert_eq!(elsewhere(folder.path(), "io", hour, now).await, None);

        // This computer's own syncs do not count, whichever app made them
        write(&data, "before-a-restart").await;
        assert_eq!(read(&data).await.unwrap().instance_id, "before-a-restart");
        assert_eq!(elsewhere(folder.path(), "io", hour, now).await, None);

        // Another's, ten minutes ago: within the hour, not within five minutes
        std::fs::write(data.join(SYNCED_FILE), serde_json::to_vec(&other(now - 600_000)).unwrap()).unwrap();
        assert_eq!(
            elsewhere(folder.path(), "io", hour, now).await,
            Some(Elsewhere::Synced { host: "pc-di-luca".into(), ago: Duration::from_secs(600) })
        );
        assert_eq!(elsewhere(folder.path(), "io", Duration::from_secs(300), now).await, None);
        // A clock far ahead is not believed; a little ahead counts as now
        std::fs::write(data.join(SYNCED_FILE), serde_json::to_vec(&other(now + 2 * 3_600_000)).unwrap()).unwrap();
        assert_eq!(elsewhere(folder.path(), "io", hour, now).await, None);
        std::fs::write(data.join(SYNCED_FILE), serde_json::to_vec(&other(now + 60_000)).unwrap()).unwrap();
        assert_eq!(
            elsewhere(folder.path(), "io", hour, now).await,
            Some(Elsewhere::Synced { host: "pc-di-luca".into(), ago: Duration::ZERO })
        );
        std::fs::write(data.join(SYNCED_FILE), b"not json").unwrap();
        assert_eq!(elsewhere(folder.path(), "io", hour, now).await, None);

        // Its job runs now; a lock with no news for long does not count
        let lock = |beat: i64| LockInfo {
            host: "pc-di-luca".into(),
            pid: 1,
            instance_id: "altro".into(),
            project_id: "p".into(),
            started_at: crate::models::iso_ms(beat),
            heartbeat_at: crate::models::iso_ms(beat),
        };
        std::fs::write(data.join(LOCK_FILE), serde_json::to_vec(&lock(now - 5_000)).unwrap()).unwrap();
        assert_eq!(
            elsewhere(folder.path(), "io", hour, now).await,
            Some(Elsewhere::Busy { host: "pc-di-luca".into() })
        );
        std::fs::write(data.join(LOCK_FILE), serde_json::to_vec(&lock(now - 3_600_000)).unwrap()).unwrap();
        assert_eq!(elsewhere(folder.path(), "io", hour, now).await, None);
    }
}
