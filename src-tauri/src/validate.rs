//! Checks of what reaches the app from the page (command arguments) and from
//! the store (values read back). Anything malformed is `invalid_input`, or is
//! dropped where a default makes sense.

use std::path::Path;

use op_media_service::{PageQuery, ProjectId};
use regex::Regex;
use serde_json::{Map, Value};

use crate::models::*;

/// Project ids are UUIDs (1.x and 2.0): never a path of the store
static PROJECT_ID: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());
const RESERVED_IDS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// Longest strings accepted from the page
pub mod limits {
    pub const LABEL: usize = 500;
    pub const TOKEN: usize = 2_000;
    pub const PATH: usize = 4_096;
    pub const QUERY: usize = 200;
    /// Text copied to the clipboard
    pub const TEXT: usize = 10_000;
    pub const URL: usize = 2_048;
    /// A line of the page in the log
    pub const LOG: usize = 2_000;
}

pub const INVALID_INPUT: &str = "invalid_input";

pub type Checked<T> = Result<T, String>;

fn invalid<T>() -> Checked<T> {
    Err(INVALID_INPUT.to_string())
}

pub fn is_project_id(value: &str) -> bool {
    PROJECT_ID.is_match(value) && !RESERVED_IDS.contains(&value)
}

pub fn project_id(value: &Value) -> Checked<ProjectId> {
    match value.as_str() {
        Some(id) if is_project_id(id) => Ok(id.to_string()),
        _ => invalid(),
    }
}

pub fn optional_project_id(value: Option<&Value>) -> Checked<Option<ProjectId>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => project_id(value).map(Some),
    }
}

/// A string of at most `max` characters
pub fn text(value: &Value, max: usize) -> Checked<String> {
    match value.as_str() {
        Some(text) if text.chars().count() <= max => Ok(text.to_string()),
        _ => invalid(),
    }
}

fn optional_text(value: Option<&Value>, max: usize) -> Checked<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => text(value, max).map(Some),
    }
}

/// An absolute path: a relative one would be resolved against the working directory of the app
pub fn folder_path(value: &Value) -> Checked<String> {
    let folder = text(value, limits::PATH)?;
    if folder.contains('\0') || !Path::new(folder.trim()).is_absolute() {
        return invalid();
    }
    Ok(folder)
}

/// A folder to start a picker from: anything but an absolute path is ignored
pub fn optional_folder(value: Option<&Value>) -> Option<String> {
    value.filter(|v| !v.is_null()).and_then(|v| folder_path(v).ok())
}

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn whole(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n.floor() as i64)
}

/// A page of a long list: at most 200 entries, a query of at most 200 characters
pub fn page_query(value: &Value) -> PageQuery {
    let empty = Map::new();
    let page = record(value).unwrap_or(&empty);
    PageQuery {
        offset: whole(page.get("offset")).unwrap_or(0).clamp(0, 1_000_000_000) as usize,
        limit: whole(page.get("limit")).unwrap_or(50).clamp(1, 200) as usize,
        query: page.get("query").and_then(Value::as_str).map(|q| q.chars().take(limits::QUERY).collect()),
    }
}

/// How many activity entries to read: the service keeps the last 1,000
pub fn activity_limit(value: Option<&Value>) -> Option<usize> {
    whole(value).map(|n| n.clamp(1, 1_000) as usize)
}

pub fn new_project_input(value: &Value) -> Checked<NewProjectInput> {
    let Some(input) = record(value) else {
        return invalid();
    };
    let field = |name: &str| input.get(name).unwrap_or(&Value::Null);
    Ok(NewProjectInput {
        label: text(field("label"), limits::LABEL)?,
        token: text(field("token"), limits::TOKEN)?,
        folder: folder_path(field("folder"))?,
        keep_old_files: field("keep_old_files") == &Value::Bool(true),
        sync_now: field("sync_now") == &Value::Bool(true),
    })
}

pub fn project_patch(value: &Value) -> Checked<ProjectPatch> {
    let Some(patch) = record(value) else {
        return invalid();
    };
    Ok(ProjectPatch {
        label: optional_text(patch.get("label"), limits::LABEL)?,
        token: optional_text(patch.get("token"), limits::TOKEN)?,
        folder: match patch.get("folder") {
            None | Some(Value::Null) => None,
            Some(folder) => Some(folder_path(folder)?),
        },
        keep_old_files: patch.get("keep_old_files").and_then(Value::as_bool),
    })
}

