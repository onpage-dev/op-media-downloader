//! data/.lock: one writer per folder, also across computers sharing a
//! network folder. A heartbeat keeps it fresh; a lock without heartbeat for
//! two minutes belongs to a crashed instance and can be taken over. The
//! clocks of two computers can differ by minutes: before taking a lock that
//! looks stale the app watches it for a heartbeat, and a lock of this
//! computer whose process is gone is taken at once. A lock that is lost later
//! (taken by another instance, or not refreshed for most of the stale time)
//! says so through `lost()`: the job ends and stops writing.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::manifest::LOCK_FILE;
use crate::error::{Error, JobError, Result};
use crate::fsx::atomic_write;
use crate::http::sleep;
use crate::models::{IssueCode, iso_ms, parse_iso_ms};

pub const LOCK_STALE: Duration = Duration::from_secs(120);
pub const LOCK_HEARTBEAT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LockInfo {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub pid: i64,
    pub instance_id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub heartbeat_at: String,
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn wall_clock() -> Clock {
    Arc::new(|| chrono::Utc::now().timestamp_millis())
}

#[derive(Clone)]
pub struct LockOptions {
    pub instance_id: String,
    pub project_id: String,
    pub stale: Duration,
    pub heartbeat: Duration,
    /// How long a lock that looks stale is watched for a heartbeat before it
    /// is taken; the heartbeat plus 5 s when None
    pub confirm: Option<Duration>,
    pub now: Clock,
    /// The job's: a stop ends the wait for a lock that looks stale
    pub cancel: Option<CancellationToken>,
}

impl LockOptions {
    pub fn new(instance_id: &str, project_id: &str) -> LockOptions {
        LockOptions {
            instance_id: instance_id.to_string(),
            project_id: project_id.to_string(),
            stale: LOCK_STALE,
            heartbeat: LOCK_HEARTBEAT,
            confirm: None,
            now: wall_clock(),
            cancel: None,
        }
    }

    fn confirm(&self) -> Duration {
        self.confirm.unwrap_or(self.heartbeat + Duration::from_secs(5))
    }
}

pub fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

pub async fn read_lock(data_dir: &Path) -> Option<LockInfo> {
    read_lock_file(&data_dir.join(LOCK_FILE)).await.1
}

/// `exists` without `info`: a lock being written, or broken
async fn read_lock_file(file: &Path) -> (bool, Option<LockInfo>) {
    match tokio::fs::read(file).await {
        Ok(bytes) => (true, serde_json::from_slice::<LockInfo>(&bytes).ok()),
        Err(error) => (error.kind() != std::io::ErrorKind::NotFound, None),
    }
}

#[cfg(unix)]
fn process_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: i64) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let Ok(pid) = u32::try_from(pid) else { return false };
    // SAFETY: plain Win32 calls; the handle is closed
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: i64) -> bool {
    true
}

/// A lock of this computer whose process is gone: the app crashed, no need to wait
fn crashed_here(info: &LockInfo) -> bool {
    info.host == hostname() && info.pid != std::process::id() as i64 && info.pid > 0 && !process_alive(info.pid)
}

pub fn is_stale(info: &LockInfo, now: i64, stale: Duration) -> bool {
    match parse_iso_ms(&info.heartbeat_at) {
        Some(beat) => now - beat > stale.as_millis() as i64,
        None => true,
    }
}

/// Whether the lock in the folder can be taken over; otherwise who holds it
async fn take_over(file: &Path, opts: &LockOptions) -> Result<(bool, Option<LockInfo>)> {
    let (exists, held) = read_lock_file(file).await;
    if !exists {
        return Ok((true, None));
    }
    if let Some(held) = &held {
        // Ours from an earlier job
        if held.instance_id == opts.instance_id && held.project_id == opts.project_id {
            return Ok((true, None));
        }
        if crashed_here(held) {
            return Ok((true, None));
        }
        if !is_stale(held, (opts.now)(), opts.stale) {
            return Ok((false, Some(held.clone())));
        }
    }
    // Stale by its own clock, or unreadable: a live instance beats (or finishes writing) meanwhile
    let wait = if held.is_some() { opts.confirm() } else { opts.confirm().min(Duration::from_secs(2)) };
    sleep(wait, opts.cancel.as_ref()).await?;
    let (exists, second) = read_lock_file(file).await;
    if !exists {
        return Ok((true, None));
    }
    if second != held {
        return Ok((false, second.or(held)));
    }
    Ok((true, None))
}

