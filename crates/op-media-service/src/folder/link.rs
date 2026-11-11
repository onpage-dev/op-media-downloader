//! Putting a content of data/ in the folder under a name: a hard link, or a
//! copy where links are not supported (FAT/exFAT, some NAS, macOS on SMB).

use std::path::Path;

use super::manifest::TEMP_PREFIX;
use crate::error::{Error, Result, io_code};
use crate::fsx::{flush_file, is_transient_lock_error, path_exists, random_hex, rename_with_retry, unlink_quiet, with_lock_retry};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceMode {
    Link,
    Copy,
}

/// What a file system that cannot link answers: ENOTSUP (SMB without links),
/// EISDIR (Windows on FAT/exFAT: ERROR_INVALID_FUNCTION), EPERM (Linux vfat).
/// On the probe's own new file EPERM and EACCES can only mean that too.
const LINKS_UNSUPPORTED: &[&str] = &["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EISDIR", "EINVAL", "EPERM", "EACCES"];

fn unsupported(error: &Error) -> bool {
    error.code().is_some_and(|code| LINKS_UNSUPPORTED.contains(&code))
}

/// Can the folder hold hard links? A temporary file in data/ is linked, then
/// both go (a leftover is cleared by the next run). A name that later fails
/// to link fails alone: one bad name never turns a whole job into copies.
/// None when the probe file cannot even be written: the work tells.
pub async fn probe_hard_links(data_dir: &Path) -> Option<bool> {
    let base = format!("{TEMP_PREFIX}probe-{}", random_hex(4));
    let file = data_dir.join(format!("{base}.tmp"));
    let link = data_dir.join(format!("{base}.lnk"));
    if tokio::fs::write(&file, b"").await.is_err() {
        return None;
    }
    let result = match tokio::fs::hard_link(&file, &link).await {
        Ok(()) => Some(true),
        Err(error) => io_code(&error).filter(|c| LINKS_UNSUPPORTED.contains(c)).map(|_| false),
    };
    let _ = unlink_quiet(&link).await;
    let _ = unlink_quiet(&file).await;
    result
}

/// A copy under a temporary name, flushed to the disk, then given the name:
/// a copy cut halfway (an unplugged disk, a crash) never sits under the name.
async fn copy_to(blob: &Path, dest: &Path, exclusive: bool) -> Result<()> {
    let dir = dest.parent().unwrap_or(Path::new("."));
    let temp = dir.join(format!("{TEMP_PREFIX}{}", random_hex(6)));
    let result: Result<()> = async {
        tokio::fs::copy(blob, &temp).await?;
        flush_file(&temp).await?;
        // The name was free when the plan was made: a file that appeared since is someone else's
        if exclusive && path_exists(dest).await {
            return Err(Error::Io(std::io::Error::from(std::io::ErrorKind::AlreadyExists)));
        }
        rename_with_retry(&temp, dest, 10, None).await
    }
    .await;
    if result.is_err() {
        let _ = unlink_quiet(&temp).await;
    }
    result
}

async fn link_or_copy(blob: &Path, dest: &Path, hardlinks: Option<bool>, exclusive: bool) -> Result<PlaceMode> {
    if hardlinks != Some(false) {
        match with_lock_retry(|| tokio::fs::hard_link(blob, dest), 4, None).await {
            Ok(()) => return Ok(PlaceMode::Link),
            Err(error) => {
                // NTFS takes 1023 names per file: this content gets a copy, the others
                // keep their links. Without a probe, a refusal gets a copy for this name only
                let copy = error.code() == Some("EMLINK") || (hardlinks.is_none() && unsupported(&error));
                if !copy {
                    return Err(error);
                }
            }
        }
    }
    copy_to(blob, dest, exclusive).await?;
    Ok(PlaceMode::Copy)
}

