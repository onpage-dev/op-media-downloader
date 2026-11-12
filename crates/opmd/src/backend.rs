//! Who runs `opmd`'s operations:
//!
//! - the app, when it is open on the same data folder: `opmd` speaks to its
//!   MCP server (`<data>/mcp.json`), and what it starts shows in its window
//!   and goes on there;
//! - else `opmd` itself: it opens the projects as the app does (settings
//!   file, tokens, sync service) and its jobs run in this process. The app
//!   may open meanwhile: the settings file and the folders' locks keep them
//!   apart.

use std::sync::Arc;
use std::time::{Duration, Instant};

use op_media_projects::mcp::{self, Executor};
use op_media_projects::paths::{AppPaths, KEYRING_SERVICE};
use op_media_projects::projects::ProjectService;
use op_media_projects::{OpenOptions, Opened};
use serde_json::Value;
use tokio::sync::Mutex;

pub struct Backend {
    paths: AppPaths,
    /// The app's server, when it answered
    app: Mutex<Option<Executor>>,
    /// When the app was last looked for
    looked: Mutex<Option<Instant>>,
    /// The projects opened here, once needed
    local: Mutex<Option<Arc<ProjectService>>>,
    /// `opmd mcp` looks for the app again now and then; a command decides once
    keep_looking: bool,
}

/// How often `opmd mcp` looks for the app again while it is not there
const LOOK_AGAIN: Duration = Duration::from_secs(5);

impl Backend {
    /// The app when it is open on this data folder, else this process
    pub async fn open(paths: AppPaths, keep_looking: bool) -> Result<Backend, String> {
        let backend =
            Backend { paths, app: Mutex::new(None), looked: Mutex::new(None), local: Mutex::new(None), keep_looking };
        backend.find_app().await;
        Ok(backend)
    }

    /// The app's server, looked for (again, for `opmd mcp`) when it is not known
    async fn find_app(&self) -> Option<Executor> {
        if let Some(app) = self.app.lock().await.clone() {
            return Some(app);
        }
        {
            let mut looked = self.looked.lock().await;
            if looked.is_some_and(|at| !self.keep_looking || at.elapsed() < LOOK_AGAIN) {
                return None;
            }
            *looked = Some(Instant::now());
        }
        let app = mcp::connect(&self.paths.data).await?;
        *self.app.lock().await = Some(app.clone());
        Some(app)
    }

    async fn local(&self) -> Result<Arc<ProjectService>, String> {
        let mut local = self.local.lock().await;
        if let Some(projects) = local.as_ref() {
            return Ok(projects.clone());
        }
        let preferred: Vec<String> = sys_locale::get_locales().collect();
        let Opened { projects, .. } = op_media_projects::open(OpenOptions {
            paths: self.paths.clone(),
            default_language: op_media_projects::models::system_language(&preferred),
            // OPMD_NO_KEYRING: the tokens in the settings file (a container, a NAS without a credential store)
            keyring_service: keyring_service(),
            api_domain: api_domain(),
            runtime: tokio::runtime::Handle::current(),
            notify: Box::new(|_| {}),
        })?;
        *local = Some(projects.clone());
        Ok(projects)
    }

    /// Runs an operation in the app when it is open, else here. An app that
    /// closed meanwhile: here from then on
    pub async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        if let Some(app) = self.find_app().await {
            match app(name.to_string(), args.clone()).await {
                Err(error) if error.starts_with("app_unreachable") => {
                    *self.app.lock().await = None;
                }
                answer => return answer,
            }
        }
        let projects = self.local().await?;
        op_media_projects::ops::call(&projects, name, &args).await
    }

    /// The operations as `opmd mcp` runs them: in the app when it is open, else here
    pub fn executor(self: &Arc<Self>) -> Executor {
        let me = self.clone();
        Arc::new(move |name, args| {
            let me = me.clone();
            Box::pin(async move { me.call(&name, args).await })
        })
    }

    /// The jobs run in this process (the app is not open): it must not end before them
    pub async fn runs_jobs_here(&self) -> bool {
        self.app.lock().await.is_none()
    }

    /// Whether the app answers, for `opmd info`
    pub async fn app_open(&self) -> bool {
        self.find_app().await.is_some()
    }

    /// `opmd token`: read from the settings file and the credential store,
    /// never through an MCP server (an agent never gets a token)
    pub fn reveal_token(&self, reference: &str) -> Result<String, String> {
        op_media_projects::read_token(&self.paths, keyring_service(), reference)
    }
}

/// Development builds only, as the app: a fake On Page server
pub fn api_domain() -> Option<String> {
    if cfg!(debug_assertions) { std::env::var("OPMD_API_DOMAIN").ok().filter(|d| !d.is_empty()) } else { None }
}

fn keyring_service() -> Option<String> {
    std::env::var_os("OPMD_NO_KEYRING").is_none().then(|| KEYRING_SERVICE.to_string())
}
