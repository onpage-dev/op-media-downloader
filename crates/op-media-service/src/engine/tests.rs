//! The engine end to end, against the fake On Page: the flows, the safety
//! rules and the faults that matter most. The fault-injection cases of the
//! file system that need a mocked disk are covered by the unit tests of the
//! modules (manifest, lock, link, executor's decisions in error.rs).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::*;
use crate::folder::lock::LockInfo;
use crate::folder::manifest::{DATA_DIR, LINK_JSON_FILE, LOCK_FILE, MANIFEST_FILE};
use crate::testing::{FakeFile, FakeOnPage, FakeValue, StorageBehaviour, file_content, sample_project};

const FAST: RetryPolicy = RetryPolicy {
    attempts: 3,
    base_delay: Duration::from_millis(5),
    max_delay: Duration::from_millis(20),
    max_retry_after: Duration::from_millis(50),
};

fn timings() -> Timings {
    Timings {
        state_interval: Duration::from_millis(5),
        activity_interval: Duration::from_millis(5),
        api_policy: FAST,
        download_policy: FAST,
        api_timeout: Duration::from_secs(5),
        headers_timeout: Duration::from_secs(2),
        idle_timeout: Duration::from_secs(1),
        page_size: 7,
        reach_timeout: Duration::from_secs(3),
        lock_heartbeat: Duration::from_millis(100),
        lock_stale: Duration::from_millis(1500),
        ..Timings::default()
    }
}

struct Harness {
    fake: FakeOnPage,
    service: MediaService,
    events: Arc<Mutex<Vec<ServiceEvent>>>,
    root: tempfile::TempDir,
    _cache: tempfile::TempDir,
}

impl Harness {
    async fn new(things: usize, duplicates: usize) -> Harness {
        let fake = FakeOnPage::start(sample_project(things, duplicates, "opmd"), "fake-token", 0).await.unwrap();
        let events: Arc<Mutex<Vec<ServiceEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let cache = tempfile::tempdir().unwrap();
        let service = MediaService::with_handle(
            ServiceConfig {
                cache_dir: cache.path().to_path_buf(),
                concurrency: 4,
                instance_id: "test-instance".into(),
                api_domain: Some(fake.url.clone()),
                project_folders: Vec::new(),
                timings: timings(),
            },
            Arc::new(move |event| sink_events.lock().push(event)),
            Handle::current(),
        );
        Harness { fake, service, events, root: tempfile::tempdir().unwrap(), _cache: cache }
    }

