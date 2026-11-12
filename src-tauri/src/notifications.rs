//! System notifications at the end of a job: done (with new files), failed
//! files, an error, or removals that wait for «Conferma» (an automatic sync
//! may find them with nobody looking); the same error, failure or removals
//! are not said twice in a row. And when the files of a removed project could
//! not be deleted (shown even with notifications off: the project has left
//! the list, nothing else would say it).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use op_media_service::{IssueCode, SyncOutcome, SyncResult, parse_iso_ms};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::i18n::texts;
use crate::models::ProjectView;
use crate::shell::Shell;

pub fn notify_result(app: &AppHandle, view: &ProjectView, result: &SyncResult) {
    let settings = app.state::<Shell>().store.settings();
    if !settings.notifications || result.outcome == SyncOutcome::Stopped {
        return;
    }
    let t = texts(settings.language);
    let confirm = view
        .runtime
        .issues
        .iter()
        .find(|issue| issue.code == IssueCode::CleanupNeedsConfirmation)
        .and_then(|issue| issue.count);
    // What the notification says, and what it says again only when it changes: the automatic
    // syncs would repeat the same error (On Page out of reach) or the same removals every round
    let (title, body, again) = if result.outcome == SyncOutcome::Failed {
        let code = result.error.as_ref().map(|issue| issue.code.as_str());
        (t.error_title(&view.label), t.error_body(code).to_string(), Some(format!("error {}", code.unwrap_or(""))))
    } else if result.failed > 0 {
        (t.failed_title(&view.label), t.failed_body(result.failed), Some(format!("failed {}", result.failed)))
    } else if result.downloaded > 0 {
        let ms = parse_iso_ms(&result.ended_at).unwrap_or(0) - parse_iso_ms(&result.started_at).unwrap_or(0);
        (t.done_title(&view.label), t.done_body(result.downloaded, &t.duration(ms)), None)
    } else if let Some(count) = confirm {
        (t.confirm_title(&view.label), t.confirm_body(count), Some(format!("confirm {count}")))
    } else {
        // A sync that found nothing new is not worth an interruption
        said().remove(&view.id);
        return;
    };
    match again {
        Some(again) if said().get(&view.id) == Some(&again) => return,
        Some(again) => {
            said().insert(view.id.clone(), again);
        }
        None => {
            said().remove(&view.id);
        }
    }
    show(app, &title, &body);
}

/// The last notification of each project that should not come twice in a row
fn said() -> MutexGuard<'static, HashMap<String, String>> {
    static SAID: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    SAID.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn notify_delete_failed(app: &AppHandle, label: &str, code: &str) {
    let t = texts(app.state::<Shell>().store.settings().language);
    let body = if code == "folder_other_project" { t.delete_other_project_body } else { t.delete_failed_body };
    show(app, &t.delete_failed_title(label), body);
}

fn show(app: &AppHandle, title: &str, body: &str) {
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        crate::warn!("Notification not shown: {error}");
    }
}
