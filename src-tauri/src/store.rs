//! App store: settings, projects, the last known state of each project and
//! the window bounds, in `op-media-downloader-config.json` (the same shape as
//! the Electron app's file, version 2, migrated from 1.x on first start).
//!
//! The app is the only writer: the file is read once and written atomically
//! (temporary file, then rename) at every change. Every value read back is
//! checked (a hand-edited or half-written file must not break the app), and
//! a file that cannot be parsed is set aside: the app starts without projects
//! and tells the user where the old file is.
//!
//! Tokens live in the system's credential store (Windows Credential Manager,
//! macOS Keychain, the Secret Service on Linux), one entry per project, and in
//! memory once read. Only where the system has none they stay in the file,
//! in clear (`token_plain`), as the Electron app did. The Electron app's
//! encrypted tokens (`token_enc`) are moved there at the first start.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use op_media_service::{FolderInfo, Issue, OnPageProject, PlanSummary, ProjectId, SyncResult};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::models::*;
use crate::os_crypt::SafeStorage;
use crate::validate::{clean_settings, concurrency, is_project_id, language};
use crate::{error, info, warn};

pub const STORE_FILE: &str = "op-media-downloader-config.json";
const STORE_NAME: &str = "op-media-downloader-config";
const STORE_VERSION: i64 = 2;
/// The 1.x keys: `storage_data` held the projects with their tokens in clear, `user_properties` the settings
const V1_KEYS: [&str; 2] = ["storage_data", "user_properties"];
/// created_at of a project saved without one
const EPOCH: &str = "1970-01-01T00:00:00.000Z";

#[derive(Debug, Clone, Serialize)]
pub struct StoredProject {
    pub id: ProjectId,
    pub label: String,
    pub folder: String,
    pub keep_old_files: bool,
    pub created_at: String,
    /// The Electron app's safeStorage token (base64), until it is moved to the credential store
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_enc: Option<String>,
    /// Only where the system offers no credential store (some Linux setups)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_plain: Option<String>,
    /// The token is in the system's credential store, under the project's id
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub token_keyring: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_result: Option<SyncResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<PlanSummary>,
    /// Issues still valid after a restart (failed files, duplicates, copies)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues: Option<Vec<Issue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_info: Option<FolderInfo>,
    /// The On Page project the folder was last saved with by this project
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onpage_project: Option<OnPageProject>,
    /// The user chose the folder for the token (a new project, another token
    /// or folder): until a job saves the folder's registry, it may take the
    /// folder over from another On Page project
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub take_over_folder: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct WindowState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

/// Where tokens are kept: the system's credential store, or memory in tests
pub trait TokenVault: Send + Sync {
    fn set(&self, id: &str, token: &str) -> Result<(), String>;
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn delete(&self, id: &str);
}

/// The system's credential store, one entry per project under `service`
pub struct KeyringVault {
    service: String,
}

impl KeyringVault {
    pub fn new(service: &str) -> KeyringVault {
        KeyringVault {
            service: service.to_string(),
        }
    }

    fn entry(&self, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, id).map_err(|e| e.to_string())
    }
}

impl TokenVault for KeyringVault {
    fn set(&self, id: &str, token: &str) -> Result<(), String> {
        self.entry(id)?
            .set_password(token)
            .map_err(|e| e.to_string())
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match self.entry(id)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn delete(&self, id: &str) {
        if let Ok(entry) = self.entry(id) {
            let _ = entry.delete_credential();
        }
    }
}

pub struct StoreOptions {
    pub dir: PathBuf,
    /// The language of a new install: the system's one
    pub default_language: AppLanguage,
    pub vault: Box<dyn TokenVault>,
    /// The Electron app's folder, to read its encrypted tokens
    pub legacy: Option<SafeStorage>,
}

pub struct AppStore {
    file: PathBuf,
    data: Mutex<Map<String, Value>>,
    default_language: AppLanguage,
    vault: Box<dyn TokenVault>,
    legacy: Option<SafeStorage>,
    /// Each project's token in clear, as read at start-up or saved since: empty when it cannot be read here
    tokens: Mutex<HashMap<ProjectId, String>>,
    /// Where a config file that could not be parsed was set aside, to tell the user
    pub set_aside: Option<PathBuf>,
}

impl AppStore {
    pub fn open(options: StoreOptions) -> AppStore {
        let _ = fs::create_dir_all(&options.dir);
        let file = options.dir.join(STORE_FILE);
        let (data, set_aside) = read_store(&file);
        let store = AppStore {
            file,
            data: Mutex::new(data),
            default_language: options.default_language,
            vault: options.vault,
            legacy: options.legacy,
            tokens: Mutex::new(HashMap::new()),
            set_aside,
        };
        store.migrate();
        store
    }

