//! # op-media-projects
//!
//! The projects of On Page Media Downloader as everything that drives them
//! shares them: the app (`src-tauri`), the `opmd` command and the MCP server.
//! The settings file and its projects (`store`), their tokens (the system's
//! credential store, else the file), every operation on a project
//! (`projects`, over `op-media-service`), the checks of what comes from
//! outside (`validate`), where the data lives (`paths`) and the log.
//!
//! Nothing here knows about windows: whoever opens the projects says how to
//! hear of their changes (`OpenOptions::notify`).

pub mod log;
pub mod models;
pub mod os_crypt;
pub mod paths;
pub mod projects;
pub mod status;
pub mod store;
pub mod validate;

use std::sync::Arc;

use op_media_service::{MediaService, ServiceConfig, ServiceEvent, Timings};

use crate::models::AppLanguage;
use crate::os_crypt::SafeStorage;
use crate::paths::{AppPaths, ELECTRON_NAMES};
use crate::projects::{ProjectService, ProjectsEvent};
use crate::store::{AppStore, KeyringVault, StoreOptions};

pub struct OpenOptions {
    pub paths: AppPaths,
    /// The language of a new settings file
    pub default_language: AppLanguage,
    /// The credential store's service for the tokens (`paths::KEYRING_SERVICE`)
    pub keyring_service: String,
    /// Another On Page server (development: the fake one)
    pub api_domain: Option<String>,
    /// Where the projects run their background work
    pub runtime: tokio::runtime::Handle,
    /// How the opener hears of what happens (changes, activity, results)
    pub notify: Box<dyn Fn(ProjectsEvent) + Send + Sync>,
}

pub struct Opened {
    pub store: Arc<AppStore>,
    pub projects: Arc<ProjectService>,
}

/// The settings file, the tokens, the sync service and the projects over them,
/// wired together: what the app does at start-up, and `opmd` before a command
pub fn open(options: OpenOptions) -> Result<Opened, String> {
    let paths = options.paths;
    let legacy = paths.legacy.as_ref().map(|dir| SafeStorage::new(dir, &ELECTRON_NAMES));
    let store = Arc::new(AppStore::open(StoreOptions {
        dir: paths.data.clone(),
        default_language: options.default_language,
        vault: Box::new(KeyringVault::new(&options.keyring_service)),
        legacy,
    }));
    // Before anything reads a token
    store.unlock_tokens();

    let (events, mut received) = tokio::sync::mpsc::unbounded_channel::<ServiceEvent>();
    let settings = store.settings();
    let service = MediaService::new(
        ServiceConfig {
            cache_dir: paths.cache.clone(),
            concurrency: settings.concurrency,
            instance_id: uuid::Uuid::new_v4().to_string(),
            api_domain: options.api_domain,
            project_folders: store
                .projects()
                .into_iter()
                .map(|p| op_media_service::ProjectFolder { id: p.id, folder: p.folder })
                .collect(),
            timings: Timings::default(),
        },
        Arc::new(move |event| {
            let _ = events.send(event);
        }),
    )
    .map_err(|error| format!("The sync service cannot start: {error}"))?;

    let projects = ProjectService::new(store.clone(), service, options.runtime.clone(), options.notify);
    let pump = projects.clone();
    options.runtime.spawn(async move {
        while let Some(event) = received.recv().await {
            pump.on_service_event(event);
        }
    });
    Ok(Opened { store, projects })
}
