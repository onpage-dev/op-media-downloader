//! data/manifest.json: the registry of what the app created in a folder.
//! Only names listed here (and contents in data/) can ever be removed.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, JobError, Result};
use crate::fsx::{atomic_write, with_lock_retry};
use crate::models::{IssueCode, OnPageProject, now_iso};
use crate::sync::names::{is_safe_token, name_key, nfc, sanitize_name};

pub const DATA_DIR: &str = "data";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const LINK_JSON_FILE: &str = "link.json";
pub const LOCK_FILE: &str = ".lock";
/// Prefix of the app's temporary names in the project folder
pub const TEMP_PREFIX: &str = ".opmd-";

/// The registry's format; a newer one is another app's to read
const VERSION: u64 = 2;
const MIN_CHECKPOINT: Duration = Duration::from_secs(5);
const MAX_CHECKPOINT: Duration = Duration::from_secs(30);
const CHECKPOINT_CHANGES: u64 = 500;

/// How the name was made: a hard link to data/<token>, a copy of it, a file
/// found in place and recognised as ours, or imported from 1.x (unknown)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestMode {
    Link,
    Copy,
    Adopted,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub mode: ManifestMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestSource {
    Manifest,
    LinkJson,
    Empty,
}

#[derive(Serialize)]
struct ManifestJson<'a> {
    version: u64,
    project_id: &'a str,
    /// The On Page project the folder is synced with (missing before its first sync)
    #[serde(skip_serializing_if = "Option::is_none")]
    onpage_project: Option<&'a OnPageProject>,
    updated_at: String,
    files: &'a BTreeMap<String, ManifestEntry>,
}

struct State {
    onpage_project: Option<OnPageProject>,
    written_project: Option<OnPageProject>,
    /// The registry is a file already: a new On Page project is written at once
    on_disk: bool,
    files: BTreeMap<String, ManifestEntry>,
    keys: HashMap<String, String>,
    changes: u64,
    last_flush: Instant,
    last_flush_took: Duration,
}

impl State {
    fn put(&mut self, name: String, entry: ManifestEntry) {
        let key = name_key(&name);
        self.keys.entry(key).or_insert_with(|| name.clone());
        self.files.insert(name, entry);
    }
}

/// The registry of a folder, shared by the workers of a job: every method takes `&self`
pub struct Manifest {
    pub data_dir: PathBuf,
    pub project_id: String,
    state: Mutex<State>,
    /// One write at a time
    flushing: tokio::sync::Mutex<()>,
}

pub struct ManifestLoad {
    pub manifest: Manifest,
    pub source: ManifestSource,
    /// manifest.json existed but could not be read
    pub recovered: bool,
}

/// The On Page project of a registry read from the disk, when it is one
fn onpage_project(value: &Value) -> Option<OnPageProject> {
    let id = value.get("id")?.as_i64()?;
    let label = value.get("label")?.as_str()?;
    Some(OnPageProject { id, label: label.to_string() })
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && sanitize_name(name) == nfc(name)
}

/// A file that is not there is None; one that cannot be read (a share that
/// dropped, an antivirus holding it) is an error: starting from an empty
/// registry would forget which names are ours.
async fn read_text(file: &Path) -> Result<Option<String>> {
    match with_lock_retry(|| tokio::fs::read(file), 4, None).await {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.is_not_found() => Ok(None),
        Err(error) => Err(error),
    }
}