    /* ---------------------------------------------------------------- settings */

    pub fn settings(&self) -> AppSettings {
        let fallback = AppSettings {
            language: self.default_language,
            ..DEFAULT_SETTINGS
        };
        clean_settings(self.data.lock().get("settings"), &fallback)
    }

    pub fn set_settings(&self, next: &AppSettings) {
        self.write(|data| {
            data.insert(
                "settings".into(),
                serde_json::to_value(next).unwrap_or(Value::Null),
            );
        });
    }

    /* ---------------------------------------------------------------- projects */

    pub fn projects(&self) -> Vec<StoredProject> {
        let data = self.data.lock();
        let mut projects: Vec<StoredProject> = match data.get("projects") {
            Some(Value::Object(map)) => map
                .iter()
                .filter_map(|(id, value)| read_project(id, value))
                .collect(),
            _ => Vec::new(),
        };
        projects.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        projects
    }

    pub fn project(&self, id: &str) -> Option<StoredProject> {
        let data = self.data.lock();
        data.get("projects")?
            .as_object()?
            .get(id)
            .and_then(|value| read_project(id, value))
    }

    pub fn save_project(&self, project: &StoredProject) -> Result<(), String> {
        if !is_project_id(&project.id) {
            return Err("invalid_input".into());
        }
        let value = serde_json::to_value(project).map_err(|e| e.to_string())?;
        self.write(|data| {
            let projects = data
                .entry("projects")
                .or_insert_with(|| Value::Object(Map::new()));
            if !projects.is_object() {
                *projects = Value::Object(Map::new());
            }
            projects
                .as_object_mut()
                .unwrap()
                .insert(project.id.clone(), value);
        });
        Ok(())
    }

    /// Changes a project as it is now; None when there is no such project
    pub fn patch_project(
        &self,
        id: &str,
        patch: impl FnOnce(&mut StoredProject),
    ) -> Option<StoredProject> {
        let mut project = self.project(id)?;
        patch(&mut project);
        project.id = id.to_string();
        self.save_project(&project).ok()?;
        Some(project)
    }

    pub fn remove_project(&self, id: &str) {
        let removed = {
            let mut data = self.data.lock();
            let removed = data
                .get_mut("projects")
                .and_then(Value::as_object_mut)
                .and_then(|map| map.remove(id))
                .is_some();
            if removed {
                self.flush(&data);
            }
            removed
        };
        if removed {
            self.vault.delete(id);
            self.tokens.lock().remove(id);
        }
    }

    /* ---------------------------------------------------------------- tokens */

    /// Keeps a project's token: in the credential store where the system has
    /// one, else in the file. The fields to save with the project
    pub fn store_token(&self, id: &str, token: &str) -> TokenFields {
        self.tokens.lock().insert(id.to_string(), token.to_string());
        match self.vault.set(id, token) {
            Ok(()) => TokenFields {
                token_keyring: true,
                token_plain: None,
            },
            Err(error) => {
                warn!(
                    "No credential store for the token of project {id}: kept in the settings file ({error})"
                );
                TokenFields {
                    token_keyring: false,
                    token_plain: Some(token.to_string()),
                }
            }
        }
    }

    /// Once, before the tokens are read: reads them from the credential store,
    /// and moves there in one write those saved in clear (the system had no
    /// credential store then, or 1.x had them) and the Electron app's
    /// encrypted ones
    pub fn unlock_tokens(&self) {
        let mut renew: Vec<(ProjectId, String)> = Vec::new();
        for project in self.projects() {
            if project.token_keyring {
                let token = match self.vault.get(&project.id) {
                    Ok(token) => token.unwrap_or_default(),
                    Err(error) => {
                        error!(
                            "Cannot read the token of project {} from the credential store: {error}",
                            project.id
                        );
                        String::new()
                    }
                };
                self.tokens.lock().insert(project.id.clone(), token);
            } else if let Some(token_enc) = &project.token_enc {
                match self
                    .legacy
                    .as_ref()
                    .and_then(|legacy| legacy.decrypt(token_enc))
                {
                    Some(token) => renew.push((project.id.clone(), token)),
                    None => {
                        error!(
                            "Cannot decrypt the token of project {}: the user is asked for it again",
                            project.id
                        );
                        self.tokens.lock().insert(project.id.clone(), String::new());
                    }
                }
            } else if let Some(token) = &project.token_plain {
                renew.push((project.id.clone(), token.clone()));
            }
        }
        let mut moved = 0;
        for (id, token) in renew {
            let fields = self.store_token(&id, &token);
            if !fields.token_keyring && self.project(&id).is_some_and(|p| p.token_enc.is_none()) {
                // Already in clear in the file and still no credential store: nothing to write
                continue;
            }
            moved += 1;
            self.patch_project(&id, |project| {
                project.token_enc = None;
                project.token_keyring = fields.token_keyring;
                project.token_plain = fields.token_plain;
            });
        }
        if moved > 0 {
            info!("Tokens of {moved} projects moved to the credential store");
        }
    }

