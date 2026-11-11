//! On Page Media Downloader: one instance, the main window, the tray, the
//! notifications and the sync service (`op-media-service`), wired together
//! in `shell.rs`. Anything that fails while the app starts is shown in an
//! error dialog and the app quits.

// No console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_status;
mod commands;
mod i18n;
mod menu;
mod notifications;
mod shell;
mod tray;
mod updates;
mod window;

// Projects, settings file, tokens, checks and log are shared with `opmd` and the MCP server
pub(crate) use op_media_projects::{error, info, warn};
pub(crate) use op_media_projects::{log, models, paths, projects, status, store, validate};

use tauri::{Manager, RunEvent};

fn main() {
    let app = tauri::Builder::default()
        // First: a second launch hands its arguments over and ends
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| shell::on_second_instance(app, argv)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .on_menu_event(|app, event| {
            if let Some(command) = menu::command_of_menu(event.id().as_ref()) {
                shell::send_command(app, command);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::projects_list,
            commands::projects_create,
            commands::projects_update,
            commands::projects_remove,
            commands::projects_reveal_token,
            commands::sync_sync,
            commands::sync_sync_all,
            commands::sync_download,
            commands::sync_retry_failed,
            commands::sync_confirm_cleanup,
            commands::sync_stop,
            commands::sync_get_activity,
            commands::sync_get_failed,
            commands::sync_get_duplicates,
            commands::sync_get_duplicate_variants,
            commands::folders_pick,
            commands::folders_inspect,
            commands::folders_open_project,
            commands::tokens_verify,
            commands::tokens_verify_project,
            commands::settings_get,
            commands::settings_set,
            commands::app_version,
            commands::app_check_for_updates,
            commands::app_status,
            commands::app_open_external,
            commands::app_copy_text,
            commands::app_open_licenses,
            commands::app_take_commands,
            commands::app_log,
            commands::app_show_main_window,
            commands::app_quit,
            commands::app_agent_access,
            commands::app_copy_agent_config,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(message) = shell::setup(&handle) {
                shell::start_failed(&handle, message);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            if let Some(shell) = app.try_state::<shell::Shell>()
                && shell.lifecycle.on_exit_requested(app, code)
            {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<shell::Shell>() {
                if let Some(server) = shell.agents.lock().take() {
                    server.stop();
                }
                shell.lifecycle.on_exit(app);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(shell) = app.try_state::<shell::Shell>() {
                shell.main_window.show(app);
            }
        }
        _ => {}
    });
}
