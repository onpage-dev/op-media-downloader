//! What the app adds to the service's model: settings, the projects as the
//! page sees them, the app's status and version, the commands of the menus.
//! Serialized as `src/shared/models.ts` and `src/shared/desktop-api.ts`.

use op_media_service::{FolderInfo, IsoDate, OnPageProject, ProjectId, ProjectRuntime};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeSetting {
    System,
    Light,
    Dark,
}

/// The languages of On Page UI
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppLanguage {
    It,
    En,
    De,
    Es,
    Fr,
    Ru,
    Sv,
    Zh,
}

impl AppLanguage {
    pub const ALL: [AppLanguage; 8] = [
        AppLanguage::It,
        AppLanguage::En,
        AppLanguage::De,
        AppLanguage::Es,
        AppLanguage::Fr,
        AppLanguage::Ru,
        AppLanguage::Sv,
        AppLanguage::Zh,
    ];

    pub fn code(self) -> &'static str {
        match self {
            AppLanguage::It => "it",
            AppLanguage::En => "en",
            AppLanguage::De => "de",
            AppLanguage::Es => "es",
            AppLanguage::Fr => "fr",
            AppLanguage::Ru => "ru",
            AppLanguage::Sv => "sv",
            AppLanguage::Zh => "zh",
        }
    }

    pub fn from_code(code: &str) -> Option<AppLanguage> {
        AppLanguage::ALL.into_iter().find(|language| language.code() == code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSettings {
    pub theme: ThemeSetting,
    pub language: AppLanguage,
    /// Parallel downloads per project, 1..10
    pub concurrency: u32,
    /// Retry network failures once, a minute after the end of a download
    pub auto_retry_failed: bool,
    pub notifications: bool,
    /// Icon in the notification area; closing the window keeps the app running there
    pub close_to_tray: bool,
    /// Start with the system, in the notification area
    pub open_at_login: bool,
    /// Look for a new version on GitHub at start-up
    pub check_updates: bool,
}

pub const DEFAULT_SETTINGS: AppSettings = AppSettings {
    theme: ThemeSetting::System,
    language: AppLanguage::It,
    concurrency: 4,
    auto_retry_failed: false,
    notifications: true,
    close_to_tray: false,
    open_at_login: false,
    check_updates: true,
};

/// A project as the page sees it: configuration and live state, never the token
#[derive(Debug, Clone, Serialize)]
pub struct ProjectView {
    pub id: ProjectId,
    pub label: String,
    pub folder: String,
    pub keep_old_files: bool,
    pub created_at: IsoDate,
    pub has_token: bool,
    pub runtime: ProjectRuntime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_info: Option<FolderInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onpage_project: Option<OnPageProject>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct VersionInfo {
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<IsoDate>,
    /// The last check could not reach GitHub
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_failed: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppStatus {
    pub online: bool,
    pub running_jobs: u64,
    pub speed_bps: f64,
    pub total_files: u64,
    pub total_bytes: u64,
}

/* ------------------------------------------------------------------ inputs */

#[derive(Debug, Clone)]
pub struct NewProjectInput {
    pub label: String,
    pub token: String,
    pub folder: String,
    pub keep_old_files: bool,
    /// Start «Sincronizza» right after saving
    pub sync_now: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectPatch {
    pub label: Option<String>,
    /// Replaces the stored token when present
    pub token: Option<String>,
    pub folder: Option<String>,
    pub keep_old_files: Option<bool>,
}

/// The settings a patch may change
#[derive(Debug, Clone, Default)]
pub struct SettingsPatch {
    pub theme: Option<ThemeSetting>,
    pub language: Option<AppLanguage>,
    pub concurrency: Option<u32>,
    pub auto_retry_failed: Option<bool>,
    pub notifications: Option<bool>,
    pub close_to_tray: Option<bool>,
    pub open_at_login: Option<bool>,
    pub check_updates: Option<bool>,
}

/* ------------------------------------------------------------------ commands */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InspectorTab {
    General,
    Activity,
    Failed,
    Duplicates,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsSection {
    General,
    Download,
    Appearance,
    Language,
    Updates,
}

/// Commands that reach the page from the menu, the shortcuts, the tray or a second launch
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppCommand {
    NewProject {
        #[serde(skip_serializing_if = "Option::is_none")]
        folder: Option<String>,
    },
    SelectProject {
        project_id: ProjectId,
        #[serde(skip_serializing_if = "Option::is_none")]
        tab: Option<InspectorTab>,
    },
    SyncSelected,
    SyncAll,
    DownloadSelected,
    StopSelected,
    OpenFolderSelected,
    EditSelected,
    DeleteSelected,
    OpenSettings {
        #[serde(skip_serializing_if = "Option::is_none")]
        section: Option<SettingsSection>,
    },
    FocusSearch,
}

/// The first of the system's preferred languages that the app speaks, else English
pub fn system_language(preferred: &[String]) -> AppLanguage {
    for tag in preferred {
        let base = tag.to_lowercase();
        let base = base.split(['-', '_']).next().unwrap_or("");
        if let Some(language) = AppLanguage::from_code(base) {
            return language;
        }
    }
    AppLanguage::En
}
