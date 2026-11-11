//! The app wired together: the store, the service and the projects, the
//! windows, the tray, the status, the life of the app (one instance, the
//! window closing to the tray, quitting confirmed while jobs run or the files
//! of a removed project are being deleted, the Dock on macOS) and the
//! settings applied to all of it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use op_media_service::{MediaService, ServiceConfig, ServiceEvent, SyncOutcome, Timings};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::app_status::StatusController;
use crate::i18n::{system_language, texts};
use crate::menu::{command_from_argv, setup_menu};
use crate::models::{AppCommand, AppSettings};
use crate::notifications::{notify_delete_failed, notify_result};
use crate::os_crypt::SafeStorage;
use crate::paths::{AppPaths, ELECTRON_NAMES, KEYRING_SERVICE};
use crate::projects::{ProjectService, ProjectsEvent};
use crate::store::{AppStore, KeyringVault, StoreOptions};
use crate::tray::TrayController;
use crate::updates::Updates;
use crate::window::{MainWindow, apply_theme};
use crate::{error, info};

pub struct Shell {
    pub store: Arc<AppStore>,
    pub projects: Arc<ProjectService>,
    pub updates: Updates,
    pub status: StatusController,
    pub tray: TrayController,
    pub main_window: MainWindow,
    pub lifecycle: Lifecycle,
}

#[derive(Serialize, Clone)]
struct ActivityPayload<'a> {
    project_id: &'a str,
    entries: &'a [op_media_service::ActivityEntry],
}

/// Everything the app needs, before the first window: an error here is shown and the app quits
pub fn setup(app: &AppHandle) -> Result<(), String> {
    let paths = AppPaths::resolve(app);
    crate::log::init(&paths.logs);
    paths.import_legacy();

    let preferred: Vec<String> = sys_locale::get_locales().collect();
    let legacy = paths.legacy.as_ref().map(|dir| SafeStorage::new(dir, &ELECTRON_NAMES));
    let store = Arc::new(AppStore::open(StoreOptions {
        dir: paths.data.clone(),
        default_language: system_language(&preferred),
        vault: Box::new(KeyringVault::new(KEYRING_SERVICE)),
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
            // Development only: point the service at a fake On Page server
            api_domain: if cfg!(debug_assertions) {
                std::env::var("OPMD_API_DOMAIN").ok().filter(|d| !d.is_empty())
            } else {
                None
            },
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

    let handle = app.clone();
    let projects = ProjectService::new(store.clone(), service, move |event| on_projects_event(&handle, event));
    app.manage(Shell {
        store: store.clone(),
        projects: projects.clone(),
        updates: Updates::new(&app.package_info().version.to_string()),
        status: StatusController::new(),
        tray: TrayController::default(),
        main_window: MainWindow::default(),
        lifecycle: Lifecycle::default(),
    });
    let pump = projects.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = received.recv().await {
            pump.on_service_event(event);
        }
    });

    let shell = app.state::<Shell>();
    setup_menu(app);
    if settings.close_to_tray {
        shell.tray.enable(app);
    }
    apply_login_item(app, &settings);
    shell.status.start(app);
    shell.status.update_tray(app, &projects.views());
    let refresh = projects.clone();
    tauri::async_runtime::spawn(async move { refresh.refresh_folders().await });

    let argv: Vec<String> = std::env::args().collect();
    let start_hidden = argv.iter().any(|arg| arg == "--hidden") && settings.close_to_tray;
    if !start_hidden {
        shell.main_window.show(app);
    }
    if let Some(command) = command_from_argv(&argv) {
        shell.main_window.send_command(app, command);
    }
    if let Some(file) = &store.set_aside {
        let t = texts(settings.language);
        app.dialog()
            .message(t.config_damaged_detail(&file.display().to_string()))
            .title(t.config_damaged_title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCustom(t.ok.to_string()))
            .show(|_| {});
    }
    if settings.check_updates {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let version = handle.state::<Shell>().updates.check().await;
            let _ = handle.emit("app:version", version);
        });
    }
    info!("Started {} ({}, Tauri {})", app.package_info().version, std::env::consts::OS, tauri::VERSION);
    Ok(())
}

/// Says why the app cannot start and quits
pub fn start_failed(app: &AppHandle, message: String) {
    error!("Start-up failed: {message}");
    crate::log::flush();
    let language = system_language(&sys_locale::get_locales().collect::<Vec<_>>());
    let t = texts(language);
    let detail = match crate::log::log_file() {
        Some(file) => format!("{message}\n\n{}", t.start_failed_log(&file.display().to_string())),
        None => message,
    };
    let handle = app.clone();
    app.dialog()
        .message(detail)
        .title(t.start_failed_title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom(t.ok.to_string()))
        .show(move |_| handle.exit(1));
}

fn on_projects_event(app: &AppHandle, event: ProjectsEvent) {
    let Some(shell) = app.try_state::<Shell>() else {
        return;
    };
    match event {
        ProjectsEvent::Changed(views) => shell.status.on_projects(app, &views),
        ProjectsEvent::Activity(project_id, entries) => {
            let _ = app.emit("sync:activity", ActivityPayload { project_id: &project_id, entries: &entries });
        }
        ProjectsEvent::Result(view, result) => {
            shell.status.job_ended(result.outcome == SyncOutcome::Failed, MainWindow::focused(app));
            notify_result(app, &view, &result);
        }
        ProjectsEvent::DeleteFailed { label, code } => notify_delete_failed(app, &label, &code),
    }
}

