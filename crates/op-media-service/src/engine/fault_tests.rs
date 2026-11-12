//! The disk faults of `docs/ARCHITECTURE.md` («Faults of folders and
//! disks»), end to end against the fake On Page: the service's own disk
//! calls fail as a real disk would (`crate::faults`, by POSIX code, the same
//! on every system), and each test checks the promise of its row: the run
//! stops or only that file fails, with the right issue; no name ever holds
//! half a file; and the next run, the fault gone, ends the work.

use std::path::Path;

use super::tests::{Harness, list_dir};
use super::*;
use crate::faults::{Fault, Op, arm};
use crate::folder::manifest::{DATA_DIR, MANIFEST_FILE};
use crate::testing::file_content;

/// The names in the folder, each checked to hold its whole file
fn whole_names(h: &Harness, folder: &Path) -> Vec<String> {
    let remote = h.remote_names();
    let names: Vec<String> =
        list_dir(folder).into_iter().filter(|name| name != DATA_DIR && !name.starts_with(".opmd")).collect();
    for name in &names {
        let file = remote.get(name).unwrap_or_else(|| panic!("{name} is not a name of the project"));
        assert_eq!(std::fs::read(folder.join(name)).unwrap(), file_content(file), "{name} holds its whole file");
    }
    names
}

/// The run after the fault, the fault gone: every name there and whole, no temporary file left
async fn the_next_run_ends_the_work(h: &Harness, folder: &Path) {
    let result = h.run(|s| s.download(h.project(folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 0), "{result:?}");
    assert_eq!(whole_names(h, folder).len(), h.remote_names().len());
    let temporary: Vec<String> = list_dir(&folder.join(DATA_DIR))
        .into_iter()
        .filter(|name| name.ends_with(".download") || name.ends_with(".tmp"))
        .collect();
    assert!(temporary.is_empty(), "{temporary:?}");
}

/// The token of a name; the tests pick names whose content has no other name
/// (a photo is also its «copertina»: a fault on it fails two names)
fn token(h: &Harness, name: &str) -> String {
    h.remote_names()[name].token.clone()
}

fn failed_reasons(h: &Harness) -> Vec<FailureCode> {
    h.service
        .failed("p1", &PageQuery { offset: 0, limit: 50, query: None, labels: true })
        .entries
        .iter()
        .map(|e| e.reason)
        .collect()
}

/* ------------------------------------------------------------------ space */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn not_enough_free_space_for_the_plan_downloads_nothing() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Poco spazio");
    let room = arm(Fault::free_space(&folder, 10));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Failed);
    assert_eq!(result.error.unwrap().code, IssueCode::DiskFull);
    assert_eq!(h.fake.storage_hits(), 0, "nothing downloaded");
    assert!(whole_names(&h, &folder).is_empty());
    drop(room);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_disk_that_fills_up_mid_write_stops_the_run() {
    let h = Harness::new(10, 0).await;
    let folder = h.folder("Pieno");
    // Room for the plan when it starts, none left when this file is half written
    let full = arm(Fault::new(Op::Write, &folder, "ENOSPC").named(&token(&h, "prodotto-6.jpg")).after(500));
    let room = arm(Fault::free_space(&folder, 1024 * 1024));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Failed, "{result:?}");
    assert_eq!(result.error.unwrap().code, IssueCode::DiskFull);
    assert_eq!(full.hits(), 1);
    // The files done stay, none half written
    assert!(!whole_names(&h, &folder).contains(&"prodotto-6.jpg".to_string()));
    drop((full, room));
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_quota_used_up_is_a_full_disk() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Quota");
    let quota = arm(Fault::new(Op::Write, &folder, "EDQUOT").named(&token(&h, "prodotto-2.jpg")));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.error.unwrap().code, IssueCode::DiskFull);
    drop(quota);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_too_large_for_the_disk_fails_alone() {
    // ENOSPC with plenty of room left: the 4 GB limit of FAT32, one file only
    let h = Harness::new(5, 0).await;
    let folder = h.folder("FAT32");
    let big = arm(Fault::new(Op::Write, &folder, "ENOSPC").named(&token(&h, "prodotto-2-retro.jpg")));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    assert_eq!(failed_reasons(&h), vec![FailureCode::FileTooLarge]);
    assert!(!whole_names(&h, &folder).contains(&"prodotto-2-retro.jpg".to_string()));
    drop(big);
    let retried = h.run(|s| s.retry_failed(h.project(&folder))).await;
    assert_eq!((retried.outcome, retried.failed, retried.downloaded), (SyncOutcome::Completed, 0, 1));
    the_next_run_ends_the_work(&h, &folder).await;
}

