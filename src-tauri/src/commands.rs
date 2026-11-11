//! The commands behind `window.desktop`, one per call of
//! `src/shared/desktop-api.ts` (the list is in build.rs). Only the app's own
//! windows can call them (capabilities/app.json), and every argument coming
//! from the page is checked before use (`validate.rs`): it arrives as JSON,
//! unknown until checked. Errors are codes (`project_busy`, `open_failed`…)
//! or `code: detail`, as the page expects.

use op_media_service::{
    ActivityEntry, DuplicatePage, FailedPage, FolderInfo, JobKind, LogLevel, TokenCheck,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::models::*;
use crate::paths::licenses_file;
use crate::shell::{Shell, apply_settings};
use crate::validate::{self, limits};

type Answer<T> = Result<T, String>;

fn bool_option(options: &Option<Value>, name: &str) -> bool {
    options
        .as_ref()
        .and_then(|o| o.get(name))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/* ------------------------------------------------------------------ projects */

#[tauri::command]
pub fn projects_list(shell: State<'_, Shell>) -> Vec<ProjectView> {
    shell.projects.views()
}

#[tauri::command]
pub async fn projects_create(shell: State<'_, Shell>, input: Value) -> Answer<ProjectView> {
    shell
        .projects
        .create(validate::new_project_input(&input)?)
        .await
}

#[tauri::command]
pub async fn projects_update(
    shell: State<'_, Shell>,
    id: Value,
    patch: Value,
) -> Answer<ProjectView> {
    shell
        .projects
        .update(
            &validate::project_id(&id)?,
            validate::project_patch(&patch)?,
        )
        .await
}

#[tauri::command]
pub async fn projects_remove(
    shell: State<'_, Shell>,
    id: Value,
    options: Option<Value>,
) -> Answer<()> {
    let delete_files = bool_option(&options, "delete_files");
    shell
        .projects
        .remove(&validate::project_id(&id)?, delete_files)
        .await
}

#[tauri::command]
pub fn projects_reveal_token(shell: State<'_, Shell>, id: Value) -> Answer<String> {
    shell.projects.reveal_token(&validate::project_id(&id)?)
}

/* ------------------------------------------------------------------ sync */

#[tauri::command]
pub fn sync_sync(shell: State<'_, Shell>, id: Value, options: Option<Value>) -> Answer<()> {
    let full_listing = bool_option(&options, "full_listing");
    let take_over = bool_option(&options, "take_over_folder");
    shell.projects.start_job(
        &validate::project_id(&id)?,
        JobKind::Sync,
        full_listing,
        take_over,
    )
}

#[tauri::command]
pub fn sync_sync_all(shell: State<'_, Shell>) {
    shell.projects.sync_all();
}

#[tauri::command]
pub fn sync_download(shell: State<'_, Shell>, id: Value) -> Answer<()> {
    shell
        .projects
        .start_job(&validate::project_id(&id)?, JobKind::Download, false, false)
}

#[tauri::command]
pub fn sync_retry_failed(shell: State<'_, Shell>, id: Value) -> Answer<()> {
    shell.projects.start_job(
        &validate::project_id(&id)?,
        JobKind::RetryFailed,
        false,
        false,
    )
}

#[tauri::command]
pub fn sync_confirm_cleanup(shell: State<'_, Shell>, id: Value) -> Answer<()> {
    shell
        .projects
        .start_job(&validate::project_id(&id)?, JobKind::Cleanup, false, false)
}

#[tauri::command]
pub fn sync_stop(shell: State<'_, Shell>, id: Value) -> Answer<()> {
    shell.projects.stop(&validate::project_id(&id)?);
    Ok(())
}

#[tauri::command]
pub fn sync_get_activity(
    shell: State<'_, Shell>,
    id: Value,
    limit: Option<Value>,
) -> Answer<Vec<ActivityEntry>> {
    shell.projects.activity(
        &validate::project_id(&id)?,
        validate::activity_limit(limit.as_ref()),
    )
}

#[tauri::command]
pub fn sync_get_failed(
    shell: State<'_, Shell>,
    id: Value,
    page: Option<Value>,
) -> Answer<FailedPage> {
    let page = validate::page_query(page.as_ref().unwrap_or(&Value::Null));
    shell.projects.failed(&validate::project_id(&id)?, &page)
}

#[tauri::command]
pub async fn sync_get_duplicates(
    shell: State<'_, Shell>,
    id: Value,
    page: Option<Value>,
) -> Answer<DuplicatePage> {
    let page = validate::page_query(page.as_ref().unwrap_or(&Value::Null));
    shell
        .projects
        .duplicates(&validate::project_id(&id)?, page)
        .await
}

/* ------------------------------------------------------------------ folders */

#[tauri::command]
pub async fn folders_pick(
    window: WebviewWindow,
    default_path: Option<Value>,
) -> Answer<Option<String>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut dialog = window.dialog().file().set_parent(&window);
    if let Some(folder) = validate::optional_folder(default_path.as_ref()) {
        dialog = dialog.set_directory(folder);
    }
    dialog.pick_folder(move |picked| {
        let _ = sender.send(picked);
    });
    let picked = receiver.await.map_err(|_| "dialog_failed".to_string())?;
    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn folders_inspect(
    shell: State<'_, Shell>,
    path: Value,
    project_id: Option<Value>,
) -> Answer<FolderInfo> {
    let folder = validate::folder_path(&path)?;
    let id = validate::optional_project_id(project_id.as_ref())?;
    Ok(shell.projects.inspect(&folder, id).await)
}

#[tauri::command]
pub async fn folders_open_project(
    app: AppHandle,
    shell: State<'_, Shell>,
    id: Value,
) -> Answer<()> {
    let folder = shell
        .projects
        .folder_to_open(&validate::project_id(&id)?)
        .await?;
    app.opener()
        .open_path(folder.to_string_lossy(), None::<&str>)
        .map_err(|_| "open_failed".to_string())
}

/* ------------------------------------------------------------------ tokens */

#[tauri::command]
pub async fn tokens_verify(shell: State<'_, Shell>, token: Value) -> Answer<TokenCheck> {
    Ok(shell
        .projects
        .verify_token(&validate::text(&token, limits::TOKEN)?)
        .await)
}

#[tauri::command]
pub async fn tokens_verify_project(shell: State<'_, Shell>, id: Value) -> Answer<TokenCheck> {
    shell
        .projects
        .verify_project_token(&validate::project_id(&id)?)
        .await
}

/* ------------------------------------------------------------------ settings */

#[tauri::command]
pub fn settings_get(shell: State<'_, Shell>) -> AppSettings {
    shell.store.settings()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, shell: State<'_, Shell>, patch: Value) -> Answer<AppSettings> {
    let patch = validate::settings_patch(&patch)?;
    let previous = shell.store.settings();
    let next = validate::apply_settings(&previous, &patch);
    shell.store.set_settings(&next);
    apply_settings(&app, &next, &previous);
    Ok(next)
}

/* ------------------------------------------------------------------ app */

#[tauri::command]
pub fn app_version(shell: State<'_, Shell>) -> VersionInfo {
    shell.updates.info()
}

#[tauri::command]
pub async fn app_check_for_updates(app: AppHandle, shell: State<'_, Shell>) -> Answer<VersionInfo> {
    let version = shell.updates.check().await;
    let _ = app.emit("app:version", &version);
    Ok(version)
}

#[tauri::command]
pub fn app_status(app: AppHandle, shell: State<'_, Shell>) -> AppStatus {
    shell.status.status(&app)
}

#[tauri::command]
pub fn app_open_external(app: AppHandle, url: Value) -> Answer<()> {
    let url = validate::external_url(&url).ok_or_else(|| "invalid_url".to_string())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "open_failed".to_string())
}

#[tauri::command]
pub fn app_copy_text(app: AppHandle, text: Value) -> Answer<()> {
    let text = validate::text(&text, limits::TEXT)?;
    app.clipboard()
        .write_text(text)
        .map_err(|_| "copy_failed".to_string())
}

#[tauri::command]
pub fn app_open_licenses(app: AppHandle) -> Answer<()> {
    let file = licenses_file(&app)
        .filter(|file| file.is_file())
        .ok_or_else(|| "open_failed".to_string())?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|_| "open_failed".to_string())
}