/* -------------------------------------------------------------------- settings */

pub fn theme(value: Option<&Value>) -> Option<ThemeSetting> {
    match value?.as_str()? {
        "system" => Some(ThemeSetting::System),
        "light" => Some(ThemeSetting::Light),
        "dark" => Some(ThemeSetting::Dark),
        _ => None,
    }
}

pub fn language(value: Option<&Value>) -> Option<AppLanguage> {
    AppLanguage::from_code(value?.as_str()?)
}

/// Parallel downloads per project: a number rounded into 1..10
pub fn concurrency(value: Option<&Value>) -> Option<u32> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite()).map(|n| n.round().clamp(1.0, 10.0) as u32)
}

fn flag(value: &Map<String, Value>, name: &str) -> Option<bool> {
    value.get(name).and_then(Value::as_bool)
}

/// The settings a patch may change, with valid values only
pub fn settings_patch(value: &Value) -> Checked<SettingsPatch> {
    let Some(patch) = record(value) else {
        return invalid();
    };
    Ok(SettingsPatch {
        theme: theme(patch.get("theme")),
        language: language(patch.get("language")),
        concurrency: concurrency(patch.get("concurrency")),
        auto_retry_failed: flag(patch, "auto_retry_failed"),
        notifications: flag(patch, "notifications"),
        close_to_tray: flag(patch, "close_to_tray"),
        open_at_login: flag(patch, "open_at_login"),
        check_updates: flag(patch, "check_updates"),
    })
}

/// Settings read back: each value that is missing or not valid is the fallback's
pub fn clean_settings(value: Option<&Value>, fallback: &AppSettings) -> AppSettings {
    let empty = Map::new();
    let settings = value.and_then(record).unwrap_or(&empty);
    AppSettings {
        theme: theme(settings.get("theme")).unwrap_or(fallback.theme),
        language: language(settings.get("language")).unwrap_or(fallback.language),
        concurrency: concurrency(settings.get("concurrency")).unwrap_or(fallback.concurrency),
        auto_retry_failed: flag(settings, "auto_retry_failed").unwrap_or(fallback.auto_retry_failed),
        notifications: flag(settings, "notifications").unwrap_or(fallback.notifications),
        close_to_tray: flag(settings, "close_to_tray").unwrap_or(fallback.close_to_tray),
        open_at_login: flag(settings, "open_at_login").unwrap_or(fallback.open_at_login),
        check_updates: flag(settings, "check_updates").unwrap_or(fallback.check_updates),
    }
}

/// A patch applied on settings
pub fn apply_settings(current: &AppSettings, patch: &SettingsPatch) -> AppSettings {
    AppSettings {
        theme: patch.theme.unwrap_or(current.theme),
        language: patch.language.unwrap_or(current.language),
        concurrency: patch.concurrency.unwrap_or(current.concurrency).clamp(1, 10),
        auto_retry_failed: patch.auto_retry_failed.unwrap_or(current.auto_retry_failed),
        notifications: patch.notifications.unwrap_or(current.notifications),
        close_to_tray: patch.close_to_tray.unwrap_or(current.close_to_tray),
        open_at_login: patch.open_at_login.unwrap_or(current.open_at_login),
        check_updates: patch.check_updates.unwrap_or(current.check_updates),
    }
}

/* -------------------------------------------------------------------- commands */

fn tab(value: Option<&Value>) -> Option<InspectorTab> {
    serde_json::from_value(value?.clone()).ok()
}

fn section(value: Option<&Value>) -> Option<SettingsSection> {
    serde_json::from_value(value?.clone()).ok()
}

/// Only well-formed commands reach the main window
pub fn app_command(value: Option<&Value>) -> Option<AppCommand> {
    let command = value.and_then(record)?;
    Some(match command.get("type")?.as_str()? {
        "new_project" => AppCommand::NewProject { folder: optional_folder(command.get("folder")) },
        "select_project" => {
            let id = command.get("project_id")?.as_str()?;
            if !is_project_id(id) {
                return None;
            }
            AppCommand::SelectProject { project_id: id.to_string(), tab: tab(command.get("tab")) }
        }
        "open_settings" => AppCommand::OpenSettings { section: section(command.get("section")) },
        "sync_selected" => AppCommand::SyncSelected,
        "sync_all" => AppCommand::SyncAll,
        "download_selected" => AppCommand::DownloadSelected,
        "stop_selected" => AppCommand::StopSelected,
        "open_folder_selected" => AppCommand::OpenFolderSelected,
        "edit_selected" => AppCommand::EditSelected,
        "delete_selected" => AppCommand::DeleteSelected,
        "focus_search" => AppCommand::FocusSearch,
        _ => return None,
    })
}

