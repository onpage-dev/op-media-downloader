//! What kind of folder a project uses, and whether it is safe: reachable,
//! writable, with hard links or not, free space, protected paths, overlaps
//! with other projects, entries the app did not create, a lock by someone
//! else. Inspecting never creates folders and leaves no file behind.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use super::data_dir::{DataDirOwner, data_dir_owner};
use super::lock::{is_stale, read_lock};
use super::manifest::{DATA_DIR, Manifest, TEMP_PREFIX};
use super::scan::read_entries;
use crate::fsx::{free_space, random_hex, reachable, unlink_quiet};
use crate::models::{DestinationKind, FolderInfo, FolderProblem, ProjectFolder, ProjectId, now_iso};
use crate::sync::names::name_key;

pub const REACH_TIMEOUT: Duration = Duration::from_secs(5);

/// Absolute, `.` and `..` resolved, without a trailing separator (roots keep theirs: `C:\`, `/`)
pub fn normalize(path: &str) -> PathBuf {
    let trimmed = path.trim();
    let absolute = std::path::absolute(trimmed).unwrap_or_else(|_| PathBuf::from(trimmed));
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The drive, the share (`\\server\share\`) or `/` that holds the path
pub fn root_of(path: &Path) -> PathBuf {
    path.ancestors().last().map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf())
}

fn case_sensitive() -> bool {
    cfg!(target_os = "linux")
}

fn comparable(path: &Path) -> String {
    let text = path_text(path);
    if case_sensitive() { text } else { text.to_lowercase() }
}

fn same_path(a: &Path, b: &Path) -> bool {
    comparable(a) == comparable(b)
}

/// a is b, or a is inside b
pub fn is_inside(a: &Path, b: &Path) -> bool {
    let na = comparable(&normalize(&path_text(a)));
    let nb = comparable(&normalize(&path_text(b)));
    if na == nb {
        return true;
    }
    let separator = std::path::MAIN_SEPARATOR;
    let prefix = if nb.ends_with(separator) { nb } else { format!("{nb}{separator}") };
    na.starts_with(&prefix)
}

fn is_share_root(text: &str) -> bool {
    let Some(rest) = text.strip_prefix(r"\\") else {
        return false;
    };
    let parts: Vec<&str> = rest.trim_end_matches('\\').split('\\').collect();
    parts.len() == 2 && parts.iter().all(|p| !p.is_empty())
}

#[allow(deprecated)]
fn home_dir() -> Option<PathBuf> {
    std::env::home_dir()
}

/// Drive roots (not share roots), the home folder and system folders
pub fn is_protected_path(path: &Path) -> bool {
    let resolved = normalize(&path_text(path));
    if resolved.parent().is_none() {
        // A UNC share root (\\server\share\) is a reasonable dedicated destination
        return !is_share_root(&path_text(&resolved));
    }
    let home = home_dir().map(|h| normalize(&path_text(&h)));
    if home.as_ref().is_some_and(|h| same_path(&resolved, h)) {
        return true;
    }
    if cfg!(windows) {
        let env = |name: &str, fallback: &str| std::env::var(name).unwrap_or_else(|_| fallback.to_string());
        let inside_ones = [
            env("SystemRoot", r"C:\Windows"),
            env("ProgramFiles", r"C:\Program Files"),
            env("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            env("ProgramData", r"C:\ProgramData"),
        ];
        // The system folder itself, or anything inside the Windows / Program Files ones
        if inside_ones.iter().any(|dir| is_inside(&resolved, Path::new(dir))) {
            return true;
        }
        // The users' folder itself
        return home.and_then(|h| h.parent().map(Path::to_path_buf)).is_some_and(|users| same_path(&resolved, &users));
    }
    let system: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/System",
            "/Library",
            "/Applications",
            "/Users",
            "/usr",
            "/bin",
            "/sbin",
            "/etc",
            "/var",
            "/private",
            "/opt",
            "/Volumes",
        ]
    } else {
        &[
            "/usr", "/bin", "/sbin", "/etc", "/var", "/proc", "/sys", "/dev", "/boot", "/root", "/home", "/opt",
            "/lib", "/media", "/mnt", "/run",
        ]
    };
    system.iter().any(|dir| same_path(&resolved, Path::new(dir)))
}

/* ------------------------------------------------------------------ kind */

#[cfg(windows)]
fn drive_kind(root: &Path) -> DestinationKind {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let mut wide: Vec<u16> = root.as_os_str().encode_wide().collect();
    if wide.last() != Some(&(b'\\' as u16)) {
        wide.push(b'\\' as u16);
    }
    wide.push(0);
    // SAFETY: a NUL-terminated wide string
    match unsafe { GetDriveTypeW(wide.as_ptr()) } {
        4 => DestinationKind::Network,
        2 | 5 => DestinationKind::Removable,
        3 | 6 => DestinationKind::Local,
        _ => DestinationKind::Unknown,
    }
}

#[cfg(unix)]
fn network_fs(kind: &str) -> bool {
    matches!(
        kind.to_lowercase().as_str(),
        "smbfs"
            | "cifs"
            | "smb3"
            | "smb2"
            | "afpfs"
            | "nfs"
            | "nfs4"
            | "webdav"
            | "davfs"
            | "fuse.sshfs"
            | "9p"
            | "ncpfs"
    )
}

#[cfg(target_os = "linux")]
fn unix_kind(path: &Path) -> DestinationKind {
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return DestinationKind::Unknown;
    };
    let best = mounts
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(' ').collect();
            (parts.len() > 2).then(|| (parts[1].replace("\\040", " "), parts[2].to_string()))
        })
        .filter(|(mount, _)| is_inside(path, Path::new(mount)))
        .max_by_key(|(mount, _)| mount.len());
    let Some((mount, fs)) = best else {
        return DestinationKind::Unknown;
    };
    if network_fs(&fs) {
        return DestinationKind::Network;
    }
    let with_slash = format!("{mount}/");
    if with_slash.starts_with("/media/") || with_slash.starts_with("/run/media/") || with_slash.starts_with("/mnt/") {
        return DestinationKind::Removable;
    }
    DestinationKind::Local
}

#[cfg(target_os = "macos")]
fn unix_kind(path: &Path) -> DestinationKind {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    let Some(existing) = path.ancestors().find(|p| p.exists()) else {
        return DestinationKind::Unknown;
    };
    let Ok(c_path) = CString::new(existing.as_os_str().as_bytes()) else {
        return DestinationKind::Unknown;
    };
    let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: a NUL-terminated path and a valid out pointer
    if unsafe { libc::statfs(c_path.as_ptr(), &mut stats) } != 0 {
        return DestinationKind::Unknown;
    }
    // SAFETY: both are NUL-terminated by the kernel
    let fs = unsafe { CStr::from_ptr(stats.f_fstypename.as_ptr()) }.to_string_lossy().into_owned();
    let mount = unsafe { CStr::from_ptr(stats.f_mntonname.as_ptr()) }.to_string_lossy().into_owned();
    if network_fs(&fs) {
        return DestinationKind::Network;
    }
    if mount.starts_with("/Volumes/") {
        return DestinationKind::Removable;
    }
    DestinationKind::Local
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn unix_kind(_path: &Path) -> DestinationKind {
    DestinationKind::Unknown
}

pub async fn destination_kind(path: &str) -> DestinationKind {
    if path.starts_with(r"\\") || path.starts_with("//") {
        return DestinationKind::Network;
    }
    let resolved = normalize(path);
    if path_text(&resolved).starts_with(r"\\") {
        return DestinationKind::Network;
    }
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        {
            drive_kind(&root_of(&resolved))
        }
        #[cfg(unix)]
        {
            unix_kind(&resolved)
        }
        #[cfg(not(any(unix, windows)))]
        {
            DestinationKind::Unknown
        }
    })
    .await
    .unwrap_or(DestinationKind::Unknown)
}

/* ------------------------------------------------------------------ inspection */

/// The closest existing folder: for free space and reachability of a path still to create
async fn nearest_existing(path: &Path) -> Option<PathBuf> {
    for ancestor in path.ancestors().take(64) {
        if tokio::fs::metadata(ancestor).await.is_ok_and(|m| m.is_dir()) {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// Can create a file, and a hard link to it, in `dir` (then removes both)
async fn probe(dir: &Path) -> (bool, Option<bool>) {
    let base = dir.join(format!("{TEMP_PREFIX}probe-{}", random_hex(4)));
    let file = PathBuf::from(format!("{}.tmp", path_text(&base)));
    let link = PathBuf::from(format!("{}.lnk", path_text(&base)));
    if tokio::fs::write(&file, b"probe").await.is_err() {
        return (false, None);
    }
    let hardlinks = match tokio::fs::hard_link(&file, &link).await {
        Ok(()) => Some(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
        Err(_) => Some(false),
    };
    let _ = unlink_quiet(&link).await;
    let _ = unlink_quiet(&file).await;
    (true, hardlinks)
}

pub struct InspectContext<'a> {
    pub project_id: Option<&'a ProjectId>,
    pub project_folders: &'a [ProjectFolder],
    pub instance_id: Option<&'a str>,
    pub reach_timeout: Duration,
}

pub async fn inspect_folder(folder: &str, ctx: InspectContext<'_>) -> FolderInfo {
    let resolved = normalize(folder);
    let mut problems: Vec<FolderProblem> = Vec::new();
    let mut problem_detail: Option<String> = None;
    let mut info = FolderInfo {
        path: path_text(&resolved),
        kind: DestinationKind::Unknown,
        exists: false,
        writable: false,
        free_bytes: None,
        hardlinks: None,
        foreign_entries: None,
        problems: Vec::new(),
        problem_detail: None,
        onpage_project: None,
        inspected_at: now_iso(),
    };

    if is_protected_path(&resolved) {
        problems.push(FolderProblem::Protected);
    }
    for other in ctx.project_folders {
        if ctx.project_id.is_some_and(|id| *id == other.id) {
            continue;
        }
        let other_folder = Path::new(&other.folder);
        if is_inside(&resolved, other_folder) || is_inside(other_folder, &resolved) {
            problems.push(FolderProblem::UsedByOtherProject);
            problem_detail = Some(other.id.clone());
            break;
        }
    }

    info.kind = destination_kind(folder).await;

    // Reachability: the root of the path (drive or \\server\share) must answer, quickly
    let root = root_of(&resolved);
    if !reachable(&root, ctx.reach_timeout, None).await.unwrap_or(false) {
        problems.push(FolderProblem::Unreachable);
        info.problems = dedupe(problems);
        info.problem_detail = problem_detail;
        return info;
    }

    match tokio::fs::metadata(&resolved).await {
        Ok(meta) => {
            info.exists = meta.is_dir();
            if !info.exists {
                problems.push(FolderProblem::NotWritable);
            }
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => problems.push(FolderProblem::Unreachable),
        Err(_) => {}
    }

    let existing = if info.exists { Some(resolved.clone()) } else { nearest_existing(&resolved).await };
    if let Some(existing) = &existing {
        info.free_bytes = free_space(existing).await;
    }

    if info.exists {
        let data_dir = resolved.join(DATA_DIR);
        let has_data = tokio::fs::metadata(&data_dir).await.is_ok_and(|m| m.is_dir());
        let (writable, hardlinks) = probe(if has_data { &data_dir } else { &resolved }).await;
        info.writable = writable;
        info.hardlinks = hardlinks;
        if !writable {
            problems.push(FolderProblem::NotWritable);
        }

        // Entries the app did not create
        let mut own: HashSet<String> = HashSet::new();
        if has_data && data_dir_owner(&data_dir).await.unwrap_or(DataDirOwner::Ours) == DataDirOwner::Foreign {
            problems.push(FolderProblem::ForeignData);
        } else if has_data {
            // Unreadable now, or of a newer version of the app: the job will tell
            if let Ok(loaded) = Manifest::load(&data_dir, ctx.project_id.map(String::as_str).unwrap_or("")).await {
                own.extend(loaded.manifest.names().iter().map(|n| name_key(n)));
                info.onpage_project = loaded.manifest.onpage_project();
            }
            if let Some(lock) = read_lock(&data_dir).await
                && Some(lock.instance_id.as_str()) != ctx.instance_id
                && !is_stale(&lock, chrono::Utc::now().timestamp_millis(), super::lock::LOCK_STALE)
            {
                problems.push(FolderProblem::Locked);
                problem_detail.get_or_insert(lock.host);
            }
        }
        if let Ok(entries) = read_entries(&resolved).await {
            info.foreign_entries = Some(
                entries
                    .iter()
                    .filter(|(name, _)| {
                        let key = name_key(name);
                        key != DATA_DIR && !name.starts_with(TEMP_PREFIX) && !own.contains(&key)
                    })
                    .count() as u64,
            );
        }
    } else if let Some(existing) = &existing {
        // To be created: the closest existing parent must accept it
        let (writable, hardlinks) = probe(existing).await;
        info.writable = writable;
        info.hardlinks = hardlinks;
        if !writable {
            problems.push(FolderProblem::NotWritable);
        }
    } else {
        problems.push(FolderProblem::Unreachable);
    }

    info.problems = dedupe(problems);
    info.problem_detail = problem_detail;
    info
}

fn dedupe(problems: Vec<FolderProblem>) -> Vec<FolderProblem> {
    let mut out: Vec<FolderProblem> = Vec::new();
    for problem in problems {
        if !out.contains(&problem) {
            out.push(problem);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_inside_others() {
        let base = std::env::temp_dir().join("opmd-a");
        assert!(is_inside(&base.join("b"), &base));
        assert!(is_inside(&base, &base));
        assert!(!is_inside(&std::env::temp_dir().join("opmd-ab"), &base));
        assert!(is_inside(&base.join("x").join("..").join("b"), &base));
    }

    #[test]
    fn protected_folders() {
        let home = home_dir().unwrap();
        assert!(is_protected_path(&home));
        assert!(!is_protected_path(&home.join("Media")));
        assert!(is_protected_path(&root_of(&home)));
        if cfg!(windows) {
            assert!(is_protected_path(Path::new(r"C:\Windows\System32")));
            assert!(!is_protected_path(Path::new(r"\\server\share")));
            assert!(is_share_root(r"\\server\share\"));
        }
    }

    #[tokio::test]
    async fn inspects_a_new_and_an_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let folders = vec![ProjectFolder { id: "other".into(), folder: path_text(&dir.path().join("taken")) }];
        let ctx = || InspectContext {
            project_id: None,
            project_folders: &folders,
            instance_id: None,
            reach_timeout: REACH_TIMEOUT,
        };
        let info = inspect_folder(&path_text(&dir.path().join("new")), ctx()).await;
        assert!(!info.exists && info.writable, "{info:?}");
        assert!(info.problems.is_empty(), "{:?}", info.problems);
        std::fs::write(dir.path().join("mine.txt"), b"x").unwrap();
        let info = inspect_folder(&path_text(dir.path()), ctx()).await;
        assert!(info.exists && info.writable);
        assert_eq!(info.foreign_entries, Some(1));
        assert_eq!(info.problems, vec![FolderProblem::UsedByOtherProject]);
        assert_eq!(info.problem_detail.as_deref(), Some("other"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no probe left behind");
    }
}
