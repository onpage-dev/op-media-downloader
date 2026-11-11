//! Who runs `opmd`'s operations. Here, `opmd` itself: it opens the projects
//! of its data folder (the settings file, the tokens, the sync service) as
//! the app does, and its jobs run in this process. The app may be open on
//! the same data: the settings file and the folders' locks keep them apart.

use std::sync::Arc;

use op_media_projects::paths::{AppPaths, KEYRING_SERVICE};
use op_media_projects::projects::ProjectService;
use op_media_projects::{OpenOptions, Opened, ops};
use serde_json::Value;

pub struct Backend {
    projects: Arc<ProjectService>,
}

impl Backend {
    pub fn open(paths: AppPaths) -> Result<Backend, String> {
        let preferred: Vec<String> = sys_locale::get_locales().collect();
        let Opened { projects, .. } = op_media_projects::open(OpenOptions {
            paths,
            default_language: op_media_projects::models::system_language(&preferred),
            // OPMD_NO_KEYRING: the tokens in the settings file (a container, a NAS without a credential store)
            keyring_service: std::env::var_os("OPMD_NO_KEYRING").is_none().then(|| KEYRING_SERVICE.to_string()),
            // Development builds only, as the app: a fake On Page server
            api_domain: if cfg!(debug_assertions) {
                std::env::var("OPMD_API_DOMAIN").ok().filter(|d| !d.is_empty())
            } else {
                None
            },
            runtime: tokio::runtime::Handle::current(),
            notify: Box::new(|_| {}),
        })?;
        Ok(Backend { projects })
    }

    pub async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        ops::call(&self.projects, name, &args).await
    }

    /// The jobs run in this process: it must not end before them
    pub fn runs_jobs_here(&self) -> bool {
        true
    }

    /// `opmd token`: only here, never through an MCP server
    pub fn reveal_token(&self, reference: &str) -> Result<String, String> {
        let id = self.projects.find(reference)?.id;
        self.projects.reveal_token(&id)
    }
}