impl Manifest {
    pub fn new(data_dir: &Path, project_id: &str) -> Manifest {
        Manifest {
            data_dir: data_dir.to_path_buf(),
            project_id: project_id.to_string(),
            state: Mutex::new(State {
                onpage_project: None,
                written_project: None,
                on_disk: false,
                files: BTreeMap::new(),
                keys: HashMap::new(),
                changes: 0,
                last_flush: Instant::now(),
                last_flush_took: Duration::ZERO,
            }),
            flushing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn file(data_dir: &Path) -> PathBuf {
        data_dir.join(MANIFEST_FILE)
    }

    /// A manifest written by a newer version of the app is refused, untouched:
    /// read as broken, it would be rebuilt and overwritten with our format
    pub async fn load(data_dir: &Path, project_id: &str) -> Result<ManifestLoad> {
        let manifest = Manifest::new(data_dir, project_id);
        let mut recovered = false;
        if let Some(text) = read_text(&Manifest::file(data_dir)).await? {
            let json: Option<Value> = serde_json::from_str(&text).ok();
            let version = json.as_ref().and_then(|j| j.get("version")).and_then(Value::as_f64);
            if let Some(version) = version.filter(|v| *v > VERSION as f64) {
                return Err(Error::Job(JobError::with_detail(
                    IssueCode::FolderProtected,
                    "The folder was synced by a newer version of the app",
                    format!(
                        "The folder was synced by a newer version of the app (data/{MANIFEST_FILE} version {version})"
                    ),
                )));
            }
            let files = json.as_ref().and_then(|j| j.get("files")).and_then(Value::as_object);
            if let (Some(json), Some(files), Some(_)) = (&json, files, version.filter(|v| *v == VERSION as f64)) {
                {
                    let mut state = manifest.state.lock();
                    state.on_disk = true;
                    state.onpage_project = json.get("onpage_project").and_then(onpage_project);
                    state.written_project = state.onpage_project.clone();
                    for (name, entry) in files {
                        let Some(token) = entry.get("token").and_then(Value::as_str) else {
                            continue;
                        };
                        if !valid_name(name) || !is_safe_token(token) {
                            continue;
                        }
                        let mode = entry
                            .get("mode")
                            .and_then(|m| serde_json::from_value::<ManifestMode>(m.clone()).ok())
                            .unwrap_or(ManifestMode::Unknown);
                        state.put(
                            name.clone(),
                            ManifestEntry {
                                token: token.to_string(),
                                size: entry.get("size").and_then(Value::as_f64).map(|s| s as u64),
                                mode,
                                remote_name: entry.get("remote_name").and_then(Value::as_str).map(str::to_string),
                            },
                        );
                    }
                }
                return Ok(ManifestLoad { manifest, source: ManifestSource::Manifest, recovered });
            }
            recovered = true;
        }
        // 1.x: { "<name>": "<token>" }
        if let Some(text) = read_text(&data_dir.join(LINK_JSON_FILE)).await?
            && let Ok(Value::Object(links)) = serde_json::from_str::<Value>(&text)
        {
            {
                let mut state = manifest.state.lock();
                for (name, token) in links {
                    let Some(token) = token.as_str() else {
                        continue;
                    };
                    if valid_name(&name) && is_safe_token(token) {
                        let entry = ManifestEntry {
                            token: token.to_string(),
                            size: None,
                            mode: ManifestMode::Unknown,
                            remote_name: Some(name.clone()),
                        };
                        state.put(name, entry);
                    }
                }
                state.changes = state.files.len() as u64;
            }
            return Ok(ManifestLoad { manifest, source: ManifestSource::LinkJson, recovered });
        }
        Ok(ManifestLoad { manifest, source: ManifestSource::Empty, recovered })
    }

    pub fn len(&self) -> usize {
        self.state.lock().files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn entries(&self) -> Vec<(String, ManifestEntry)> {
        self.state.lock().files.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.state.lock().files.keys().cloned().collect()
    }

    pub fn get(&self, name: &str) -> Option<ManifestEntry> {
        self.state.lock().files.get(name).cloned()
    }

    /// The entry whose name is the same ignoring case
    pub fn by_key(&self, key: &str) -> Option<(String, ManifestEntry)> {
        let state = self.state.lock();
        let name = state.keys.get(key)?;
        state.files.get(name).map(|entry| (name.clone(), entry.clone()))
    }

    /// Adds or replaces; an entry differing only in case is replaced
    pub fn set(&self, name: &str, entry: ManifestEntry) {
        let mut state = self.state.lock();
        let key = name_key(name);
        if let Some(previous) = state.keys.get(&key).cloned()
            && previous != name
        {
            state.files.remove(&previous);
        }
        state.files.insert(name.to_string(), entry);
        state.keys.insert(key, name.to_string());
        state.changes += 1;
    }

    pub fn delete(&self, name: &str) {
        let mut state = self.state.lock();
        if state.files.remove(name).is_none() {
            return;
        }
        let key = name_key(name);
        if state.keys.get(&key).is_some_and(|n| n == name) {
            state.keys.remove(&key);
        }
        state.changes += 1;
    }

    /// The On Page project the folder is synced with
    pub fn onpage_project(&self) -> Option<OnPageProject> {
        self.state.lock().onpage_project.clone()
    }

    /// The one the file on the disk names
    pub fn written_project(&self) -> Option<OnPageProject> {
        self.state.lock().written_project.clone()
    }

    /// The folder is this On Page project's. A registry already on the disk
    /// names it at the next write; a new one with its first file, so that a
    /// «Sincronizza» leaves no trace in a new folder.
    pub fn bind(&self, project: &OnPageProject) {
        let mut state = self.state.lock();
        if state.onpage_project.as_ref() == Some(project) {
            return;
        }
        state.onpage_project = Some(project.clone());
        if state.on_disk {
            state.changes += 1;
        }
    }

    /// Writes now (atomically), when anything changed
    pub async fn flush(&self) -> Result<()> {
        let _writing = self.flushing.lock().await;
        let (data, changes, project) = {
            let state = self.state.lock();
            if state.changes == 0 {
                return Ok(());
            }
            let json = ManifestJson {
                version: VERSION,
                project_id: &self.project_id,
                onpage_project: state.onpage_project.as_ref(),
                updated_at: now_iso(),
                files: &state.files,
            };
            let data = serde_json::to_vec(&json).map_err(|e| Error::Other(e.to_string()))?;
            (data, state.changes, state.onpage_project.clone())
        };
        let started = Instant::now();
        atomic_write(&Manifest::file(&self.data_dir), &data, None).await?;
        let mut state = self.state.lock();
        state.changes = state.changes.saturating_sub(changes);
        state.on_disk = true;
        state.written_project = project;
        state.last_flush = Instant::now();
        state.last_flush_took = started.elapsed();
        Ok(())
    }

    /// Writes when enough happened: 500 changes and 5 s, or 30 s with any
    /// change; never more often than ten times the last write took (a big
    /// manifest on a slow share).
    pub async fn checkpoint(&self) -> Result<()> {
        let due = {
            let state = self.state.lock();
            if state.changes == 0 {
                return Ok(());
            }
            let elapsed = state.last_flush.elapsed();
            let floor = MIN_CHECKPOINT.max(state.last_flush_took * 10);
            elapsed >= floor && (state.changes >= CHECKPOINT_CHANGES || elapsed >= MAX_CHECKPOINT.max(floor))
        };
        // A write in flight: the next checkpoint will do
        if !due || self.flushing.try_lock().is_err() {
            return Ok(());
        }
        self.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(token: &str) -> ManifestEntry {
        ManifestEntry { token: token.into(), size: Some(1), mode: ManifestMode::Link, remote_name: None }
    }

    #[tokio::test]
    async fn writes_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = Manifest::new(dir.path(), "p");
        manifest.set("A.jpg", entry("t1"));
        manifest.set("a.JPG", entry("t2"));
        assert_eq!(manifest.len(), 1, "same name ignoring case replaces");
        manifest.bind(&OnPageProject { id: 77, label: "Catalogo".into() });
        manifest.flush().await.unwrap();
        let loaded = Manifest::load(dir.path(), "p").await.unwrap();
        assert_eq!(loaded.source, ManifestSource::Manifest);
        assert_eq!(loaded.manifest.get("a.JPG").unwrap().token, "t2");
        assert_eq!(loaded.manifest.by_key("a.jpg").unwrap().0, "a.JPG");
        assert_eq!(loaded.manifest.onpage_project().unwrap().id, 77);
    }

    #[tokio::test]
    async fn imports_link_json_and_skips_unsafe_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(LINK_JSON_FILE), r#"{"a.jpg":"tok1","../x":"tok2","b.jpg":"../evil"}"#).unwrap();
        let loaded = Manifest::load(dir.path(), "p").await.unwrap();
        assert_eq!(loaded.source, ManifestSource::LinkJson);
        assert_eq!(loaded.manifest.len(), 1);
    }

    #[tokio::test]
    async fn a_broken_manifest_is_recovered_and_a_newer_one_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(MANIFEST_FILE), "{ cut by a power").unwrap();
        let loaded = Manifest::load(dir.path(), "p").await.unwrap();
        assert!(loaded.recovered);
        assert_eq!(loaded.source, ManifestSource::Empty);
        std::fs::write(dir.path().join(MANIFEST_FILE), r#"{"version":3,"files":{}}"#).unwrap();
        let Err(Error::Job(error)) = Manifest::load(dir.path(), "p").await else { panic!("refused") };
        assert_eq!(error.issue, IssueCode::FolderProtected);
    }

    #[tokio::test]
    async fn a_new_registry_names_its_project_with_the_first_file() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = Manifest::new(dir.path(), "p");
        manifest.bind(&OnPageProject { id: 1, label: "x".into() });
        manifest.flush().await.unwrap();
        assert!(!Manifest::file(dir.path()).exists(), "a bind alone leaves no trace");
    }
}