    /// The token in clear; empty when there is none or it cannot be read here
    pub fn token(&self, project: &StoredProject) -> String {
        if let Some(token) = self.tokens.lock().get(&project.id) {
            return token.clone();
        }
        project.token_plain.clone().unwrap_or_default()
    }

    /// A token that cannot be read here (the file comes from another user or computer) does not count
    pub fn has_token(&self, project: &StoredProject) -> bool {
        !self.token(project).is_empty()
    }

    /* ---------------------------------------------------------------- window */

    pub fn window_state(&self) -> Option<WindowState> {
        let data = self.data.lock();
        let state = data.get("window_state")?.as_object()?;
        let number = |key: &str| {
            state
                .get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
        };
        Some(WindowState {
            x: number("x"),
            y: number("y"),
            width: number("width")?,
            height: number("height")?,
            maximized: state.get("maximized") == Some(&Value::Bool(true)),
        })
    }

    pub fn set_window_state(&self, state: &WindowState) {
        self.write(|data| {
            data.insert(
                "window_state".into(),
                serde_json::to_value(state).unwrap_or(Value::Null),
            );
        });
    }

    /* ---------------------------------------------------------------- file */

    fn write(&self, change: impl FnOnce(&mut Map<String, Value>)) {
        let mut data = self.data.lock();
        change(&mut data);
        self.flush(&data);
    }

    fn flush(&self, data: &Map<String, Value>) {
        if let Err(error) = write_atomic(&self.file, data) {
            error!("The settings file cannot be written: {error}");
        }
    }

    /* ---------------------------------------------------------------- migration */

    /// 1.x → 2: settings, projects, version, in one write (the tokens move to
    /// the credential store with unlock_tokens right after). The 1.x keys go
    /// whenever they are there (1.x run again after the migration writes them
    /// anew): projects 1.x added meanwhile are kept.
    fn migrate(&self) {
        let mut data = self.data.lock();
        let version = data.get("version").and_then(Value::as_i64).unwrap_or(0);
        let has_v1 = V1_KEYS.iter().any(|key| data.contains_key(*key));
        if version >= STORE_VERSION && !has_v1 {
            return;
        }
        let mut projects = match data.get("projects") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        let mut folders: HashSet<String> = projects
            .iter()
            .filter_map(|(id, value)| read_project(id, value))
            .map(|p| folder_key(&p.folder))
            .collect();
        let mut imported = 0;
        for project in v1_projects(data.get("storage_data")) {
            // Already migrated (by id or by folder: two projects never share a folder)
            if projects.contains_key(&project.id) || folders.contains(&folder_key(&project.folder))
            {
                continue;
            }
            folders.insert(folder_key(&project.folder));
            projects.insert(
                project.id.clone(),
                serde_json::to_value(&project).unwrap_or(Value::Null),
            );
            imported += 1;
        }
        let user_properties = data.get("user_properties").cloned();
        for key in V1_KEYS {
            data.remove(key);
        }
        data.insert("projects".into(), Value::Object(projects));
        if version < STORE_VERSION {
            let settings = v1_settings(user_properties.as_ref(), has_v1, self.default_language);
            data.insert(
                "settings".into(),
                serde_json::to_value(settings).unwrap_or(Value::Null),
            );
            data.insert("version".into(), json!(STORE_VERSION));
        }
        self.flush(&data);
        if version < STORE_VERSION {
            info!("Store migrated to v{STORE_VERSION}: {imported} projects");
        } else {
            info!("1.x keys removed from the store: {imported} projects imported");
        }
    }
}

pub struct TokenFields {
    pub token_keyring: bool,
    pub token_plain: Option<String>,
}

/// The file as an object, or a new one when it cannot be parsed: the damaged
/// file is kept beside it as `op-media-downloader-config.corrupt-<time>.json`
fn read_store(file: &Path) -> (Map<String, Value>, Option<PathBuf>) {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(_) => return (Map::new(), None),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => (map, None),
        _ => {
            let stamp = op_media_service::now_iso().replace([':', '.'], "-");
            let aside = file.with_file_name(format!("{STORE_NAME}.corrupt-{stamp}.json"));
            error!(
                "The config file cannot be parsed: set aside as {}",
                aside.display()
            );
            if fs::rename(file, &aside).is_err() {
                // A file another program holds cannot be moved: it is copied, and the store starts over it
                warn!("The damaged config file cannot be moved: copied instead");
                if fs::copy(file, &aside).is_err() {
                    return (Map::new(), None);
                }
            }
            (Map::new(), Some(aside))
        }
    }
}

