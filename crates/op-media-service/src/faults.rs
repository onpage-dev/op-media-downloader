//! Disk faults on demand, for the tests and for trying the app with the fake
//! On Page (feature `fake-server`): a test arms a fault for one operation
//! under its own folder, and the service's own calls fail there as a real
//! disk would, with the error's POSIX code (`error::io_code` reads it on every
//! system, so the same test means the same on Windows, macOS and Linux).
//! Release builds have none of it: the hooks (`fault!`) compile to nothing.
//!
//! What it plays: a disk that fills up in the middle of a write, a share
//! that drops or stops answering, a read-only folder, an antivirus holding a
//! new file, a file open in another program, a folder without hard links, a
//! flush or a rename that fails, too little free space.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use crate::error::InjectedFault;

/// The disk operations the service's hooks name
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// A new file (a download's temporary file, a probe)
    Create,
    /// Bytes written to a download (`after_bytes`: the size the write would reach)
    Write,
    /// A flush to the disk
    Flush,
    /// A rename (the path is the new name)
    Rename,
    /// A hard link (the path is the new name)
    Link,
    /// A copy (the path is the new name)
    Copy,
    Remove,
    /// Listing a folder
    ReadDir,
    /// Looking at a path: the folder answering at all
    Stat,
    CreateDir,
    /// The free space a folder reports (`after_bytes` is the bytes it says)
    FreeSpace,
}

#[derive(Debug, Clone)]
pub struct Fault {
    pub op: Op,
    /// Only paths under this folder: tests run side by side
    pub under: PathBuf,
    /// Only file names containing this
    pub name: Option<String>,
    /// The POSIX code of the error (ENOSPC, EIO, EROFS, EBUSY…)
    pub code: &'static str,
    /// Writes: once the file would hold this many bytes; free space: the bytes reported
    pub after_bytes: Option<u64>,
    /// How many times it fires; None: every time
    pub times: Option<u32>,
}

impl Fault {
    pub fn new(op: Op, under: &Path, code: &'static str) -> Fault {
        Fault { op, under: under.to_path_buf(), name: None, code, after_bytes: None, times: None }
    }

    /// The folder reports this much free space
    pub fn free_space(under: &Path, bytes: u64) -> Fault {
        Fault { after_bytes: Some(bytes), ..Fault::new(Op::FreeSpace, under, "") }
    }

    pub fn named(mut self, part: &str) -> Fault {
        self.name = Some(part.to_string());
        self
    }

    pub fn after(mut self, bytes: u64) -> Fault {
        self.after_bytes = Some(bytes);
        self
    }

    pub fn times(mut self, times: u32) -> Fault {
        self.times = Some(times);
        self
    }
}

struct Armed {
    id: u64,
    fault: Fault,
    hits: u32,
}

static FAULTS: Mutex<Vec<Armed>> = Mutex::new(Vec::new());
/// Fast path: nothing armed, nothing to look at
static ARMED: AtomicUsize = AtomicUsize::new(0);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// An armed fault: disarmed when dropped
pub struct FaultGuard(u64);

impl FaultGuard {
    /// How many times it fired
    pub fn hits(&self) -> u32 {
        faults().iter().find(|armed| armed.id == self.0).map_or(0, |armed| armed.hits)
    }
}

impl Drop for FaultGuard {
    fn drop(&mut self) {
        let mut faults = faults();
        let before = faults.len();
        faults.retain(|armed| armed.id != self.0);
        ARMED.fetch_sub(before - faults.len(), Ordering::SeqCst);
    }
}

pub fn arm(fault: Fault) -> FaultGuard {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    faults().push(Armed { id, fault, hits: 0 });
    ARMED.fetch_add(1, Ordering::SeqCst);
    FaultGuard(id)
}

fn faults() -> std::sync::MutexGuard<'static, Vec<Armed>> {
    FAULTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The error an armed fault gives this operation on this path
pub fn check(op: Op, path: &Path) -> io::Result<()> {
    match fire(op, path, None) {
        Some(code) => Err(error(code)),
        None => Ok(()),
    }
}

/// A write that would bring the file to `size` bytes
pub fn check_write(path: &Path, size: u64) -> io::Result<()> {
    match fire(Op::Write, path, Some(size)) {
        Some(code) => Err(error(code)),
        None => Ok(()),
    }
}

/// The free space a fault makes the folder report
pub fn free_space(path: &Path) -> Option<u64> {
    if ARMED.load(Ordering::SeqCst) == 0 {
        return None;
    }
    let faults = faults();
    let fault = faults.iter().map(|armed| &armed.fault).find(|f| f.op == Op::FreeSpace && matches(f, path))?;
    fault.after_bytes
}

fn fire(op: Op, path: &Path, size: Option<u64>) -> Option<&'static str> {
    if ARMED.load(Ordering::SeqCst) == 0 {
        return None;
    }
    let mut faults = faults();
    let armed = faults.iter_mut().find(|armed| {
        let fault = &armed.fault;
        fault.op == op
            && matches(fault, path)
            && fault.after_bytes.is_none_or(|after| size.is_some_and(|size| size > after))
            && fault.times.is_none_or(|times| armed.hits < times)
    })?;
    armed.hits += 1;
    Some(armed.fault.code)
}

fn matches(fault: &Fault, path: &Path) -> bool {
    path.starts_with(&fault.under)
        && fault
            .name
            .as_ref()
            .is_none_or(|part| path.file_name().is_some_and(|name| name.to_string_lossy().contains(part.as_str())))
}

/// An error as the system gives it: its kind where code reads one, its POSIX code for `io_code`
pub fn error(code: &'static str) -> io::Error {
    let kind = match code {
        "ENOENT" => io::ErrorKind::NotFound,
        "EEXIST" => io::ErrorKind::AlreadyExists,
        "EACCES" | "EPERM" => io::ErrorKind::PermissionDenied,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, InjectedFault(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::io_code;

    #[test]
    fn a_fault_fires_where_it_is_armed_and_as_often() {
        let root = Path::new("/faults-test/a");
        let guard = arm(Fault::new(Op::Rename, root, "EBUSY").named(".jpg").times(2));
        assert!(check(Op::Rename, Path::new("/faults-test/b/x.jpg")).is_ok(), "another folder");
        assert!(check(Op::Remove, &root.join("x.jpg")).is_ok(), "another operation");
        assert!(check(Op::Rename, &root.join("x.pdf")).is_ok(), "another name");
        let busy = check(Op::Rename, &root.join("x.jpg")).unwrap_err();
        assert_eq!(io_code(&busy), Some("EBUSY"));
        assert!(check(Op::Rename, &root.join("y.jpg")).is_err());
        assert!(check(Op::Rename, &root.join("z.jpg")).is_ok(), "twice only");
        assert_eq!(guard.hits(), 2);
        drop(guard);

        let _full = arm(Fault::new(Op::Write, root, "ENOSPC").after(1000));
        assert!(check_write(&root.join("f"), 1000).is_ok());
        assert_eq!(io_code(&check_write(&root.join("f"), 1001).unwrap_err()), Some("ENOSPC"));
        assert_eq!(error("ENOENT").kind(), io::ErrorKind::NotFound);
    }
}