struct Inner {
    file: PathBuf,
    info: Mutex<LockInfo>,
    opts: LockOptions,
    last_beat: Mutex<i64>,
    lost: CancellationToken,
    beating: AtomicBool,
    watching: AtomicBool,
    heartbeat: Mutex<Option<JoinHandle<()>>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Inner {
    fn lose(&self) {
        if let Some(task) = self.heartbeat.lock().take() {
            task.abort();
        }
        self.lost.cancel();
    }

    fn is_other(&self, current: &Option<LockInfo>) -> bool {
        current.as_ref().is_some_and(|c| c.instance_id != self.info.lock().instance_id)
    }

    /// Another instance's lock in place of ours: the folder is theirs
    async fn watch(&self) {
        let current = read_lock_file(&self.file).await.1;
        if self.is_other(&current) {
            self.lose();
        }
    }

    async fn beat(&self) {
        let result: Result<()> = async {
            if self.is_other(&read_lock_file(&self.file).await.1) {
                self.lose();
                return Ok(());
            }
            let data = {
                let mut info = self.info.lock();
                info.heartbeat_at = iso_ms((self.opts.now)());
                serde_json::to_vec(&*info).map_err(|e| Error::Other(e.to_string()))?
            };
            // Once the folder is lost, a write that the share holds never lands on the other instance's lock
            atomic_write(&self.file, &data, Some(&self.lost)).await?;
            // Someone may have written between our read and our write: check again
            if self.is_other(&read_lock_file(&self.file).await.1) {
                self.lose();
                return Ok(());
            }
            *self.last_beat.lock() = (self.opts.now)();
            Ok(())
        }
        .await;
        // A missed beat is not fatal, the next one retries; but after most of
        // the stale time without one, another computer may take the folder
        if result.is_err() && (self.opts.now)() - *self.last_beat.lock() > (self.opts.stale.as_millis() as i64) * 3 / 4 {
            self.lose();
        }
    }
}

/// The lock of a folder while a job (or a deletion) works on it
pub struct FolderLock {
    inner: Arc<Inner>,
}

impl FolderLock {
    pub async fn acquire(data_dir: &Path, opts: LockOptions) -> Result<FolderLock> {
        let file = data_dir.join(LOCK_FILE);
        let now = iso_ms((opts.now)());
        let info = LockInfo {
            host: hostname(),
            pid: std::process::id() as i64,
            instance_id: opts.instance_id.clone(),
            project_id: opts.project_id.clone(),
            started_at: now.clone(),
            heartbeat_at: now,
        };
        let data = serde_json::to_vec(&info).map_err(|e| Error::Other(e.to_string()))?;
        for _ in 0..3 {
            // create_new: fails when the file exists, also over SMB (CREATE_NEW)
            let created = async {
                let mut f = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&file).await?;
                f.write_all(&data).await?;
                f.flush().await
            }
            .await;
            match created {
                Ok(()) => {
                    let lock = FolderLock {
                        inner: Arc::new(Inner {
                            file,
                            last_beat: Mutex::new((opts.now)()),
                            info: Mutex::new(info),
                            opts,
                            lost: CancellationToken::new(),
                            beating: AtomicBool::new(false),
                            watching: AtomicBool::new(false),
                            heartbeat: Mutex::new(None),
                            tasks: Mutex::new(Vec::new()),
                        }),
                    };
                    lock.start_heartbeat();
                    return Ok(lock);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(Error::Io(error)),
            }
            let (take, holder) = take_over(&file, &opts).await?;
            if !take {
                return Err(Error::Job(match holder {
                    Some(h) => JobError::with_detail(
                        IssueCode::FolderLocked,
                        "Another instance is syncing this folder",
                        format!("{} (pid {})", h.host, h.pid),
                    ),
                    None => JobError::new(IssueCode::FolderLocked, "Another instance is syncing this folder"),
                }));
            }
            match tokio::fs::remove_file(&file).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(Error::Io(error)),
            }
        }
        Err(Error::Job(JobError::new(IssueCode::FolderLocked, "The folder lock could not be taken")))
    }