/* ------------------------------------------------------------------ the folder going away */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_share_that_drops_stops_the_run_as_unreachable() {
    let h = Harness::new(10, 0).await;
    let folder = h.folder("Condivisione");
    let failing = arm(Fault::new(Op::Write, &folder, "EIO").named(&token(&h, "prodotto-4.jpg")));
    // The folder no longer answers
    let gone = arm(Fault::new(Op::Stat, &folder, "ENOENT"));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Failed, "{result:?}");
    assert_eq!(result.error.unwrap().code, IssueCode::FolderUnreachable);
    whole_names(&h, &folder);
    drop((failing, gone));
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_socket_error_of_a_share_is_never_retried_as_the_network() {
    // ECONNRESET on a write is the share's: the folder still answers, so that file fails,
    // and the file is not downloaded again and again
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Reset");
    let reset = arm(Fault::new(Op::Write, &folder, "ECONNRESET").named(&token(&h, "prodotto-3-retro.jpg")));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    assert_eq!(reset.hits(), 1, "not retried as a network error");
    assert_eq!(failed_reasons(&h), vec![FailureCode::WriteError]);
    drop(reset);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_io_error_with_the_folder_still_there_fails_that_file_only() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("EIO");
    let broken = arm(Fault::new(Op::Write, &folder, "EIO").named(&token(&h, "prodotto-1-retro.jpg")));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    assert_eq!(failed_reasons(&h), vec![FailureCode::WriteError]);
    assert!(h.issue_codes().contains(&IssueCode::FailedFiles));
    drop(broken);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_flush_that_fails_leaves_no_name() {
    // After a flush the name follows: a failed one must not give a name to a file the disk may not hold
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Flush");
    let flush = arm(Fault::new(Op::Flush, &folder, "EIO").named(&token(&h, "prodotto-5-retro.jpg")));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    assert!(!whole_names(&h, &folder).contains(&"prodotto-5-retro.jpg".to_string()));
    drop(flush);
    the_next_run_ends_the_work(&h, &folder).await;
}

/* ------------------------------------------------------------------ permissions and locks */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_read_only_folder_stops_before_writing_anything() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Sola lettura");
    let read_only = arm(Fault::new(Op::CreateDir, &folder, "EROFS"));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.error.unwrap().code, IssueCode::FolderNotWritable);
    assert_eq!(h.fake.storage_hits(), 0);
    assert!(list_dir(&folder).is_empty());
    drop(read_only);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_that_turns_read_only_during_the_run_stops_it() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Permessi tolti");
    // Neither the downloads nor the probe file can be created any more
    let denied = arm(Fault::new(Op::Create, &folder, "EACCES"));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Failed, "{result:?}");
    assert_eq!(result.error.unwrap().code, IssueCode::FolderNotWritable);
    drop(denied);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_the_folder_refuses_fails_alone_when_the_folder_is_writable() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Un file negato");
    let denied = arm(Fault::new(Op::Create, &folder, "EACCES").named(&token(&h, "prodotto-4-retro.jpg")));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    drop(denied);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_antivirus_holding_a_new_file_is_waited_for() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Antivirus");
    let held = arm(Fault::new(Op::Rename, &folder, "EBUSY").named(&token(&h, "prodotto-3.jpg")).times(3));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 0), "{result:?}");
    assert_eq!(held.hits(), 3, "tried again until the antivirus let go");
    assert_eq!(whole_names(&h, &folder).len(), h.remote_names().len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_open_in_another_program_is_removed_at_a_later_run() {
    let h = Harness::new(10, 0).await;
    let folder = h.folder("Aperto");
    h.run(|s| s.download(h.project(&folder))).await;
    // A product leaves On Page while its photo is open somewhere
    h.fake.with(|state| state.project.things.retain(|t| t.id != 1003));
    let open = arm(Fault::new(Op::Remove, &folder, "EBUSY").named("prodotto-3.jpg"));
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.outcome, SyncOutcome::Completed, "{result:?}");
    assert!(folder.join("prodotto-3.jpg").exists(), "not removed now");
    let failed: Vec<ActivityEntry> = h
        .service
        .activity("p1", None)
        .into_iter()
        .filter(|a| a.name == "prodotto-3.jpg" && a.outcome == ActivityOutcome::Failed)
        .collect();
    assert_eq!(failed.len(), 1);
    if cfg!(windows) {
        assert_eq!(failed[0].reason, Some(FailureCode::InUse));
    }
    // Still in the registry: once the program lets go, the next run removes it
    drop(open);
    h.run(|s| s.sync(h.project(&folder), false)).await;
    assert!(!folder.join("prodotto-3.jpg").exists());
    assert!(!folder.join("prodotto-3-retro.jpg").exists());
}

