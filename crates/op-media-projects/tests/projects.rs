//! The projects as the app, opmd and the MCP server drive them
//! (`ProjectService`), against the fake On Page: creating, editing, running,
//! stopping and removing, what is refused and why, what survives a restart,
//! what another process changes, and what the window hears.

use std::sync::Arc;
use std::time::Duration;

use op_media_projects::models::{AppLanguage, NewProjectInput, ProjectPatch, ProjectView, SettingsPatch};
use op_media_projects::paths::AppPaths;
use op_media_projects::projects::{ProjectService, ProjectsEvent};
use op_media_projects::store::{AppStore, NoVault, StoreOptions, StoredProject};
use op_media_projects::{OpenOptions, Opened};
use op_media_service::testing::{FakeOnPage, StorageBehaviour, sample_project};
use op_media_service::{JobKind, JobPhase, SyncOutcome};
use parking_lot::Mutex;

struct App {
    fake: FakeOnPage,
    dir: tempfile::TempDir,
    projects: Arc<ProjectService>,
    store: Arc<AppStore>,
    /// What the window heard, in words
    heard: Arc<Mutex<Vec<String>>>,
}

impl App {
    async fn new() -> App {
        let fake = FakeOnPage::start(sample_project(6, 1, "projects"), "token-one", 0).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (projects, store, heard) = open(&dir, &fake);
        App { fake, dir, projects, store, heard }
    }

    fn folder(&self, name: &str) -> String {
        self.dir.path().join(name).display().to_string()
    }

    async fn create(&self, label: &str, folder: &str) -> Result<ProjectView, String> {
        self.projects
            .create(NewProjectInput {
                label: label.into(),
                token: self.fake.token.clone(),
                folder: folder.into(),
                keep_old_files: false,
                sync_now: false,
            })
            .await
    }

    /// Runs a job to its end: the project as it is then
    async fn run(&self, id: &str, job: JobKind) -> ProjectView {
        self.projects.start_job(id, job, false, false).unwrap();
        let view = self.projects.wait_job(id, Duration::from_secs(60)).await.unwrap();
        assert_eq!(view.runtime.phase, JobPhase::Idle, "the job ended");
        view
    }

    fn heard(&self, what: &str) -> bool {
        self.heard.lock().iter().any(|event| event.starts_with(what))
    }
}

/// The projects of a data folder, as the app opens them
fn open(dir: &tempfile::TempDir, fake: &FakeOnPage) -> (Arc<ProjectService>, Arc<AppStore>, Arc<Mutex<Vec<String>>>) {
    let heard: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    let Opened { projects, store } = op_media_projects::open(OpenOptions {
        paths: AppPaths::at(dir.path().join("data")),
        default_language: AppLanguage::En,
        keyring_service: None,
        api_domain: Some(fake.url.clone()),
        runtime: tokio::runtime::Handle::current(),
        notify: Box::new(move |event| {
            sink.lock().push(match event {
                ProjectsEvent::Changed(views) => format!("changed {}", views.len()),
                ProjectsEvent::Activity(_, entries) => format!("activity {}", entries.len()),
                ProjectsEvent::Result(view, result) => format!("result {} {:?}", view.label, result.outcome),
                ProjectsEvent::Settings { next, .. } => format!("settings {}", next.concurrency),
                ProjectsEvent::DeleteFailed { label, code } => format!("delete failed {label} {code}"),
            })
        }),
    })
    .unwrap();
    (projects, store, heard)
}