/* -------------------------------------------------------------------- links */

/// github.com (releases), On Page (app.onpage.it and the other subdomains of onpage.it)
fn allowed_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".onpage.it")
}

/// The address to open in the browser, normalized: https only, to On Page or
/// GitHub, without credentials or another port; else None
pub fn external_url(value: &Value) -> Option<String> {
    let text = value.as_str().filter(|text| text.chars().count() <= limits::URL)?;
    let url = url::Url::parse(text).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    allowed_host(url.host_str()?).then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_ids() {
        assert!(project_id(&json!("8d3b2a1c-0f4e-4a5b-9c6d-7e8f9a0b1c2d")).is_ok());
        assert!(project_id(&json!("__proto__")).is_err());
        assert!(project_id(&json!("../store")).is_err());
        assert!(project_id(&json!(12)).is_err());
        assert!(project_id(&json!("a".repeat(65))).is_err());
    }

    #[test]
    fn folders_must_be_absolute() {
        #[cfg(windows)]
        assert!(folder_path(&json!("C:\\Media")).is_ok());
        #[cfg(not(windows))]
        assert!(folder_path(&json!("/media")).is_ok());
        assert!(folder_path(&json!("media")).is_err());
        assert!(folder_path(&json!("/a\0b")).is_err());
        assert_eq!(optional_folder(Some(&json!("relative"))), None);
    }

    #[test]
    fn pages_are_bounded() {
        let page = page_query(&json!({ "offset": -5, "limit": 5000, "query": "x".repeat(300) }));
        assert_eq!(page.offset, 0);
        assert_eq!(page.limit, 200);
        assert_eq!(page.query.unwrap().len(), 200);
        assert_eq!(page_query(&json!(null)).limit, 50);
        assert_eq!(activity_limit(Some(&json!(5000.7))), Some(1000));
    }

    #[test]
    fn settings_keep_valid_values_only() {
        let patch =
            settings_patch(&json!({ "theme": "neon", "language": "de", "concurrency": 42, "notifications": "yes" }))
                .unwrap();
        assert_eq!(patch.theme, None);
        assert_eq!(patch.language, Some(AppLanguage::De));
        assert_eq!(patch.concurrency, Some(10));
        assert_eq!(patch.notifications, None);
        let clean = clean_settings(
            Some(&json!({ "theme": "dark", "close_to_tray": true, "concurrency": "x" })),
            &DEFAULT_SETTINGS,
        );
        assert_eq!(clean.theme, ThemeSetting::Dark);
        assert!(clean.close_to_tray);
        assert_eq!(clean.concurrency, 4);
    }

    #[test]
    fn commands_are_checked() {
        assert_eq!(app_command(Some(&json!({ "type": "sync_all" }))), Some(AppCommand::SyncAll));
        assert_eq!(
            app_command(Some(&json!({ "type": "select_project", "project_id": "abc", "tab": "failed" }))),
            Some(AppCommand::SelectProject { project_id: "abc".into(), tab: Some(InspectorTab::Failed) })
        );
        assert_eq!(app_command(Some(&json!({ "type": "select_project", "project_id": "../x" }))), None);
        assert_eq!(app_command(Some(&json!({ "type": "format_disk" }))), None);
        assert_eq!(
            app_command(Some(&json!({ "type": "open_settings", "section": "nowhere" }))),
            Some(AppCommand::OpenSettings { section: None })
        );
    }

    #[test]
    fn external_links() {
        assert_eq!(
            external_url(&json!("https://app.onpage.it/#/things")).as_deref(),
            Some("https://app.onpage.it/#/things")
        );
        assert!(external_url(&json!("https://github.com/onpage-dev/op-media-downloader/releases")).is_some());
        assert!(external_url(&json!("http://app.onpage.it")).is_none());
        assert!(external_url(&json!("https://evil.com/onpage.it")).is_none());
        assert!(external_url(&json!("https://user:pw@app.onpage.it")).is_none());
        assert!(external_url(&json!("https://app.onpage.it:8443")).is_none());
        assert!(external_url(&json!("https://onpage.it.evil.com")).is_none());
        assert!(external_url(&json!("file:///etc/passwd")).is_none());
    }
}
