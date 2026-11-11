//! The app's commands are declared here: Tauri generates a permission for
//! each, and `capabilities/app.json` grants them to the app's windows only
//! (through the set in `permissions/app-commands.toml`).

/// Keep in step with `src/commands.rs`, `permissions/app-commands.toml` and `src/renderer/src/desktop/tauri.ts`
const COMMANDS: &[&str] = &[
    "projects_list",
    "projects_create",
    "projects_update",
    "projects_remove",
    "projects_reveal_token",
    "sync_sync",
    "sync_sync_all",
    "sync_download",
    "sync_retry_failed",
    "sync_confirm_cleanup",
    "sync_stop",
    "sync_get_activity",
    "sync_get_failed",
    "sync_get_duplicates",
    "folders_pick",
    "folders_inspect",
    "folders_open_project",
    "tokens_verify",
    "tokens_verify_project",
    "settings_get",
    "settings_set",
    "app_version",
    "app_check_for_updates",
    "app_status",
    "app_open_external",
    "app_copy_text",
    "app_open_licenses",
    "app_take_commands",
    "app_log",
    "app_show_main_window",
    "app_quit",
    "window_minimize",
    "window_toggle_maximize",
    "window_close",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