/// A second launch: its command, or the window
pub fn on_second_instance(app: &AppHandle, argv: Vec<String>) {
    let Some(shell) = app.try_state::<Shell>() else {
        return;
    };
    match command_from_argv(&argv) {
        Some(command) => shell.main_window.send_command(app, command),
        None => shell.main_window.show(app),
    }
}

/// Settings saved from the page, applied to the rest of the app
pub fn apply_settings(app: &AppHandle, next: &AppSettings, previous: &AppSettings) {
    let shell = app.state::<Shell>();
    if next.theme != previous.theme {
        apply_theme(app, next.theme);
    }
    if next.language != previous.language {
        setup_menu(app);
        shell.tray.refresh_menu(app);
    }
    if next.concurrency != previous.concurrency {
        shell.projects.configure_service(Some(next.concurrency));
    }
    if next.close_to_tray {
        shell.tray.enable(app);
    } else {
        shell.tray.disable(app);
    }
    if next.open_at_login != previous.open_at_login {
        apply_login_item(app, next);
    }
    shell.status.update_tray(app, &shell.projects.views());
    let _ = app.emit("settings:changed", next);
}

/// Start with the system, in the notification area. In development this would register the bare debug binary
fn apply_login_item(app: &AppHandle, settings: &AppSettings) {
    if cfg!(debug_assertions) {
        return;
    }
    let autolaunch = app.autolaunch();
    let enabled = autolaunch.is_enabled().unwrap_or(false);
    let result = match (settings.open_at_login, enabled) {
        (true, false) => autolaunch.enable(),
        (false, true) => autolaunch.disable(),
        _ => Ok(()),
    };
    if let Err(error) = result {
        crate::warn!("Open at login not changed: {error}");
    }
}

/* ------------------------------------------------------------------ life */

#[derive(Default)]
pub struct Lifecycle {
    quitting: AtomicBool,
    /// The confirmation is on screen: closing again does not open another one
    confirming: AtomicBool,
}

impl Lifecycle {
    /// The user closes the main window; true keeps it open (or hidden)
    pub fn on_window_close(&self, app: &AppHandle) -> bool {
        if self.quitting.load(Ordering::Acquire) {
            return false;
        }
        let shell = app.state::<Shell>();
        if shell.store.settings().close_to_tray && shell.tray.enabled() {
            if let Some(window) = MainWindow::current(app) {
                let _ = window.hide();
            }
            return true;
        }
        // On macOS the app stays in the Dock and the service keeps working
        if cfg!(target_os = "macos") {
            return false;
        }
        if busy(app) {
            self.confirm_quit(app);
            return true;
        }
        false
    }

    /// The app is asked to end (`code` None: its last window closed); true keeps it running
    pub fn on_exit_requested(&self, app: &AppHandle, code: Option<i32>) -> bool {
        if self.quitting.load(Ordering::Acquire) {
            return false;
        }
        let shell = app.state::<Shell>();
        if code.is_none()
            && (cfg!(target_os = "macos") || (shell.store.settings().close_to_tray && shell.tray.enabled()))
        {
            return true;
        }
        if busy(app) {
            self.confirm_quit(app);
            return true;
        }
        self.quitting.store(true, Ordering::Release);
        false
    }

    pub fn on_exit(&self, app: &AppHandle) {
        if let Some(shell) = app.try_state::<Shell>() {
            shell.tray.disable(app);
        }
        crate::log::flush();
    }

    fn confirm_quit(&self, app: &AppHandle) {
        if self.confirming.swap(true, Ordering::AcqRel) {
            return;
        }
        let shell = app.state::<Shell>();
        let t = texts(shell.store.settings().language);
        // Deleting files only: quitting stops the deletion, not downloads
        let deleting = !shell.projects.is_running();
        let (title, message) =
            if deleting { (t.deleting_title, t.deleting_message) } else { (t.quit_title, t.quit_message) };
        let handle = app.clone();
        let mut dialog = app
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(t.quit_confirm.to_string(), t.cancel.to_string()));
        if let Some(window) = MainWindow::current(app) {
            dialog = dialog.parent(&window);
        }
        dialog.show(move |confirmed| {
            let shell = handle.state::<Shell>();
            shell.lifecycle.confirming.store(false, Ordering::Release);
            if !confirmed {
                return;
            }
            shell.lifecycle.quitting.store(true, Ordering::Release);
            let projects = shell.projects.clone();
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                projects.stop_all(Duration::from_secs(15)).await;
                app.exit(0);
            });
        });
    }
}

fn busy(app: &AppHandle) -> bool {
    let projects = &app.state::<Shell>().projects;
    projects.is_running() || projects.is_deleting()
}

/// Commands of the menus and the tray reach the page through the main window
pub fn send_command(app: &AppHandle, command: AppCommand) {
    app.state::<Shell>().main_window.send_command(app, command);
}
