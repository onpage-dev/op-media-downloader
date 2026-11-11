//! File system helpers for slow and unreliable folders. Everything is
//! asynchronous: on a network folder every call is a round trip to the
//! server, and a share whose server is gone can keep a call waiting for
//! tens of seconds.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rand::Rng;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result, io_code};
use crate::http::sleep;

/// Locks that go away on their own: an antivirus, the indexer or a sync
/// client holding a new file for a moment. On Windows they show up as EBUSY,
/// EPERM or EACCES; elsewhere EPERM and EACCES are real permissions, never retried.
pub fn is_transient_lock(error: &io::Error) -> bool {
    let code = io_code(error);
    code == Some("EBUSY") || (cfg!(windows) && matches!(code, Some("EPERM" | "EACCES")))
}

/// The same, for a service error
pub fn is_transient_lock_error(error: &Error) -> bool {
    match error {
        Error::Io(e) | Error::Disk(e) => is_transient_lock(e),
        _ => false,
    }
}

/// Runs `operation`, retrying transient locks: `tries` attempts, 100 ms
/// doubling up to 1 s. When `cancel` fires the wait ends with `Aborted` and
/// the operation is not tried again
pub async fn with_lock_retry<T, F, Fut>(mut operation: F, tries: u32, cancel: Option<&CancellationToken>) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = io::Result<T>>,
{
    let mut attempt = 1;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !is_transient_lock(&error) || attempt >= tries {
                    return Err(Error::Io(error));
                }
                let delay = Duration::from_millis((100u64 << (attempt - 1).min(4)).min(1000));
                sleep(delay, cancel).await?;
                attempt += 1;
            }
        }
    }
}

/// Renames, retrying the transient Windows locks that make a rename fail for
/// a moment. On a network share the antivirus can hold a new file for
/// seconds: 10 tries over ~8 s.
pub async fn rename_with_retry(from: &Path, to: &Path, tries: u32, cancel: Option<&CancellationToken>) -> Result<()> {
    with_lock_retry(|| fs::rename(from, to), tries, cancel).await
}

/// File systems and shares that cannot flush say so this way: not an error of the data
const NO_FLUSH: &[&str] = &["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR", "EBADF", "EPERM"];

/// Asks the disk to keep what was written before the file gets its name:
/// after a power cut or an unplugged disk a name never points to half a
/// file. A file system that cannot flush is not an error; a failed flush (EIO) is.
pub async fn flush_to_disk(file: &fs::File) -> io::Result<()> {
    match file.sync_all().await {
        Ok(()) => Ok(()),
        Err(error) if io_code(&error).is_some_and(|code| NO_FLUSH.contains(&code)) => Ok(()),
        Err(error) => Err(error),
    }
}

/// Flushes a file that is already written and closed (a copy)
pub async fn flush_file(path: &Path) -> io::Result<()> {
    let file = fs::OpenOptions::new().read(true).write(true).open(path).await?;
    flush_to_disk(&file).await
}

/// `count` random bytes as hex, for temporary names
pub fn random_hex(count: usize) -> String {
    let mut bytes = vec![0u8; count];
    rand::rng().fill(&mut bytes[..]);
    hex::encode(bytes)
}

/// `name` + suffix, as a sibling path
pub fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

/// Writes a sibling temporary file, flushed, then renames it over the
/// target; once `cancel` fires, a rename that the share holds is not tried again
pub async fn atomic_write(path: &Path, data: &[u8], cancel: Option<&CancellationToken>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let temp = with_suffix(path, &format!(".{}-{}.tmp", std::process::id(), random_hex(4)));
    let written: Result<()> = async {
        let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(&temp).await?;
        file.write_all(data).await?;
        flush_to_disk(&file).await?;
        drop(file);
        rename_with_retry(&temp, path, 10, cancel).await
    }
    .await;
    if written.is_err() {
        // The cause is the write, not the clean-up
        let _ = unlink_quiet(&temp).await;
    }
    written
}

/// Removes a file; a file that is already gone is fine (false)
pub async fn unlink_quiet(path: &Path) -> io::Result<bool> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub async fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).await.is_ok()
}

pub async fn is_dir(path: &Path) -> bool {
    fs::metadata(path).await.is_ok_and(|m| m.is_dir())
}

/// Does the path answer within `timeout`? A share whose server is gone can
/// keep a stat waiting ~20 s (TCP connect timeout on Windows): we stop
/// waiting earlier (the call itself finishes in the background), and at
/// once when `cancel` fires (`Aborted`).
pub async fn reachable(path: &Path, timeout: Duration, cancel: Option<&CancellationToken>) -> Result<bool> {
    if cancel.is_some_and(|c| c.is_cancelled()) {
        return Err(Error::Aborted);
    }
    let target = path.to_path_buf();
    let stat = tokio::task::spawn_blocking(move || std::fs::metadata(target).is_ok());
    let waited = async {
        match tokio::time::timeout(timeout, stat).await {
            Ok(Ok(answered)) => answered,
            _ => false,
        }
    };
    match cancel {
        Some(token) => tokio::select! {
            answered = waited => Ok(answered),
            _ = token.cancelled() => Err(Error::Aborted),
        },
        None => Ok(waited.await),
    }
}

/// Free bytes for this user (quotas included on Windows); None when the file
/// system does not say
pub async fn free_space(dir: &Path) -> Option<u64> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || free_space_sync(&dir)).await.ok().flatten()
}

#[cfg(windows)]
fn free_space_sync(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    // A share root needs its trailing separator
    if wide.last() != Some(&(b'\\' as u16)) {
        wide.push(b'\\' as u16);
    }
    wide.push(0);
    let mut available = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    // SAFETY: a NUL-terminated wide string and three valid out pointers
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    (ok != 0 && total > 0).then_some(available)
}

#[cfg(unix)]
fn free_space_sync(dir: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a NUL-terminated path and a valid out pointer
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    if stats.f_blocks == 0 {
        return None;
    }
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

#[cfg(not(any(unix, windows)))]
fn free_space_sync(_dir: &Path) -> Option<u64> {
    None
}

/// Can a file be created in `dir`? (Removing the probe is a courtesy: it is a
/// leftover the next run clears)
pub async fn can_write(dir: &Path) -> bool {
    let probe = dir.join(format!(".opmd-probe-{}.tmp", random_hex(4)));
    if fs::write(&probe, b"").await.is_err() {
        return false;
    }
    let _ = unlink_quiet(&probe).await;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomic_write_replaces_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("a.json");
        atomic_write(&file, b"one", None).await.unwrap();
        atomic_write(&file, b"two", None).await.unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        let names: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().collect();
        assert_eq!(names.len(), 1);
    }

    #[tokio::test]
    async fn unlink_quiet_of_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!unlink_quiet(&dir.path().join("none")).await.unwrap());
    }

    #[tokio::test]
    async fn reachable_and_free_space_of_a_local_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(reachable(dir.path(), Duration::from_secs(5), None).await.unwrap());
        assert!(!reachable(&dir.path().join("missing"), Duration::from_secs(5), None).await.unwrap());
        assert!(free_space(dir.path()).await.unwrap_or(1) > 0);
        assert!(can_write(dir.path()).await);
    }
}