fn write_atomic(file: &Path, data: &Map<String, Value>) -> std::io::Result<()> {
    use std::io::Write;
    let mut text = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut text, formatter);
    data.serialize(&mut serializer)
        .map_err(std::io::Error::other)?;
    let temp = file.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut handle = fs::File::create(&temp)?;
        handle.write_all(&text)?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&temp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// A project read back from the file; anything that is not one is left out
pub fn read_project(id: &str, value: &Value) -> Option<StoredProject> {
    let project = value.as_object()?;
    if !is_project_id(id) || project.get("id").and_then(Value::as_str) != Some(id) {
        return None;
    }
    let text = |key: &str| {
        project
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let typed = |key: &str| project.get(key).cloned();
    Some(StoredProject {
        id: id.to_string(),
        label: project.get("label")?.as_str()?.to_string(),
        folder: project.get("folder")?.as_str()?.to_string(),
        keep_old_files: project.get("keep_old_files") == Some(&Value::Bool(true)),
        created_at: project
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or(EPOCH)
            .to_string(),
        token_enc: text("token_enc"),
        token_plain: text("token_plain"),
        token_keyring: project.get("token_keyring") == Some(&Value::Bool(true)),
        last_result: typed("last_result").and_then(|v| serde_json::from_value(v).ok()),
        plan: typed("plan").and_then(|v| serde_json::from_value(v).ok()),
        issues: match project.get("issues") {
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value::<Issue>(item.clone()).ok())
                    .collect(),
            ),
            _ => None,
        },
        folder_info: typed("folder_info").and_then(|v| serde_json::from_value(v).ok()),
        onpage_project: typed("onpage_project").and_then(|v| serde_json::from_value(v).ok()),
        take_over_folder: project.get("take_over_folder") == Some(&Value::Bool(true)),
    })
}

/// Folders compared the way the file systems of the platform compare them
fn folder_key(folder: &str) -> String {
    let trimmed = folder.trim().trim_end_matches(['/', '\\']);
    if cfg!(target_os = "linux") {
        trimmed.to_string()
    } else {
        trimmed.to_lowercase()
    }
}

/* -------------------------------------------------------------------- 1.x */

/// 1.x settings (`user_properties`: dark_mode, simultaneous_downloads, language) as 2.0 settings
fn v1_settings(value: Option<&Value>, has_v1: bool, default_language: AppLanguage) -> AppSettings {
    let empty = Map::new();
    let v1 = value.and_then(Value::as_object).unwrap_or(&empty);
    let simultaneous = concurrency(v1.get("simultaneous_downloads"));
    AppSettings {
        theme: if v1.get("dark_mode") == Some(&Value::Bool(true)) {
            ThemeSetting::Dark
        } else {
            ThemeSetting::System
        },
        // 1.x showed Italian unless told otherwise; a new install speaks the system's language
        language: language(v1.get("language")).unwrap_or(if has_v1 {
            AppLanguage::It
        } else {
            default_language
        }),
        // 1 was the 1.x default, not a choice: start from the 2.0 default
        concurrency: simultaneous
            .filter(|n| *n > 1)
            .unwrap_or(DEFAULT_SETTINGS.concurrency),
        ..DEFAULT_SETTINGS
    }
}