/// The page listens for the commands of the menus and the tray: those that came before it are handed over now
#[tauri::command]
pub fn app_take_commands(window: WebviewWindow, shell: State<'_, Shell>) -> Vec<AppCommand> {
    if window.label() != crate::window::MAIN {
        return Vec::new();
    }
    shell.main_window.take_commands()
}

/// Errors of the page, written to the app's log
#[tauri::command]
pub fn app_log(level: Value, message: Value) {
    let level = if level.as_str() == Some("warn") {
        LogLevel::Warn
    } else {
        LogLevel::Error
    };
    let message: String = match &message {
        Value::String(text) => text.chars().take(limits::LOG).collect(),
        other => other.to_string().chars().take(limits::LOG).collect(),
    };
    crate::log::log(level, format!("renderer: {message}"));
}

/// From the tray panel: show the main window and pass it a command (select a project, open the settings)
#[tauri::command]
pub fn app_show_main_window(app: AppHandle, shell: State<'_, Shell>, command: Option<Value>) {
    match validate::app_command(command.as_ref()) {
        Some(command) => shell.main_window.send_command(&app, command),
        None => {
            crate::tray::hide_panel(&app);
            shell.main_window.show(&app);
        }
    }
}

/// From the tray panel: quit, also when the app keeps running in the notification area
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) {
    let _ = window.close();
}