/// A rename or removal refused by a lock that did not go away: on Windows, the file is open somewhere
fn in_use(error: Error, name: &str) -> Error {
    if cfg!(windows) && is_transient_lock_error(&error) {
        if let Error::Io(source) = error {
            return Error::InUse { name: name.to_string(), source };
        }
    }
    error
}

/// A plain name of the folder: never a path
pub fn check_name(name: &str) -> Result<()> {
    let plain = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && Path::new(name).file_name().is_some_and(|f| f == name);
    if plain { Ok(()) } else { Err(Error::Other(format!("Unsafe name: {name}"))) }
}

pub struct Place<'a> {
    pub folder: &'a Path,
    pub data_dir: &'a Path,
    pub name: &'a str,
    pub token: &'a str,
    /// A name of ours (same key) to replace atomically
    pub replace: Option<&'a str>,
    /// Links or copies, decided once per job; None when the probe could not run
    pub hardlinks: Option<bool>,
}

/// New names are created exclusively: if something appeared there since the
/// plan, it is a conflict and stays untouched. Replacements go through a
/// temporary name and a rename, so the old file is never missing.
pub async fn place_name(options: Place<'_>) -> Result<PlaceMode> {
    check_name(options.name)?;
    let blob = options.data_dir.join(options.token);
    let target = options.folder.join(options.name);
    let Some(replace) = options.replace else {
        return match link_or_copy(&blob, &target, options.hardlinks, true).await {
            Err(error) if error.code() == Some("EEXIST") => Err(Error::Conflict(options.name.to_string())),
            other => other,
        };
    };
    check_name(replace)?;
    let temp = options.folder.join(format!("{TEMP_PREFIX}{}", random_hex(6)));
    let result: Result<PlaceMode> = async {
        let mode = link_or_copy(&blob, &temp, options.hardlinks, false).await?;
        let swap: Result<()> = async {
            if replace != options.name {
                // Different case: free the old name first (same file on case-insensitive folders)
                let old = options.folder.join(replace);
                with_lock_retry(|| unlink_quiet(&old), 4, None).await?;
            }
            rename_with_retry(&temp, &target, 10, None).await
        }
        .await;
        swap.map_err(|e| in_use(e, replace))?;
        Ok(mode)
    }
    .await;
    if result.is_err() {
        let _ = unlink_quiet(&temp).await;
    }
    result
}

/// Only the case of a name changes: same file, new name
pub async fn rename_name(folder: &Path, from: &str, to: &str) -> Result<()> {
    check_name(from)?;
    check_name(to)?;
    rename_with_retry(&folder.join(from), &folder.join(to), 10, None).await.map_err(|e| in_use(e, from))
}

/// Removes a name of ours; a file open in another program (Windows) is `InUse`
pub async fn remove_name(folder: &Path, name: &str) -> Result<bool> {
    check_name(name)?;
    let path = folder.join(name);
    with_lock_retry(|| unlink_quiet(&path), 4, None).await.map_err(|e| in_use(e, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn links_then_refuses_a_name_that_appeared() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("tok"), b"content").unwrap();
        let hardlinks = probe_hard_links(&data).await;
        assert_eq!(hardlinks, Some(true));
        let place = |name: &'static str, replace: Option<&'static str>| Place {
            folder: dir.path(),
            data_dir: &data,
            name,
            token: "tok",
            replace,
            hardlinks,
        };
        assert_eq!(place_name(place("a.jpg", None)).await.unwrap(), PlaceMode::Link);
        assert!(matches!(place_name(place("a.jpg", None)).await, Err(Error::Conflict(_))));
        // A replacement of one of ours (another case) goes through a temporary name
        assert_eq!(place_name(place("A.JPG", Some("a.jpg"))).await.unwrap(), PlaceMode::Link);
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "data and the name: {names:?}");
        assert!(remove_name(dir.path(), "A.JPG").await.unwrap());
        assert!(check_name("../x").is_err());
        assert!(check_name("a/b").is_err());
    }
}