/* ------------------------------------------------------------------ links */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_without_hard_links_gets_copies() {
    // FAT, exFAT, some shares: the probe link in data/ is refused, every name is a copy
    let h = Harness::new(5, 0).await;
    let folder = h.folder("exFAT");
    let no_links = arm(Fault::new(Op::Link, &folder, "EXDEV"));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 0), "{result:?}");
    assert!(h.issue_codes().contains(&IssueCode::CopiesInsteadOfLinks), "{:?}", h.issue_codes());
    assert_eq!(whole_names(&h, &folder).len(), h.remote_names().len());
    assert!(no_links.hits() >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_content_with_too_many_links_gets_a_copy_for_that_name() {
    // NTFS takes 1023 names per file: the next one is a copy, the others stay links
    let h = Harness::new(5, 0).await;
    let folder = h.folder("1023");
    let many = arm(Fault::new(Op::Link, &folder, "EMLINK").named("prodotto-2-copertina.jpg"));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 0), "{result:?}");
    assert_eq!(many.hits(), 1);
    assert!(!h.issue_codes().contains(&IssueCode::CopiesInsteadOfLinks), "one copy is not a folder without links");
    assert_eq!(whole_names(&h, &folder).len(), h.remote_names().len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_name_the_folder_refuses_to_link_fails_alone() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Nome rifiutato");
    let refused = arm(Fault::new(Op::Link, &folder, "EINVAL").named("prodotto-2-retro.jpg"));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    assert_eq!(failed_reasons(&h), vec![FailureCode::LinkError]);
    assert!(!folder.join("prodotto-2-retro.jpg").exists());
    drop(refused);
    the_next_run_ends_the_work(&h, &folder).await;
}