    fn start_heartbeat(&self) {
        let inner = Arc::downgrade(&self.inner);
        let period = self.inner.opts.heartbeat.max(Duration::from_millis(10));
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(lock) = inner.upgrade() else { return };
                // One beat at a time: a slow share must not pile them up. While a beat waits for the share to
                // let its write through, a read still notices another computer's lock
                if lock.beating.load(Ordering::SeqCst) {
                    if !lock.watching.swap(true, Ordering::SeqCst) {
                        let worker = lock.clone();
                        let handle = tokio::spawn(async move {
                            worker.watch().await;
                            worker.watching.store(false, Ordering::SeqCst);
                        });
                        lock.tasks.lock().push(handle);
                    }
                } else {
                    lock.beating.store(true, Ordering::SeqCst);
                    let worker = lock.clone();
                    let handle = tokio::spawn(async move {
                        worker.beat().await;
                        worker.beating.store(false, Ordering::SeqCst);
                    });
                    let mut tasks = lock.tasks.lock();
                    tasks.retain(|t| !t.is_finished());
                    tasks.push(handle);
                }
            }
        });
        *self.inner.heartbeat.lock() = Some(task);
    }

    /// Fires when another instance took the folder, or the heartbeat could not
    /// be written for so long that others may take it
    pub fn lost_token(&self) -> CancellationToken {
        self.inner.lost.clone()
    }

    pub fn lost(&self) -> bool {
        self.inner.lost.is_cancelled()
    }

    pub async fn release(&self) {
        if let Some(task) = self.inner.heartbeat.lock().take() {
            task.abort();
        }
        // A beat in flight would write the lock again after it is gone
        let tasks: Vec<_> = self.inner.tasks.lock().drain(..).collect();
        for task in tasks {
            let _ = task.await;
        }
        if self.lost() {
            return;
        }
        let current = read_lock_file(&self.inner.file).await.1;
        if !self.inner.is_other(&current) {
            // The folder may be gone: nothing to release
            let _ = tokio::fs::remove_file(&self.inner.file).await;
        }
    }
}

impl Drop for FolderLock {
    fn drop(&mut self) {
        if let Some(task) = self.inner.heartbeat.lock().take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(instance: &str) -> LockOptions {
        LockOptions {
            heartbeat: Duration::from_millis(50),
            stale: Duration::from_millis(400),
            confirm: Some(Duration::from_millis(150)),
            ..LockOptions::new(instance, "p")
        }
    }

    #[tokio::test]
    async fn one_writer_per_folder() {
        let dir = tempfile::tempdir().unwrap();
        let first = FolderLock::acquire(dir.path(), options("a")).await.unwrap();
        let Err(Error::Job(error)) = FolderLock::acquire(dir.path(), options("b")).await else { panic!("taken") };
        assert_eq!(error.issue, IssueCode::FolderLocked);
        first.release().await;
        assert!(!dir.path().join(LOCK_FILE).exists());
        let second = FolderLock::acquire(dir.path(), options("b")).await.unwrap();
        second.release().await;
    }

    #[tokio::test]
    async fn a_stale_lock_is_taken_after_watching_it() {
        let dir = tempfile::tempdir().unwrap();
        let old = LockInfo {
            host: "elsewhere".into(),
            pid: 1,
            instance_id: "x".into(),
            project_id: "p".into(),
            started_at: "2020-01-01T00:00:00.000Z".into(),
            heartbeat_at: "2020-01-01T00:00:00.000Z".into(),
        };
        std::fs::write(dir.path().join(LOCK_FILE), serde_json::to_vec(&old).unwrap()).unwrap();
        let lock = FolderLock::acquire(dir.path(), options("a")).await.unwrap();
        assert_eq!(read_lock(dir.path()).await.unwrap().instance_id, "a");
        lock.release().await;
    }

    #[tokio::test]
    async fn a_lock_taken_by_another_instance_is_lost() {
        let dir = tempfile::tempdir().unwrap();
        let lock = FolderLock::acquire(dir.path(), options("a")).await.unwrap();
        let mut other = read_lock(dir.path()).await.unwrap();
        other.instance_id = "b".into();
        std::fs::write(dir.path().join(LOCK_FILE), serde_json::to_vec(&other).unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), lock.lost_token().cancelled()).await.unwrap();
        lock.release().await;
        // Its lock stays
        assert_eq!(read_lock(dir.path()).await.unwrap().instance_id, "b");
    }
}
