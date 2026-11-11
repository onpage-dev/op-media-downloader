//! The application menu exists only on macOS, where users expect it (and the
//! Edit menu makes copy and paste work); its items send the page the same
//! commands its shortcuts run. A second launch with `--command=…` passes its
//! command to the running app.

use tauri::AppHandle;

use crate::models::AppCommand;

/// The command passed on the command line, if any
pub fn command_from_argv(argv: &[String]) -> Option<AppCommand> {
    let arg = argv
        .iter()
        .find_map(|value| value.strip_prefix("--command="))?;
    match arg {
        "sync_all" => Some(AppCommand::SyncAll),
        "new_project" => Some(AppCommand::NewProject { folder: None }),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
pub fn setup_menu(app: &AppHandle) {
    use tauri::Manager;
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let shell = app.state::<crate::shell::Shell>();
    let t = crate::i18n::texts(shell.store.settings().language);
    let m = &t.menu;
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let item = |id: &str, label: &str, accelerator: Option<&str>| {
            MenuItem::with_id(app, id, label, true, accelerator)
        };
        let app_menu = Submenu::with_items(
            app,
            t.app_name,
            true,
            &[
                &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
                &PredefinedMenuItem::separator(app)?,
                &item("open_settings", m.settings, Some("Cmd+,"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let file = Submenu::with_items(
            app,
            m.file,
            true,
            &[
                &item("new_project", m.new_project, Some("Cmd+N"))?,
                &item("open_folder_selected", m.open_folder, Some("Cmd+O"))?,
                &PredefinedMenuItem::separator(app)?,
                &item("focus_search", m.find, Some("Cmd+F"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ],
        )?;
        let edit = Submenu::with_items(
            app,
            m.edit,
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        let sync = Submenu::with_items(
            app,
            m.sync,
            true,
            &[
                &item("sync_selected", m.sync_selected, Some("Cmd+R"))?,
                &item("sync_all", m.sync_all, Some("Shift+Cmd+R"))?,
                &PredefinedMenuItem::separator(app)?,
                &item("download_selected", m.download, None)?,
                &item("stop_selected", m.stop, None)?,
            ],
        )?;
        let window = Submenu::with_items(
            app,
            m.window,
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &sync, &window])
    };
    match build() {
        Ok(menu) => {
            let _ = app.set_menu(menu);
        }
        Err(error) => crate::error!("The menu cannot be built: {error}"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn setup_menu(_app: &AppHandle) {}

/// A click on an item of the app menu
pub fn command_of_menu(id: &str) -> Option<AppCommand> {
    Some(match id {
        "open_settings" => AppCommand::OpenSettings { section: None },
        "new_project" => AppCommand::NewProject { folder: None },
        "open_folder_selected" => AppCommand::OpenFolderSelected,
        "focus_search" => AppCommand::FocusSearch,
        "sync_selected" => AppCommand::SyncSelected,
        "sync_all" => AppCommand::SyncAll,
        "download_selected" => AppCommand::DownloadSelected,
        "stop_selected" => AppCommand::StopSelected,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_from_the_command_line() {
        let argv = |args: &[&str]| args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(
            command_from_argv(&argv(&["app", "--command=sync_all"])),
            Some(AppCommand::SyncAll)
        );
        assert_eq!(
            command_from_argv(&argv(&["app", "--command=new_project"])),
            Some(AppCommand::NewProject { folder: None })
        );
        assert_eq!(command_from_argv(&argv(&["app", "--command=rm"])), None);
        assert_eq!(command_from_argv(&argv(&["app", "--hidden"])), None);
    }
}