async fn eventually(what: &str, condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_project_needs_a_name_a_token_and_a_folder_of_its_own() {
    let app = App::new().await;
    let blank = |label: &str, token: &str| NewProjectInput {
        label: label.into(),
        token: token.into(),
        folder: app.folder("Uno"),
        keep_old_files: false,
        sync_now: false,
    };
    assert_eq!(app.projects.create(blank(" ", "t")).await.unwrap_err(), "invalid_input");
    assert_eq!(app.projects.create(blank("Uno", "  ")).await.unwrap_err(), "invalid_input");

    // The home folder, another project's folder, a data/ folder the app did not create
    let home = std::env::home_dir().unwrap().display().to_string();
    assert_eq!(app.create("Casa", &home).await.unwrap_err(), "folder_protected");
    let first = app.create("Uno", &app.folder("Uno")).await.unwrap();
    assert_eq!(app.create("Due", &app.folder("Uno")).await.unwrap_err(), "folder_used_by_other_project");
    let theirs = app.dir.path().join("Loro");
    std::fs::create_dir_all(theirs.join("data")).unwrap();
    std::fs::write(theirs.join("data").join("tesi.docx"), b"mine").unwrap();
    assert_eq!(app.create("Loro", &theirs.display().to_string()).await.unwrap_err(), "folder_foreign_data");

    assert!(first.has_token);
    assert_eq!(app.projects.views().len(), 1);
    // The window never gets the token
    let shown = serde_json::to_string(&app.projects.views()).unwrap();
    assert!(!shown.contains(&app.fake.token));
    assert!(app.heard("changed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn edits_that_change_what_the_folder_holds_start_over() {
    let app = App::new().await;
    let id = app.create("Catalogo", &app.folder("Catalogo")).await.unwrap().id;
    let synced = app.run(&id, JobKind::Sync).await;
    assert!(synced.runtime.plan.is_some());

    // A new name keeps what is known
    let renamed = app.projects.update(&id, ProjectPatch { label: Some("Listino".into()), ..Default::default() }).await;
    assert!(renamed.unwrap().runtime.plan.is_some());
    // The same token again changes nothing; another token starts over
    let same = ProjectPatch { token: Some(app.fake.token.clone()), ..Default::default() };
    assert!(app.projects.update(&id, same).await.unwrap().runtime.plan.is_some());
    let other = ProjectPatch { token: Some("another-token".into()), ..Default::default() };
    let view = app.projects.update(&id, other).await.unwrap();
    assert!(view.runtime.plan.is_none() && view.runtime.last_result.is_none());
    assert_eq!(app.projects.reveal_token(&id).unwrap(), "another-token");
    // A token that does not work says so at the next job (a failure is an issue, not a «last sync»)
    let failed = app.run(&id, JobKind::Sync).await;
    assert!(failed.runtime.last_result.is_none());
    assert!(failed.runtime.issues.iter().any(|issue| issue.code == op_media_service::IssueCode::TokenInvalid));
    let back = ProjectPatch { token: Some(app.fake.token.clone()), ..Default::default() };
    app.projects.update(&id, back).await.unwrap();

    // Another folder is checked as a new one; the old-files rule plans again
    let home = std::env::home_dir().unwrap().display().to_string();
    let protected = ProjectPatch { folder: Some(home), ..Default::default() };
    assert_eq!(app.projects.update(&id, protected).await.unwrap_err(), "folder_protected");
    let moved = ProjectPatch { folder: Some(app.folder("Altrove")), ..Default::default() };
    assert_eq!(app.projects.update(&id, moved).await.unwrap().folder, app.folder("Altrove"));
    app.run(&id, JobKind::Sync).await;
    let keep = ProjectPatch { keep_old_files: Some(true), ..Default::default() };
    let view = app.projects.update(&id, keep).await.unwrap();
    assert!(view.keep_old_files && view.runtime.plan.is_none());
    assert_eq!(app.projects.update("nope", ProjectPatch::default()).await.unwrap_err(), "project_not_found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_project_is_not_edited_runs_once_and_stops_on_request() {
    let app = App::new().await;
    let id = app.create("Lento", &app.folder("Lento")).await.unwrap().id;
    // Every file sends its headers and then nothing
    app.fake.with(|state| {
        for thing in &state.project.things {
            for value in thing.files.values() {
                for file in value.all() {
                    state.storage.insert(file.token.clone(), StorageBehaviour { mute: true, ..Default::default() });
                }
            }
        }
    });
    app.projects.start_job(&id, JobKind::Download, false, false).unwrap();
    eventually("the download runs", || app.projects.find(&id).unwrap().runtime.phase == JobPhase::Downloading).await;
    assert!(app.projects.is_running());
    let rename = ProjectPatch { label: Some("Altro".into()), ..Default::default() };
    assert_eq!(app.projects.update(&id, rename).await.unwrap_err(), "project_busy");
    // A second start while it runs is ignored
    app.projects.start_job(&id, JobKind::Sync, false, false).unwrap();
    assert_eq!(app.projects.find(&id).unwrap().runtime.job, Some(JobKind::Download));

    app.projects.stop(&id);
    let view = app.projects.wait_job(&id, Duration::from_secs(20)).await.unwrap();
    assert_eq!(view.runtime.phase, JobPhase::Idle);
    // Ended with its result: the window heard it before anyone waiting got the project back
    assert!(app.heard("result Lento Stopped"));
    assert!(view.runtime.last_result.is_none(), "a stop is not a «last sync»");
    assert!(!app.projects.is_running());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_removed_project_keeps_or_deletes_its_files_never_the_users() {
    let app = App::new().await;
    let kept = app.create("Tenuto", &app.folder("Tenuto")).await.unwrap().id;
    let deleted = app.create("Cancellato", &app.folder("Cancellato")).await.unwrap().id;
    app.run(&kept, JobKind::Download).await;
    app.run(&deleted, JobKind::Download).await;
    let mine = app.dir.path().join("Cancellato").join("appunti.txt");
    std::fs::write(&mine, b"mine").unwrap();

    app.projects.remove(&kept, false).await.unwrap();
    assert!(app.dir.path().join("Tenuto").join("prodotto-1.jpg").exists(), "its files stay");
    app.projects.remove(&deleted, true).await.unwrap();
    eventually("the files are deleted", || !app.projects.is_deleting()).await;
    let left: Vec<String> = std::fs::read_dir(app.dir.path().join("Cancellato"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, ["appunti.txt"], "only the user's file stays");
    assert!(app.projects.views().is_empty());
    assert_eq!(app.projects.remove(&kept, false).await.unwrap_err(), "project_not_found");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_all_runs_every_project_and_names_find_them() {
    let app = App::new().await;
    let one = app.create("Piante", &app.folder("Piante")).await.unwrap().id;
    let two = app.create("Vasi e accessori", &app.folder("Vasi")).await.unwrap().id;
    app.projects.sync_all();
    for id in [&one, &two] {
        let view = app.projects.wait_job(id, Duration::from_secs(60)).await.unwrap();
        assert!(view.runtime.plan.is_some(), "{} synced", view.label);
    }
    assert_eq!(app.projects.find("vasi e ACCESSORI").unwrap().id, two);
    assert_eq!(app.projects.find(&one).unwrap().label, "Piante");
    assert_eq!(app.projects.find("Altro").unwrap_err(), "project_not_found");
    app.create("piante", &app.folder("Piante 2")).await.unwrap();
    assert_eq!(app.projects.find("Piante").unwrap_err(), "project_ambiguous");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn settings_are_saved_applied_and_announced_once() {
    let app = App::new().await;
    let next = app.projects.set_settings(&SettingsPatch { concurrency: Some(2), ..Default::default() });
    assert_eq!(next.concurrency, 2);
    assert_eq!(app.store.settings().concurrency, 2);
    assert!(app.heard("settings 2"));
    let count = app.heard.lock().len();
    app.projects.set_settings(&SettingsPatch { concurrency: Some(2), ..Default::default() });
    assert_eq!(app.heard.lock().len(), count, "nothing changed, nothing said");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn what_a_project_learnt_survives_a_restart() {
    let app = App::new().await;
    let id = app.create("Riavvio", &app.folder("Riavvio")).await.unwrap().id;
    // Waiting for a job gives it back with its result, never just before
    let done = app.run(&id, JobKind::Download).await;
    assert_eq!(done.runtime.last_result.as_ref().unwrap().outcome, SyncOutcome::Completed);
    // The app starts again on the same data
    let (again, _, _) = open(&app.dir, &app.fake);
    let view = again.find(&id).unwrap();
    assert_eq!(view.runtime.last_result.unwrap().downloaded, done.runtime.last_result.unwrap().downloaded);
    assert!(view.runtime.plan.is_some());
    assert!(view.runtime.issues.iter().any(|issue| issue.code == op_media_service::IssueCode::Duplicates));
    assert_eq!(again.reveal_token(&id).unwrap(), app.fake.token);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_project_another_process_adds_reaches_the_window() {
    let app = App::new().await;
    // opmd, or another instance, on the same data
    let other = AppStore::open(StoreOptions {
        dir: app.dir.path().join("data"),
        default_language: AppLanguage::En,
        vault: Box::new(NoVault),
        legacy: None,
    });
    let fields = other.store_token("from-opmd", "token-from-opmd");
    let project = StoredProject {
        id: "from-opmd".into(),
        label: "Da opmd".into(),
        folder: app.folder("Da opmd"),
        keep_old_files: false,
        created_at: "2026-11-12T00:00:00.000Z".into(),
        token_enc: None,
        token_plain: fields.token_plain,
        token_keyring: fields.token_keyring,
        last_result: None,
        plan: None,
        issues: None,
        folder_info: None,
        onpage_project: None,
        take_over_folder: false,
    };
    other.save_project(&project).unwrap();
    eventually("the app shows it", || app.projects.views().iter().any(|v| v.label == "Da opmd")).await;
    eventually("the window hears of it", || app.heard("changed 1")).await;
    assert_eq!(app.projects.reveal_token("from-opmd").unwrap(), "token-from-opmd");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tokens_are_checked_without_leaving_the_app() {
    let app = App::new().await;
    let id = app.create("Token", &app.folder("Token")).await.unwrap().id;
    assert!(app.projects.verify_project_token(&id).await.unwrap().ok);
    assert!(!app.projects.verify_token("wrong").await.ok);
    assert!(!app.projects.verify_token("  ").await.ok);
}

/// The app's automatic syncs: the projects whose last job is older than the
/// interval are brought up to date, one job each, once per interval; a shared
/// folder another computer synced within it is left alone; off, nothing
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn automatic_syncs_bring_the_projects_up_to_date_once_per_interval() {
    let app = App::new().await;
    let uno = app.create("Uno", &app.folder("Uno")).await.unwrap();
    let due = app.create("Due", &app.folder("Due")).await.unwrap();
    assert!(app.projects.auto_sync().await.started.is_empty(), "off by default");
    let saved = app.projects.set_settings(&SettingsPatch { auto_sync_minutes: Some(60), ..SettingsPatch::default() });
    assert_eq!(saved.auto_sync_minutes, 60);

    // Another computer brought Due's folder up to date ten minutes ago
    let data = std::path::Path::new(&due.folder).join("data");
    std::fs::create_dir_all(&data).unwrap();
    let at = op_media_service::iso_ms(op_media_service::now_ms() - 600_000);
    let synced = format!(r#"{{"at":"{at}","instance_id":"another-app","host":"pc-di-luca"}}"#);
    std::fs::write(data.join("synced.json"), synced).unwrap();

    let round = app.projects.auto_sync().await;
    assert_eq!(round.started, vec![uno.id.clone()]);
    let skipped = &round.skipped[0];
    assert_eq!(
        (skipped.project.as_str(), skipped.reason, skipped.host.as_str()),
        (due.id.as_str(), "synced", "pc-di-luca")
    );
    assert_eq!(skipped.minutes_ago, Some(10));
    // One job: listed and downloaded
    let view = app.projects.wait_job(&uno.id, Duration::from_secs(60)).await.unwrap();
    let result = view.runtime.last_result.unwrap();
    assert_eq!((result.job, result.outcome), (JobKind::Download, SyncOutcome::Completed));
    assert!(result.downloaded > 0 && std::path::Path::new(&uno.folder).join("prodotto-1.jpg").exists());
    // It says so for the other computers
    assert!(std::path::Path::new(&uno.folder).join("data").join("synced.json").exists());

    // Within the hour nothing again: Uno just ended a job, Due was tried
    let again = app.projects.auto_sync().await;
    assert!(again.started.is_empty() && again.skipped.is_empty(), "{again:?}");
}

#[test]
fn an_automatic_sync_waits_the_interval_after_a_job_or_a_try() {
    use op_media_projects::projects::auto_sync_due;
    use op_media_projects::validate::auto_sync;
    let hour = Duration::from_secs(3600);
    let now = 10 * 3_600_000;
    assert!(auto_sync_due(now, None, None, hour), "never synced");
    assert!(!auto_sync_due(now, Some(now - 1_800_000), None, hour), "a job half an hour ago");
    assert!(auto_sync_due(now, Some(now - 3_600_000), None, hour));
    assert!(!auto_sync_due(now, Some(now - 7_200_000), Some(now - 60_000), hour), "tried a minute ago");
    // The minutes as people and agents give them: 0 is never, else 15 minutes to a week
    let minutes = |value: serde_json::Value| auto_sync(Some(&value));
    assert_eq!(minutes(serde_json::json!(0)), Some(0));
    assert_eq!(minutes(serde_json::json!(5)), Some(15));
    assert_eq!(minutes(serde_json::json!(60.4)), Some(60));
    assert_eq!(minutes(serde_json::json!(100_000)), Some(10_080));
    assert_eq!(minutes(serde_json::json!(-3)), Some(0));
    assert_eq!(minutes(serde_json::json!("60")), None);
}