/* ------------------------------------------------------------------ the registry and leftovers */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_registry_that_cannot_be_saved_fails_the_run_and_the_next_one_adopts_the_files() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Registro");
    let unsaved = arm(Fault::new(Op::Rename, &folder, "EIO").named(MANIFEST_FILE));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!(result.outcome, SyncOutcome::Failed, "{result:?}");
    assert!(unsaved.hits() >= 1);
    // The files stay, whole
    assert_eq!(whole_names(&h, &folder).len(), h.remote_names().len());
    let downloads = h.fake.storage_hits();
    drop(unsaved);
    // Registered by adoption: nothing downloaded again
    the_next_run_ends_the_work(&h, &folder).await;
    assert_eq!(h.fake.storage_hits(), downloads);
    assert!(folder.join(DATA_DIR).join(MANIFEST_FILE).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn leftovers_that_cannot_be_removed_never_block_a_download() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Avanzi");
    let data = folder.join(DATA_DIR);
    std::fs::create_dir_all(&data).unwrap();
    // What a crash leaves: a download cut halfway, a temporary name in the folder
    let partial = "0123456789abcdef01234567.1a2b3c4d.download";
    std::fs::write(data.join(partial), b"half").unwrap();
    std::fs::write(folder.join(".opmd-abc123"), b"half").unwrap();
    let stuck = arm(Fault::new(Op::Remove, &folder, "EACCES").named(".download"));
    let stuck_too = arm(Fault::new(Op::Remove, &folder, "EACCES").named(".opmd-abc123"));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 0), "{result:?}");
    assert_eq!(whole_names(&h, &folder).len(), h.remote_names().len());
    drop((stuck, stuck_too));
    // Removed at a later run
    h.run(|s| s.sync(h.project(&folder), false)).await;
    assert!(!data.join(partial).exists());
    assert!(!folder.join(".opmd-abc123").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn errors_before_the_work_starts_are_folder_issues_never_a_listing_failure() {
    let h = Harness::new(3, 0).await;
    for (code, issue) in [("EIO", IssueCode::FolderUnreachable), ("EACCES", IssueCode::FolderNotWritable)] {
        let folder = h.folder(&format!("Prima {code}"));
        std::fs::create_dir_all(&folder).unwrap();
        // The folder cannot be listed
        let unreadable = arm(Fault::new(Op::ReadDir, &folder, code));
        let result = h.run(|s| s.download(h.project(&folder))).await;
        assert_eq!(result.outcome, SyncOutcome::Failed, "{code}: {result:?}");
        assert_eq!(result.error.unwrap().code, issue, "{code}");
        drop(unreadable);
    }
}

/* ------------------------------------------------------------------ the network and On Page */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_that_comes_shorter_than_announced_gets_no_name() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Troncato");
    let cut = |content: Option<Vec<u8>>| {
        h.fake.with(|state| {
            let thing = state.project.thing_mut(1002).unwrap();
            if let Some(crate::testing::FakeValue::Files(gallery)) = thing.files.get_mut("galleria") {
                gallery[0].content = content;
            }
        })
    };
    // On Page announces 1,500 bytes, the storage sends 10
    cut(Some(vec![7; 10]));
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    assert_eq!(failed_reasons(&h), vec![FailureCode::SizeMismatch]);
    assert!(!folder.join("prodotto-2-retro.jpg").exists());
    cut(None);
    the_next_run_ends_the_work(&h, &folder).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_storage_that_stops_sending_fails_the_file_after_its_retries() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Muto");
    let silent = token(&h, "prodotto-3-retro.jpg");
    h.fake.with(|state| {
        state.storage.insert(silent.clone(), crate::testing::StorageBehaviour { mute: true, ..Default::default() })
    });
    let result = h.run(|s| s.download(h.project(&folder))).await;
    assert_eq!((result.outcome, result.failed), (SyncOutcome::Completed, 1), "{result:?}");
    assert_eq!(failed_reasons(&h), vec![FailureCode::Timeout]);
    h.fake.with(|state| state.storage.clear());
    let retried = h.run(|s| s.retry_failed(h.project(&folder))).await;
    assert_eq!((retried.failed, retried.downloaded), (0, 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn on_page_failing_leaves_the_folder_as_it_is() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("On Page in errore");
    h.run(|s| s.download(h.project(&folder))).await;
    let before = list_dir(&folder);
    h.fake.with(|state| state.api.fail_times = 1000);
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.outcome, SyncOutcome::Failed);
    assert_eq!(result.error.unwrap().code, IssueCode::ProjectUnavailable);
    assert_eq!(list_dir(&folder), before, "nothing removed when On Page cannot answer");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn on_page_out_of_reach_is_offline_and_touches_nothing() {
    let h = Harness::new(5, 0).await;
    let folder = h.folder("Senza rete");
    h.run(|s| s.download(h.project(&folder))).await;
    let before = list_dir(&folder);
    h.fake.close();
    let result = h.run(|s| s.sync(h.project(&folder), false)).await;
    assert_eq!(result.outcome, SyncOutcome::Failed);
    assert_eq!(result.error.unwrap().code, IssueCode::Offline);
    assert_eq!(list_dir(&folder), before);
}