/// 1.x projects (`storage_data`: id, label, api_token, folder_path,
/// keep_old_files, last_sync) in their order; the tokens in clear as 1.x had
/// them, until unlock_tokens() moves them
fn v1_projects(value: Option<&Value>) -> Vec<StoredProject> {
    let Some(Value::Object(map)) = value else {
        return Vec::new();
    };
    let now = chrono::Utc::now().timestamp_millis();
    let mut projects = Vec::new();
    for v1 in map.values() {
        let Some(v1) = v1.as_object() else { continue };
        let Some(folder) = v1
            .get("folder_path")
            .and_then(Value::as_str)
            .filter(|f| !f.trim().is_empty())
        else {
            continue;
        };
        let token = v1
            .get("api_token")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let label = match v1.get("label").and_then(Value::as_str).map(str::trim) {
            Some(label) if !label.is_empty() => label.to_string(),
            _ => Path::new(folder)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        };
        let id = match v1.get("id").and_then(Value::as_str) {
            Some(id) if is_project_id(id) => id.to_string(),
            _ => uuid::Uuid::new_v4().to_string(),
        };
        projects.push(StoredProject {
            id,
            label,
            folder: folder.to_string(),
            keep_old_files: v1.get("keep_old_files") == Some(&Value::Bool(true)),
            // One millisecond apart: the list keeps the order of 1.x
            created_at: op_media_service::iso_ms(now + projects.len() as i64),
            token_enc: None,
            token_plain: (!token.is_empty()).then(|| token.to_string()),
            token_keyring: false,
            last_result: v1
                .get("last_sync")
                .and_then(Value::as_object)
                .map(from_v1_sync),
            plan: None,
            issues: None,
            folder_info: None,
            onpage_project: None,
            take_over_folder: false,
        });
    }
    projects
}

fn from_v1_sync(sync: &Map<String, Value>) -> SyncResult {
    let count = |key: &str| {
        sync.get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n.floor() as u64)
            .unwrap_or(0)
    };
    SyncResult {
        job: op_media_service::JobKind::Download,
        started_at: v1_date(sync.get("start_time")),
        ended_at: v1_date(sync.get("end_time")),
        outcome: op_media_service::SyncOutcome::Completed,
        total: count("total"),
        downloaded: count("downloaded"),
        linked: 0,
        removed: 0,
        already_present: count("already_exists"),
        failed: count("failed"),
        bytes: 0,
        error: None,
        onpage_project: None,
    }
}