    fn folder(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn project(&self, folder: &Path) -> ServiceProject {
        ServiceProject {
            id: "p1".into(),
            label: "Prova".into(),
            token: self.fake.token.clone(),
            folder: folder.to_string_lossy().into_owned(),
            keep_old_files: false,
            take_over_folder: false,
            onpage_project_id: None,
        }
    }

    /// Starts a job and waits for its result
    async fn run(&self, start: impl FnOnce(&MediaService)) -> SyncResult {
        let before = self.events.lock().len();
        start(&self.service);
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let found = self.events.lock()[before..].iter().rev().find_map(|e| match e {
                    ServiceEvent::Result { result, .. } => Some(result.clone()),
                    _ => None,
                });
                if let Some(result) = found {
                    self.service.idle().await;
                    return result;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the job ended")
    }

    fn last_state(&self) -> ProjectRuntime {
        self.events
            .lock()
            .iter()
            .rev()
            .find_map(|e| match e {
                ServiceEvent::State { runtime, .. } => Some(runtime.clone()),
                _ => None,
            })
            .expect("a state")
    }

    fn issue_codes(&self) -> Vec<IssueCode> {
        self.last_state().issues.iter().map(|i| i.code).collect()
    }

    /// Every file the sample serves, by the name the folder will show (the first of a name wins)
    fn remote_names(&self) -> BTreeMap<String, FakeFile> {
        let mut out: BTreeMap<String, FakeFile> = BTreeMap::new();
        let mut keys = HashSet::new();
        self.fake.with(|state| {
            let mut things = state.project.things.clone();
            things.sort_by_key(|t| (t.resource_id, t.id));
            for thing in &things {
                for value in thing.files.values() {
                    let files: Vec<&FakeFile> = match value {
                        FakeValue::Files(files) => files.iter().collect(),
                        FakeValue::ByLang(by_lang) => {
                            ["it", "en"].iter().filter_map(|l| by_lang.get(*l)).flatten().collect()
                        }
                    };
                    for file in files {
                        if keys.insert(file.name.to_lowercase()) {
                            out.insert(file.name.clone(), file.clone());
                        }
                    }
                }
            }
        });
        out
    }

    async fn wait_for(&self, condition: impl Fn(&[ServiceEvent]) -> bool) {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !condition(&self.events.lock()) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the condition came true");
    }
}

fn list_dir(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sync_download_sync_again_and_only_ours_removed() {
    let h = Harness::new(20, 2).await;
    let folder = h.folder("Catalogo");
    let names = h.remote_names();

    // «Sincronizza»: plan only, nothing written
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!((result.job, result.outcome), (JobKind::Sync, SyncOutcome::Completed));
    let plan = h.last_state().plan.unwrap();
    assert_eq!(plan.listing, ListingMode::Full);
    assert_eq!(plan.duplicates, 2);
    assert_eq!(plan.to_download_names, names.len() as u64);
    assert!(!plan.cleanup_needs_confirmation);
    assert_eq!(h.issue_codes(), vec![IssueCode::Duplicates]);
    assert!(list_dir(&folder).is_empty(), "a «Sincronizza» leaves no trace in a new folder");

    // «Scarica»
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Completed, "{result:?}");
    assert_eq!((result.failed, result.downloaded), (0, names.len() as u64));
    for (name, file) in &names {
        assert_eq!(std::fs::read(folder.join(name)).unwrap(), file_content(file), "{name}");
    }
    // A content shared by two names was downloaded once
    let tokens: HashSet<&String> = names.values().map(|f| &f.token).collect();
    assert_eq!(h.fake.storage_hits(), tokens.len() as u64);
    let plan = h.last_state().plan.unwrap();
    assert_eq!((plan.to_download, plan.to_link, plan.to_remove), (0, 0, 0));
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(folder.join(DATA_DIR).join(MANIFEST_FILE)).unwrap()).unwrap();
    assert_eq!(manifest["onpage_project"]["id"], 77);

    // A file of the user in the same folder; nothing changed on On Page: nothing to do, incremental
    std::fs::write(folder.join("appunti.docx"), "mio").unwrap();
    let hits = h.fake.storage_hits();
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!((result.downloaded, result.linked, result.removed), (0, 0, 0));
    assert_eq!(result.already_present, names.len() as u64);
    assert_eq!(h.last_state().plan.unwrap().listing, ListingMode::Incremental);
    assert_eq!(h.fake.storage_hits(), hits);

    // A product leaves On Page: its three names go, the user's file stays
    h.fake.with(|state| state.project.things.retain(|t| t.id != 1010));
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!((result.outcome, result.removed), (SyncOutcome::Completed, 3));
    let left = list_dir(&folder);
    assert!(!left.contains(&"prodotto-10.jpg".to_string()));
    assert!(!left.contains(&"prodotto-10-retro.jpg".to_string()));
    assert_eq!(std::fs::read_to_string(folder.join("appunti.docx")).unwrap(), "mio");

    // Activity and duplicates for the inspector
    assert!(h.service.activity("p1", None).iter().any(|a| a.outcome == ActivityOutcome::Removed));
    let page = h.service.duplicates(h.project(&folder), PageQuery { offset: 0, limit: 50, query: None }).await.unwrap();
    assert_eq!((page.total, page.language_variants, page.groups.len()), (2, 0, 2));
    let chosen = &page.groups[0].variants[0];
    assert!(chosen.chosen);
    assert_eq!(chosen.uses[0].resource_label, "Prodotti");
    assert_eq!(chosen.uses[0].field_label, "Foto principale");
    assert_eq!(chosen.uses[0].thing_label.as_deref(), Some("Prodotto 1"));
    assert!(chosen.uses[0].edit_url.ends_with("#/things/edit/1001/77/1/12"), "{}", chosen.uses[0].edit_url);
    let searched = h
        .service
        .duplicates(h.project(&folder), PageQuery { offset: 0, limit: 50, query: Some("PRODOTTO-2".into()) })
        .await
        .unwrap();
    assert_eq!(searched.total, 1);

    // Deleting the project's files: only ours, the folder stays for the user's file
    let deleted = h.service.delete_project_files(h.project(&folder)).await.unwrap();
    assert!(!deleted.removed_folder);
    assert_eq!(deleted.kept_entries, 1);
    assert_eq!(list_dir(&folder), vec!["appunti.docx"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changes_on_on_page_arrive_with_the_incremental_listing() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Inc");
    h.run(|s| s.download(h.project(&folder))).await;
    // Renamed on On Page: the thing's _updated_at changes
    h.fake.with(|state| {
        let thing = state.project.thing_mut(1002).unwrap();
        if let Some(FakeValue::Files(files)) = thing.files.get_mut("foto") {
            files[0].name = "prodotto-2-nuovo.jpg".into();
        }
    });
    h.fake.touch(1002);
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.outcome, SyncOutcome::Completed);
    let names = list_dir(&folder);
    assert!(names.contains(&"prodotto-2-nuovo.jpg".to_string()), "{names:?}");
    assert!(!names.contains(&"prodotto-2.jpg".to_string()));
    // Same content: a link, no download
    assert_eq!(result.downloaded, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_removals_wait_for_a_confirmation() {
    let h = Harness::new(60, 0).await;
    let folder = h.folder("Molti");
    h.run(|s| s.download(h.project(&folder))).await;
    let before = list_dir(&folder).len();
    // A wrong View: almost everything leaves
    h.fake.with(|state| state.project.things.retain(|t| t.id <= 1002));
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!((result.outcome, result.removed), (SyncOutcome::Completed, 0));
    assert!(h.last_state().plan.unwrap().cleanup_needs_confirmation);
    assert!(h.issue_codes().contains(&IssueCode::CleanupNeedsConfirmation));
    assert_eq!(list_dir(&folder).len(), before, "nothing removed before the user confirms");
    let result = h.run(|s| s.confirm_cleanup(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Completed);
    assert!(result.removed > 50, "{result:?}");
    assert!(!h.last_state().plan.unwrap().cleanup_needs_confirmation);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_ends_quickly_and_leaves_nothing_half_written() {
    let h = Harness::new(10, 0).await;
    let folder = h.folder("Stop");
    // Every file sends its headers and then nothing: the transfers hang until stopped
    let tokens: Vec<String> = h.remote_names().values().map(|f| f.token.clone()).collect();
    h.fake.with(|state| {
        for token in &tokens {
            state.storage.insert(token.clone(), StorageBehaviour { mute: true, ..StorageBehaviour::default() });
        }
    });
    let before = h.events.lock().len();
    h.service.download(h.project(&folder));
    h.wait_for(|events| {
        events[before..].iter().any(|e| matches!(e, ServiceEvent::State { runtime, .. } if runtime.progress.as_ref().is_some_and(|p| p.in_flight > 0)))
    })
    .await;
    let asked = std::time::Instant::now();
    h.service.stop("p1");
    let stopped = h.run(|_| {}).await;
    assert_eq!(stopped.outcome, SyncOutcome::Stopped, "{stopped:?}");
    assert!(asked.elapsed() < Duration::from_millis(900), "before the idle timeout: {:?}", asked.elapsed());
    let phases: Vec<JobPhase> = h.events.lock()[before..]
        .iter()
        .filter_map(|e| match e {
            ServiceEvent::State { runtime, .. } => Some(runtime.phase),
            _ => None,
        })
        .collect();
    assert!(phases.contains(&JobPhase::Stopping));
    let data = list_dir(&folder.join(DATA_DIR));
    assert!(data.iter().all(|n| !n.ends_with(".download")), "{data:?}");
    assert!(list_dir(&folder).iter().all(|n| !n.starts_with(".opmd-")));
    // What is left is the plan of the next «Scarica»
    assert_eq!(h.last_state().plan.unwrap().to_download_names, h.remote_names().len() as u64);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failures_are_listed_and_retry_fixes_them() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Falliti");
    let names = h.remote_names();
    let broken = names["prodotto-3-retro.jpg"].token.clone();
    let gone = names["scheda-1-it.pdf"].token.clone();
    h.fake.with(|state| {
        state.storage.insert(broken.clone(), StorageBehaviour { fail_times: 100, ..StorageBehaviour::default() });
        state.storage.insert(gone.clone(), StorageBehaviour { missing: true, ..StorageBehaviour::default() });
    });
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 2));
    let failed = h.service.failed("p1", &PageQuery { offset: 0, limit: 50, query: None });
    let reasons: HashSet<FailureCode> = failed.entries.iter().map(|e| e.reason).collect();
    assert_eq!(reasons, HashSet::from([FailureCode::HttpError, FailureCode::NotFound]));
    assert!(h.issue_codes().contains(&IssueCode::FailedFiles));
    h.fake.with(|state| state.storage.clear());
    let result = h.run(|s| s.retry_failed(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed, result.downloaded), (SyncOutcome::Completed, 0, 2));
    assert_eq!(h.service.failed("p1", &PageQuery { offset: 0, limit: 50, query: None }).total, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_trouble_is_retried() {
    let h = Harness::new(3, 0).await;
    let folder = h.folder("Rete");
    let names = h.remote_names();
    let cut = names["prodotto-1.jpg"].token.clone();
    let slow = names["prodotto-2.jpg"].token.clone();
    h.fake.with(|state| {
        state.api.rate_limit_times = 2;
        state.api.retry_after_s = 0;
        state.storage.insert(cut.clone(), StorageBehaviour { reset_times: 1, ..StorageBehaviour::default() });
        state.storage.insert(
            slow.clone(),
            StorageBehaviour { rate_limit_times: 1, retry_after_s: 0, ..StorageBehaviour::default() },
        );
    });
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 0), "{result:?}");
    assert_eq!(std::fs::read(folder.join("prodotto-1.jpg")).unwrap(), file_content(&names["prodotto-1.jpg"]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn errors_end_the_job_with_the_right_issue() {
    let h = Harness::new(3, 0).await;
    let folder = h.folder("Errori");
    let wrong = ServiceProject { token: "wrong".into(), ..h.project(&folder) };
    let result = h.run(|s| s.sync(wrong, false)).await;
    assert_eq!(result.outcome, SyncOutcome::Failed);
    assert_eq!(result.error.unwrap().code, IssueCode::TokenInvalid);

    let home = std::env::home_dir().unwrap();
    let result = h
        .run(|s| s.sync(ServiceProject { folder: home.to_string_lossy().into_owned(), ..h.project(&folder) }, false))
        .await;
    assert_eq!(result.error.unwrap().code, IssueCode::FolderProtected);

    // A data folder the user already had is never used
    std::fs::create_dir_all(folder.join(DATA_DIR)).unwrap();
    std::fs::write(folder.join(DATA_DIR).join("tesi.docx"), "x").unwrap();
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.error.unwrap().code, IssueCode::FolderProtected);
    let deleted = h.service.delete_project_files(h.project(&folder)).await.unwrap();
    assert_eq!(deleted.removed_files, 0);
    assert!(folder.join(DATA_DIR).join("tesi.docx").exists());

    // The checks of the new project form
    let check = h.service.verify_token(h.fake.token.clone()).await;
    assert!(check.ok);
    assert_eq!((check.project_id, check.collections_with_files), (Some(77), Some(2)));
    assert_eq!(h.service.verify_token("nope".into()).await.error, Some(TokenError::TokenInvalid));
    let info = h.service.inspect_folder(h.folder("Nuova").to_string_lossy().into_owned(), None).await;
    assert!(info.writable && !info.exists && info.problems.is_empty(), "{info:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_on_page_project_per_folder() {
    let h = Harness::new(3, 0).await;
    let folder = h.folder("Progetto");
    h.run(|s| s.download(h.project(&folder))).await;
    // Another On Page project's folder: nothing is touched
    let manifest_file = folder.join(DATA_DIR).join(MANIFEST_FILE);
    let mut manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
    manifest["onpage_project"] = serde_json::json!({ "id": 99, "label": "Listino 2026" });
    std::fs::write(&manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let before = list_dir(&folder);
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    let error = result.error.unwrap();
    assert_eq!(error.code, IssueCode::FolderOtherProject);
    assert_eq!(error.detail.as_deref(), Some("Listino 2026"));
    assert_eq!(list_dir(&folder), before);
    // Deleting the files is refused too
    let refused =
        h.service.delete_project_files(ServiceProject { onpage_project_id: Some(77), ..h.project(&folder) }).await;
    assert!(refused.unwrap_err().starts_with("folder_other_project"));
    // The user's choice takes it over
    let result = h.run(|s| s.sync(ServiceProject { take_over_folder: true, ..h.project(&folder) }, false)).await;
    assert_eq!(result.outcome, SyncOutcome::Completed);
    assert_eq!(result.onpage_project.unwrap().id, 77);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn another_computers_lock_stops_the_job() {
    let h = Harness::new(3, 0).await;
    let folder = h.folder("Condivisa");
    std::fs::create_dir_all(folder.join(DATA_DIR)).unwrap();
    std::fs::write(folder.join(DATA_DIR).join(MANIFEST_FILE), r#"{"version":2,"project_id":"x","files":{}}"#).unwrap();
    let other = LockInfo {
        host: "altro-pc".into(),
        pid: 1,
        instance_id: "other".into(),
        project_id: "x".into(),
        started_at: now_iso(),
        heartbeat_at: iso_ms(chrono::Utc::now().timestamp_millis() + 60_000),
    };
    std::fs::write(folder.join(DATA_DIR).join(LOCK_FILE), serde_json::to_vec(&other).unwrap()).unwrap();
    let result = h.run(|s| s.download(h.project(&folder))).await;
    let error = result.error.unwrap();
    assert_eq!(error.code, IssueCode::FolderLocked);
    assert!(error.detail.unwrap().contains("altro-pc"));
    let info = h.service.inspect_folder(folder.to_string_lossy().into_owned(), Some("p1".into())).await;
    assert!(info.problems.contains(&FolderProblem::Locked));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_1x_folder_is_taken_over_without_downloading_or_removing() {
    let h = Harness::new(3, 0).await;
    let folder = h.folder("Uno");
    let names = h.remote_names();
    // 1.x: data/<token> and hard links, data/link.json
    std::fs::create_dir_all(folder.join(DATA_DIR)).unwrap();
    let mut links = serde_json::Map::new();
    for (name, file) in &names {
        let blob = folder.join(DATA_DIR).join(&file.token);
        if !blob.exists() {
            std::fs::write(&blob, file_content(file)).unwrap();
        }
        std::fs::hard_link(&blob, folder.join(name)).unwrap();
        links.insert(name.clone(), serde_json::json!(file.token));
    }
    std::fs::write(folder.join(DATA_DIR).join(LINK_JSON_FILE), serde_json::to_vec(&links).unwrap()).unwrap();
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.outcome, SyncOutcome::Completed, "{result:?}");
    assert_eq!((result.downloaded, result.removed), (0, 0));
    assert_eq!(h.fake.storage_hits(), 0);
    assert_eq!(h.last_state().plan.unwrap().up_to_date, names.len() as u64);
    assert!(folder.join(DATA_DIR).join(MANIFEST_FILE).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_job_is_ignored_and_forget_frees_the_project() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Doppio");
    let tokens: Vec<String> = h.remote_names().values().map(|f| f.token.clone()).collect();
    h.fake.with(|state| {
        for token in &tokens {
            state.storage.insert(
                token.clone(),
                StorageBehaviour { delay: Duration::from_millis(200), ..StorageBehaviour::default() },
            );
        }
    });
    let before = h.events.lock().len();
    h.service.download(h.project(&folder));
    h.service.sync(h.project(&folder), false);
    assert!(h.service.is_busy("p1"));
    assert_eq!(h.service.delete_project_files(h.project(&folder)).await.unwrap_err(), "project_busy");
    h.wait_for(|events| events[before..].iter().any(|e| matches!(e, ServiceEvent::Result { .. }))).await;
    h.service.idle().await;
    let results: Vec<JobKind> = h.events.lock()[before..]
        .iter()
        .filter_map(|e| match e {
            ServiceEvent::Result { result, .. } => Some(result.job),
            _ => None,
        })
        .collect();
    assert_eq!(results, vec![JobKind::Download]);
    h.service.forget("p1");
    h.service.idle().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!h.service.is_busy("p1"));
    assert!(h.service.activity("p1", None).is_empty(), "its memory went");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_registry_of_the_folder() {
    let h = Harness::new(4, 0).await;
    let folder = h.folder("Registro");
    h.run(|s| s.download(h.project(&folder))).await;
    let manifest_file = folder.join(DATA_DIR).join(MANIFEST_FILE);
    let names = list_dir(&folder);

    // Cut by a power cut: the names are recognised by their size, nothing removed or downloaded again
    std::fs::write(&manifest_file, "{\"version\":2,\"files\":{\"prodotto-1.jpg\"").unwrap();
    let hits = h.fake.storage_hits();
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!((result.outcome, result.downloaded, result.removed), (SyncOutcome::Completed, 0, 0), "{result:?}");
    assert_eq!(h.fake.storage_hits(), hits);
    assert_eq!(list_dir(&folder), names);
    let rebuilt: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
    assert_eq!(rebuilt["files"].as_object().unwrap().len(), names.len() - 1, "every name but data/");

    // Written by a newer version of the app: left as it is, the job ends
    let newer = r#"{"version":3,"files":{}}"#;
    std::fs::write(&manifest_file, newer).unwrap();
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.error.unwrap().code, IssueCode::FolderProtected);
    assert_eq!(std::fs::read_to_string(&manifest_file).unwrap(), newer);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_incomplete_listing_removes_nothing_until_a_complete_one() {
    let h = Harness::new(4, 0).await;
    let folder = h.folder("Incompleta");
    h.run(|s| s.download(h.project(&folder))).await;
    h.fake.with(|state| {
        state.api.fail_resource = Some("schede".into());
        state.project.things.retain(|t| t.id != 1001);
    });
    let result = h.run(|s| s.sync(h.project(&folder), true)).await;
    assert_eq!((result.outcome, result.removed), (SyncOutcome::Completed, 0), "{result:?}");
    let issue = h.last_state().issues.into_iter().find(|i| i.code == IssueCode::ListingIncomplete).unwrap();
    assert_eq!(issue.detail.as_deref(), Some("Schede tecniche"));
    assert!(folder.join("scheda-1-it.pdf").exists(), "the collection not read keeps its files");
    h.fake.with(|state| state.api.fail_resource = None);
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.removed, 3);
    assert!(!h.issue_codes().contains(&IssueCode::ListingIncomplete));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn leftovers_are_cleared_and_foreign_names_are_conflicts() {
    let h = Harness::new(3, 0).await;
    let folder = h.folder("Residui");
    std::fs::create_dir_all(folder.join(DATA_DIR)).unwrap();
    std::fs::write(folder.join(DATA_DIR).join(MANIFEST_FILE), r#"{"version":2,"project_id":"p1","files":{}}"#).unwrap();
    std::fs::write(folder.join(DATA_DIR).join("0123456789abcdef0123456789abcdef01234567.1a2b3c4d.download"), "half")
        .unwrap();
    std::fs::write(folder.join(".opmd-0a1b2c3d4e5f"), "half").unwrap();
    // A file of the user under a wanted name, with another size
    std::fs::write(folder.join("prodotto-2.jpg"), "mine").unwrap();
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Completed, "{result:?}");
    assert_eq!(std::fs::read_to_string(folder.join("prodotto-2.jpg")).unwrap(), "mine", "never overwritten");
    assert!(list_dir(&folder).iter().all(|n| !n.starts_with(".opmd-")));
    assert!(list_dir(&folder.join(DATA_DIR)).iter().all(|n| !n.ends_with(".download")));
    assert_eq!(h.last_state().plan.unwrap().conflicts, 1);
    assert!(h.issue_codes().contains(&IssueCode::NameConflicts));
    let failed = h.service.failed("p1", &PageQuery { offset: 0, limit: 50, query: None });
    assert_eq!(failed.entries[0].reason, FailureCode::NameConflict);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keep_old_files_never_removes() {
    let h = Harness::new(3, 0).await;
    let folder = h.folder("Tieni");
    let project = ServiceProject { keep_old_files: true, ..h.project(&folder) };
    h.run(|s| s.download(project.clone())).await;
    h.fake.with(|state| state.project.things.retain(|t| t.id != 1001));
    let result = h.run(|s| s.sync(project.clone(), false)).await;
    assert_eq!(result.removed, 0);
    assert!(folder.join("prodotto-1.jpg").exists());
}
