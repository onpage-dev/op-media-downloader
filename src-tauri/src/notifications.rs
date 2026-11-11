//! System notifications at the end of a job: done (with new files), failed
//! files, or an error; and when the files of a removed project could not be
//! deleted (shown even with notifications off: the project has left the
//! list, nothing else would say it).

use op_media_service::{SyncOutcome, SyncResult, parse_iso_ms};
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
    let (title, body) = if result.outcome == SyncOutcome::Failed {
        let code = result.error.as_ref().map(|issue| issue.code.as_str());
        (t.error_title(&view.label), t.error_body(code).to_string())
    } else if result.failed > 0 {
        (t.failed_title(&view.label), t.failed_body(result.failed))
    } else if result.downloaded > 0 {
        let ms = parse_iso_ms(&result.ended_at).unwrap_or(0)
            - parse_iso_ms(&result.started_at).unwrap_or(0);
        (
            t.done_title(&view.label),
            t.done_body(result.downloaded, &t.duration(ms)),
        )
    } else {
        // A sync that found nothing new is not worth an interruption
        return;
    };
    show(app, &title, &body);
}

pub fn notify_delete_failed(app: &AppHandle, label: &str, code: &str) {
    let t = texts(app.state::<Shell>().store.settings().language);
    let body = if code == "folder_other_project" {
        t.delete_other_project_body
    } else {
        t.delete_failed_body
    };
    show(app, &t.delete_failed_title(label), body);
}

fn show(app: &AppHandle, title: &str, body: &str) {
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        crate::warn!("Notification not shown: {error}");
    }
}