/// 1.x saved local times as `YYYY-MM-DD HH:mm:ss`
fn v1_date(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .and_then(|text| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S").ok())
        .and_then(|local| local.and_local_timezone(chrono::Local).single())
        .map(|date| op_media_service::iso(date.with_timezone(&chrono::Utc)))
        .unwrap_or_else(op_media_service::now_iso)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Tokens in memory; `broken` plays a system without a credential store
    #[derive(Default)]
    pub struct MemoryVault {
        pub tokens: Mutex<HashMap<String, String>>,
        pub broken: bool,
    }

    impl TokenVault for std::sync::Arc<MemoryVault> {
        fn set(&self, id: &str, token: &str) -> Result<(), String> {
            if self.broken {
                return Err("no credential store".into());
            }
            self.tokens.lock().insert(id.into(), token.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.tokens.lock().get(id).cloned())
        }
        fn delete(&self, id: &str) {
            self.tokens.lock().remove(id);
        }
    }

    pub fn open(dir: &Path, vault: std::sync::Arc<MemoryVault>) -> AppStore {
        AppStore::open(StoreOptions {
            dir: dir.to_path_buf(),
            default_language: AppLanguage::En,
            vault: Box::new(vault),
            legacy: None,
        })
    }

    fn project(id: &str, folder: &str) -> StoredProject {
        StoredProject {
            id: id.into(),
            label: id.to_uppercase(),
            folder: folder.into(),
            keep_old_files: false,
            created_at: op_media_service::now_iso(),
            token_enc: None,
            token_plain: None,
            token_keyring: false,
            last_result: None,
            plan: None,
            issues: None,
            folder_info: None,
            onpage_project: None,
            take_over_folder: false,
        }
    }

    #[test]
    fn a_new_store_speaks_the_systems_language() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(dir.path(), Default::default());
        assert_eq!(store.settings().language, AppLanguage::En);
        assert!(store.projects().is_empty());
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(STORE_FILE)).unwrap())
                .unwrap();
        assert_eq!(saved["version"], 2);
    }

    #[test]
    fn migrates_1x_projects_and_settings() {
        let dir = tempfile::tempdir().unwrap();
        let v1 = json!({
            "storage_data": {
                "a": { "id": "11111111-1111-1111-1111-111111111111", "label": " Catalogo ", "api_token": "tok-1", "folder_path": "/media/catalogo", "keep_old_files": true,
                       "last_sync": { "start_time": "2024-05-01 10:00:00", "end_time": "2024-05-01 10:05:00", "total": 10, "downloaded": 7, "already_exists": 3, "failed": 0 } },
                "b": { "label": "", "api_token": "", "folder_path": "/media/listino" },
                "c": { "label": "no folder" }
            },
            "user_properties": { "dark_mode": true, "simultaneous_downloads": 1, "language": "de" }
        });
        fs::write(dir.path().join(STORE_FILE), v1.to_string()).unwrap();
        let vault = std::sync::Arc::new(MemoryVault::default());
        let store = open(dir.path(), vault.clone());
        let settings = store.settings();
        assert_eq!(settings.theme, ThemeSetting::Dark);
        assert_eq!(settings.language, AppLanguage::De);
        assert_eq!(settings.concurrency, 4);
        let projects = store.projects();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].label, "Catalogo");
        assert!(projects[0].keep_old_files);
        assert_eq!(projects[0].last_result.as_ref().unwrap().downloaded, 7);
        assert_eq!(projects[1].label, "listino");
        store.unlock_tokens();
        let projects = store.projects();
        assert!(projects[0].token_keyring && projects[0].token_plain.is_none());
        assert_eq!(store.token(&projects[0]), "tok-1");
        assert!(!store.has_token(&projects[1]));
        assert_eq!(
            vault
                .tokens
                .lock()
                .get("11111111-1111-1111-1111-111111111111")
                .unwrap(),
            "tok-1"
        );
        let raw = fs::read_to_string(dir.path().join(STORE_FILE)).unwrap();
        assert!(!raw.contains("storage_data") && !raw.contains("tok-1"));
    }

    #[test]
    fn tokens_stay_in_the_file_without_a_credential_store() {
        let dir = tempfile::tempdir().unwrap();
        let vault = std::sync::Arc::new(MemoryVault {
            broken: true,
            ..Default::default()
        });
        let store = open(dir.path(), vault);
        let mut p = project("p1", "/a");
        let fields = store.store_token("p1", "secret");
        p.token_keyring = fields.token_keyring;
        p.token_plain = fields.token_plain;
        store.save_project(&p).unwrap();
        assert_eq!(store.token(&store.project("p1").unwrap()), "secret");
        assert!(
            fs::read_to_string(dir.path().join(STORE_FILE))
                .unwrap()
                .contains("secret")
        );
    }

    #[test]
    fn a_damaged_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(STORE_FILE), "{ not json").unwrap();
        let store = open(dir.path(), Default::default());
        let aside = store.set_aside.clone().unwrap();
        assert_eq!(fs::read_to_string(aside).unwrap(), "{ not json");
        assert!(store.projects().is_empty());
    }

    #[test]
    fn values_read_back_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let file = json!({
            "version": 2,
            "settings": { "theme": "neon", "concurrency": 99 },
            "projects": {
                "ok": { "id": "ok", "label": "Ok", "folder": "/ok", "plan": "nonsense", "issues": [{ "code": "duplicates", "severity": "warning", "at": "x" }, { "code": 5 }] },
                "wrong-id": { "id": "other", "label": "x", "folder": "/x" },
                "__proto__": { "id": "__proto__", "label": "x", "folder": "/x" },
                "no-label": { "id": "no-label", "folder": "/x" }
            },
            "window_state": { "width": 900, "height": "tall" }
        });
        fs::write(dir.path().join(STORE_FILE), file.to_string()).unwrap();
        let store = open(dir.path(), Default::default());
        assert_eq!(store.settings().theme, ThemeSetting::System);
        assert_eq!(store.settings().concurrency, 10);
        let projects = store.projects();
        assert_eq!(projects.len(), 1);
        assert!(projects[0].plan.is_none());
        assert_eq!(projects[0].issues.as_ref().unwrap().len(), 1);
        assert_eq!(store.window_state(), None);
    }

    #[test]
    fn removing_a_project_forgets_its_token() {
        let dir = tempfile::tempdir().unwrap();
        let vault = std::sync::Arc::new(MemoryVault::default());
        let store = open(dir.path(), vault.clone());
        let mut p = project("p1", "/a");
        p.token_keyring = store.store_token("p1", "t").token_keyring;
        store.save_project(&p).unwrap();
        store.remove_project("p1");
        assert!(store.project("p1").is_none());
        assert!(vault.tokens.lock().is_empty());
    }
}
