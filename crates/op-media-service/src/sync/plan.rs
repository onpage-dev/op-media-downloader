//! The plan: what a folder needs to match On Page. A pure function of the
//! remote names, the manifest and one scan of the folder, so it can be tested
//! on hundreds of thousands of files and never touches a disk.
//!
//! Safety rules (docs/ARCHITECTURE.md):
//! 1. only names in the manifest and contents in data/ are ever removed;
//! 2. a name on disk that the manifest does not know is never overwritten:
//!    it is adopted only when it is the same file as data/<token> or has the
//!    expected size, otherwise it is a conflict;
//! 3. removals above the threshold wait for a confirmation, which covers
//!    the names it was given and nothing else;
//! 4. no removal after an incomplete listing.

use std::collections::{HashMap, HashSet};

use rustc_hash::{FxHashMap, FxHashSet};

use super::names::{DesiredFile, name_key, same_name};
use crate::folder::manifest::{Manifest, ManifestEntry, ManifestFiles, ManifestMode};
use crate::folder::scan::{EntryType, FolderScan};
use crate::models::{ListingMode, PlanSummary};

pub const CLEANUP_MIN_NAMES: usize = 50;
pub const CLEANUP_MIN_RATIO: f64 = 0.25;

/// Facts about a name on disk that the manifest does not know (rule 2)
#[derive(Debug, Clone, Default)]
pub struct AdoptionStat {
    /// The name is the same file as data/<token> (a hard link of 1.x)
    pub same_file: bool,
    pub name_size: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct NameTarget {
    /// Final name in the folder
    pub name: String,
    pub remote_name: String,
    pub size: Option<u64>,
    /// A name of ours (same key) to replace: content changed or case changed
    pub replace: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DownloadTask {
    pub token: String,
    pub size: Option<u64>,
    pub names: Vec<NameTarget>,
}

#[derive(Debug, Clone)]
pub struct LinkTask {
    pub target: NameTarget,
    pub token: String,
}

/// Same content, only the case of the name changes
#[derive(Debug, Clone)]
pub struct RenameTask {
    pub from: String,
    pub to: String,
    pub token: String,
    pub entry: ManifestEntry,
}

#[derive(Debug, Clone)]
pub struct Adoption {
    pub name: String,
    pub token: String,
    pub size: Option<u64>,
    pub mode: ManifestMode,
    pub remote_name: String,
}

#[derive(Debug, Clone)]
pub struct Conflict {
    pub name: String,
    pub token: String,
    pub remote_name: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub downloads: Vec<DownloadTask>,
    pub links: Vec<LinkTask>,
    pub renames: Vec<RenameTask>,
    pub adoptions: Vec<Adoption>,
    pub remove_names: Vec<String>,
    pub remove_tokens: Vec<String>,
    /// Manifest entries whose file is gone and is not wanted: forget them
    pub drop_entries: Vec<String>,
    pub conflicts: Vec<Conflict>,
    pub up_to_date: u64,
    /// Removals held back by the threshold: what a confirmation of the user covers
    pub withheld: Vec<String>,
    /// `created_at` is set when the plan is shown
    pub summary: PlanSummary,
}

pub struct PlanInput<'a> {
    pub desired: &'a [DesiredFile],
    pub manifest: ManifestFiles<'a>,
    pub scan: &'a FolderScan,
    pub keep_old_files: bool,
    pub listing_complete: bool,
    pub listing: ListingMode,
    /// Names the user confirmed for removal: they go whatever the threshold
    pub confirmed: Option<&'a HashSet<String>>,
    pub duplicates: u64,
    /// For the keys returned by adoption_candidates
    pub adoption: Option<&'a HashMap<String, AdoptionStat>>,
}

pub struct AdoptionCandidate {
    pub key: String,
    pub name: String,
    pub token: String,
}

/// Desired names on disk that the manifest does not know: they need a stat
pub fn adoption_candidates(
    desired: &[DesiredFile],
    manifest: ManifestFiles<'_>,
    scan: &FolderScan,
) -> Vec<AdoptionCandidate> {
    desired
        .iter()
        .filter(|file| manifest.by_key(&file.key).is_none())
        .filter_map(|file| {
            let entry = scan.entries.get(&file.key)?;
            (entry.kind == EntryType::File).then(|| AdoptionCandidate {
                key: file.key.clone(),
                name: entry.name.clone(),
                token: file.token.clone(),
            })
        })
        .collect()
}

pub fn build_plan(input: PlanInput<'_>) -> Plan {
    let PlanInput { desired, manifest, scan, .. } = input;
    let mut downloads: Vec<DownloadTask> = Vec::new();
    let mut download_of: FxHashMap<String, usize> = FxHashMap::default();
    let mut links: Vec<LinkTask> = Vec::new();
    let mut renames: Vec<RenameTask> = Vec::new();
    let mut adoptions: Vec<Adoption> = Vec::new();
    let mut conflicts: Vec<Conflict> = Vec::new();
    let mut up_to_date = 0u64;

    let mut need = |token: &str, target: NameTarget| {
        if scan.data_tokens.contains(token) {
            links.push(LinkTask { target, token: token.to_string() });
            return;
        }
        let index = *download_of.entry(token.to_string()).or_insert_with(|| {
            downloads.push(DownloadTask { token: token.to_string(), size: target.size, names: Vec::new() });
            downloads.len() - 1
        });
        downloads[index].names.push(target);
    };

    let mut desired_keys: FxHashSet<&str> = FxHashSet::with_capacity_and_hasher(desired.len(), Default::default());
    for file in desired {
        desired_keys.insert(&file.key);
        let on_disk = scan.entries.get(&file.key);
        let owned = manifest.by_key(&file.key);
        // Built only for a name that needs work: most of 200k names are up to date
        let target = |replace: Option<String>| NameTarget {
            name: file.local_name.clone(),
            remote_name: file.remote_name.clone(),
            size: file.size,
            replace,
        };
        let conflict = || Conflict {
            name: file.local_name.clone(),
            token: file.token.clone(),
            remote_name: file.remote_name.clone(),
            size: file.size,
        };

        if let Some(entry) = on_disk.filter(|e| e.kind != EntryType::File) {
            // A folder (or something else) took the name: never touched
            let _ = entry;
            conflicts.push(conflict());
            continue;
        }

        if let Some((owned_name, entry)) = owned {
            match on_disk {
                None => {
                    let replace = (owned_name != file.local_name).then(|| owned_name.to_string());
                    need(&file.token, target(replace));
                }
                Some(disk) if entry.token == file.token => {
                    if same_name(&disk.name, &file.local_name) {
                        up_to_date += 1;
                    } else {
                        renames.push(RenameTask {
                            from: disk.name.clone(),
                            to: file.local_name.clone(),
                            token: file.token.clone(),
                            entry: entry.clone(),
                        });
                    }
                }
                Some(disk) => need(&file.token, target(Some(disk.name.clone()))),
            }
            continue;
        }

        let Some(disk) = on_disk else {
            need(&file.token, target(None));
            continue;
        };

        // Rule 2: a file the manifest does not know
        let stat = input.adoption.and_then(|a| a.get(&file.key));
        let same_file = stat.is_some_and(|s| s.same_file) && scan.data_tokens.contains(&file.token);
        let same_size = matches!((stat.and_then(|s| s.name_size), file.size), (Some(a), Some(b)) if a == b);
        if same_file || same_size {
            let mode = if same_file { ManifestMode::Link } else { ManifestMode::Adopted };
            adoptions.push(Adoption {
                name: disk.name.clone(),
                token: file.token.clone(),
                size: file.size,
                mode,
                remote_name: file.remote_name.clone(),
            });
            if same_name(&disk.name, &file.local_name) {
                up_to_date += 1;
            } else {
                renames.push(RenameTask {
                    from: disk.name.clone(),
                    to: file.local_name.clone(),
                    token: file.token.clone(),
                    entry: ManifestEntry {
                        token: file.token.clone(),
                        size: file.size,
                        mode,
                        remote_name: Some(file.remote_name.clone()),
                    },
                });
            }
            continue;
        }
        conflicts.push(Conflict {
            name: disk.name.clone(),
            token: file.token.clone(),
            remote_name: file.remote_name.clone(),
            size: file.size,
        });
    }

    // Removals: rules 1, 3, 4
    let mut remove_names: Vec<String> = Vec::new();
    let mut drop_entries: Vec<String> = Vec::new();
    for (name, _) in manifest.iter() {
        // ASCII names (most) are compared without building their key
        let key: std::borrow::Cow<'_, str> = if name.bytes().any(|b| b.is_ascii_uppercase() || !b.is_ascii()) {
            name_key(name).into()
        } else {
            name.into()
        };
        if desired_keys.contains(key.as_ref()) {
            continue;
        }
        let Some(disk) = scan.entries.get(key.as_ref()) else {
            drop_entries.push(name.clone());
            continue;
        };
        if input.keep_old_files || !input.listing_complete {
            continue;
        }
        // The name on disk must be exactly ours and a plain file
        if same_name(&disk.name, name) && disk.kind == EntryType::File {
            remove_names.push(name.clone());
        } else {
            drop_entries.push(name.clone());
        }
    }

    // Rule 3: the names confirmed go; above the threshold the others wait
    let unconfirmed: Vec<String> = match input.confirmed {
        Some(confirmed) => remove_names.iter().filter(|n| !confirmed.contains(*n)).cloned().collect(),
        None => remove_names.clone(),
    };
    let mut withheld: Vec<String> = Vec::new();
    if unconfirmed.len() > CLEANUP_MIN_NAMES && unconfirmed.len() as f64 > CLEANUP_MIN_RATIO * manifest.len() as f64 {
        withheld = unconfirmed;
        remove_names = match input.confirmed {
            Some(confirmed) => remove_names.into_iter().filter(|n| confirmed.contains(n)).collect(),
            None => Vec::new(),
        };
    }

    // Contents nobody needs any more
    let mut remove_tokens: Vec<String> = Vec::new();
    if input.listing_complete {
        let mut referenced: FxHashSet<&str> = desired.iter().map(|f| f.token.as_str()).collect();
        let leaving: FxHashSet<&str> = remove_names.iter().chain(&drop_entries).map(String::as_str).collect();
        for (name, entry) in manifest.iter() {
            // Wanted names get the wanted token: their old content is no longer needed
            if !leaving.contains(name.as_str()) && !desired_keys.contains(name_key(name).as_str()) {
                referenced.insert(&entry.token);
            }
        }
        let mut tokens: Vec<&String> = scan.data_tokens.iter().filter(|t| !referenced.contains(t.as_str())).collect();
        tokens.sort();
        remove_tokens = tokens.into_iter().cloned().collect();
    }

    let summary = PlanSummary {
        created_at: String::new(),
        remote_names: desired.len() as u64,
        remote_bytes: desired.iter().map(|f| f.size.unwrap_or(0)).sum(),
        to_download: downloads.len() as u64,
        to_download_names: downloads.iter().map(|t| t.names.len() as u64).sum(),
        to_download_bytes: downloads.iter().map(|t| t.size.unwrap_or(0)).sum(),
        to_link: (links.len() + renames.len()) as u64,
        // What waits for the user, when something does
        to_remove: if withheld.is_empty() { remove_names.len() } else { withheld.len() } as u64,
        up_to_date,
        duplicates: input.duplicates,
        conflicts: conflicts.len() as u64,
        cleanup_needs_confirmation: !withheld.is_empty(),
        listing: input.listing,
    };

    Plan {
        downloads,
        links,
        renames,
        adoptions,
        remove_names,
        remove_tokens,
        drop_entries,
        conflicts,
        up_to_date,
        withheld,
        summary,
    }
}

/// Only what changes the manifest alone: adoptions, forgotten names; conflicts are recorded
pub fn bookkeeping(plan: &Plan) -> Plan {
    Plan {
        downloads: Vec::new(),
        links: Vec::new(),
        renames: Vec::new(),
        remove_names: Vec::new(),
        remove_tokens: Vec::new(),
        ..plan.clone()
    }
}

/// The removals and the bookkeeping: downloads and links wait
pub fn removals_only(plan: &Plan) -> Plan {
    Plan { downloads: Vec::new(), links: Vec::new(), renames: Vec::new(), ..plan.clone() }
}

/// Downloads and links of these names only, and the bookkeeping
pub fn only_names(plan: &Plan, names: &HashSet<String>) -> Plan {
    Plan {
        downloads: plan
            .downloads
            .iter()
            .map(|t| DownloadTask {
                names: t.names.iter().filter(|n| names.contains(&n.name)).cloned().collect(),
                ..t.clone()
            })
            .filter(|t| !t.names.is_empty())
            .collect(),
        links: plan.links.iter().filter(|l| names.contains(&l.target.name)).cloned().collect(),
        ..bookkeeping(plan)
    }
}

/// After the whole plan ran: nothing is left but the removals held back
/// (what failed is in the failed list, «Riprova i falliti» takes it again)
pub fn summary_after(plan: &Plan, linked: u64, downloaded: u64, conflicts: u64) -> PlanSummary {
    PlanSummary {
        to_download: 0,
        to_download_names: 0,
        to_download_bytes: 0,
        to_link: 0,
        to_remove: plan.withheld.len() as u64,
        up_to_date: plan.summary.up_to_date + linked + downloaded,
        conflicts,
        cleanup_needs_confirmation: !plan.withheld.is_empty(),
        ..plan.summary.clone()
    }
}

/// What is left of a plan after part of it ran (a stop, the failed names
/// only, the removals only), from the manifest the run kept up to date: the
/// folder is not scanned again (a share of 200k files takes minutes)
pub fn summary_left(plan: &Plan, manifest: &Manifest, conflicts: u64) -> PlanSummary {
    let placed = |name: &str, token: &str| manifest.get(name).is_some_and(|e| e.token == token);
    let mut up_to_date = plan.summary.up_to_date;
    let (mut to_download, mut to_download_names, mut to_download_bytes, mut to_link) = (0u64, 0u64, 0u64, 0u64);
    for task in &plan.downloads {
        let left = task.names.iter().filter(|n| !placed(&n.name, &task.token)).count() as u64;
        up_to_date += task.names.len() as u64 - left;
        if left == task.names.len() as u64 {
            to_download += 1;
            to_download_names += left;
            to_download_bytes += task.size.unwrap_or(0);
        } else {
            // The content arrived: the names left are links to it
            to_link += left;
        }
    }
    let linked = plan.links.iter().map(|l| (l.target.name.as_str(), l.token.as_str()));
    let renamed = plan.renames.iter().map(|r| (r.to.as_str(), r.token.as_str()));
    for (name, token) in linked.chain(renamed) {
        if placed(name, token) {
            up_to_date += 1;
        } else {
            to_link += 1;
        }
    }
    let removals_left = plan.remove_names.iter().filter(|n| manifest.get(n).is_some()).count();
    PlanSummary {
        to_download,
        to_download_names,
        to_download_bytes,
        to_link,
        to_remove: if plan.withheld.is_empty() { removals_left } else { plan.withheld.len() } as u64,
        up_to_date,
        conflicts,
        cleanup_needs_confirmation: !plan.withheld.is_empty(),
        ..plan.summary.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::scan::FolderEntry;
    use crate::sync::names::FileUse;
    use std::path::Path;

    fn want(name: &str, token: &str) -> DesiredFile {
        DesiredFile {
            key: name_key(name),
            local_name: name.into(),
            remote_name: name.into(),
            token: token.into(),
            size: Some(10),
            use_: FileUse { resource_id: 1, thing_id: 1, field_id: 1, lang: None },
        }
    }

    fn manifest(files: &[(&str, &str)]) -> Manifest {
        let manifest = Manifest::new(Path::new("data"), "p");
        for (name, token) in files {
            manifest.set(
                name,
                ManifestEntry { token: token.to_string(), size: None, mode: ManifestMode::Link, remote_name: None },
            );
        }
        manifest
    }

    fn scan(files: &[&str], tokens: &[&str]) -> FolderScan {
        let mut scan = FolderScan::default();
        for name in files {
            scan.entries.insert(name_key(name), FolderEntry { name: name.to_string(), kind: EntryType::File });
        }
        scan.data_tokens = tokens.iter().map(|t| t.to_string()).collect();
        scan
    }

    fn plan(desired: &[DesiredFile], manifest: &Manifest, scan: &FolderScan) -> Plan {
        plan_with(desired, manifest, scan, None, None)
    }

    fn plan_with(
        desired: &[DesiredFile],
        manifest: &Manifest,
        scan: &FolderScan,
        confirmed: Option<&HashSet<String>>,
        adoption: Option<&HashMap<String, AdoptionStat>>,
    ) -> Plan {
        manifest.read(|manifest| {
            build_plan(PlanInput {
                desired,
                manifest,
                scan,
                keep_old_files: false,
                listing_complete: true,
                listing: ListingMode::Full,
                confirmed,
                duplicates: 0,
                adoption,
            })
        })
    }

    #[test]
    fn an_empty_folder_downloads_each_content_once() {
        let desired = [want("a.jpg", "t1"), want("b.jpg", "t1"), want("c.jpg", "t2")];
        let p = plan(&desired, &manifest(&[]), &scan(&[], &[]));
        assert_eq!(p.downloads.len(), 2);
        assert_eq!(p.downloads[0].names.len(), 2);
        assert_eq!(p.summary.to_download_names, 3);
    }

    #[test]
    fn an_up_to_date_folder_has_nothing_to_do() {
        let p = plan(&[want("a.jpg", "t1")], &manifest(&[("a.jpg", "t1")]), &scan(&["a.jpg"], &["t1"]));
        assert_eq!(p.up_to_date, 1);
        assert!(
            p.downloads.is_empty() && p.links.is_empty() && p.remove_names.is_empty() && p.remove_tokens.is_empty()
        );
    }

    #[test]
    fn a_decomposed_name_is_the_same_name() {
        let nfd = "cafe\u{301}.jpg";
        let p = plan(&[want("café.jpg", "t1")], &manifest(&[("café.jpg", "t1")]), &scan(&[nfd], &["t1"]));
        assert_eq!(p.up_to_date, 1);
    }

    #[test]
    fn a_name_deleted_by_hand_is_linked_again_and_a_changed_file_replaced() {
        let p = plan(&[want("a.jpg", "t1")], &manifest(&[("a.jpg", "t1")]), &scan(&[], &["t1"]));
        assert_eq!(p.links.len(), 1);
        let p = plan(&[want("a.jpg", "t2")], &manifest(&[("a.jpg", "t1")]), &scan(&["a.jpg"], &["t1"]));
        assert_eq!(p.downloads[0].names[0].replace.as_deref(), Some("a.jpg"));
        assert_eq!(p.remove_tokens, ["t1"]);
    }

    #[test]
    fn only_the_case_changed_is_a_rename() {
        let p = plan(&[want("A.jpg", "t1")], &manifest(&[("a.jpg", "t1")]), &scan(&["a.jpg"], &["t1"]));
        assert_eq!(p.renames.len(), 1);
        assert!(p.downloads.is_empty());
    }

    #[test]
    fn rule_1_only_names_of_ours_are_removed() {
        let p = plan(&[], &manifest(&[("old.jpg", "t1")]), &scan(&["old.jpg", "mine.docx"], &["t1"]));
        assert_eq!(p.remove_names, ["old.jpg"]);
        assert_eq!(p.remove_tokens, ["t1"]);
        let p = plan(&[], &manifest(&[("gone.jpg", "t1")]), &scan(&[], &[]));
        assert_eq!(p.drop_entries, ["gone.jpg"]);
    }

    #[test]
    fn rule_2_unknown_files_are_conflicts_unless_adopted() {
        let desired = [want("a.jpg", "t1")];
        let p = plan(&desired, &manifest(&[]), &scan(&["a.jpg"], &[]));
        assert_eq!(p.conflicts.len(), 1);
        let stats = HashMap::from([(name_key("a.jpg"), AdoptionStat { same_file: false, name_size: Some(10) })]);
        let p = plan_with(&desired, &manifest(&[]), &scan(&["a.jpg"], &[]), None, Some(&stats));
        assert_eq!(p.adoptions.len(), 1);
        assert_eq!(p.adoptions[0].mode, ManifestMode::Adopted);
        let stats = HashMap::from([(name_key("a.jpg"), AdoptionStat { same_file: true, name_size: Some(3) })]);
        let p = plan_with(&desired, &manifest(&[]), &scan(&["a.jpg"], &["t1"]), None, Some(&stats));
        assert_eq!(p.adoptions[0].mode, ManifestMode::Link);
        let mut folder = scan(&[], &[]);
        folder.entries.insert(name_key("a.jpg"), FolderEntry { name: "a.jpg".into(), kind: EntryType::Dir });
        assert_eq!(plan(&desired, &manifest(&[]), &folder).conflicts.len(), 1);
    }

    #[test]
    fn rule_3_many_removals_wait_and_a_confirmation_covers_its_names_only() {
        let files: Vec<(String, String)> = (0..100).map(|i| (format!("f{i}.jpg"), format!("t{i}"))).collect();
        let pairs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let names: Vec<&str> = files.iter().map(|(a, _)| a.as_str()).collect();
        let tokens: Vec<&str> = files.iter().map(|(_, b)| b.as_str()).collect();
        let (m, s) = (manifest(&pairs), scan(&names, &tokens));
        let desired = [want("f0.jpg", "t0")];
        let p = plan(&desired, &m, &s);
        assert!(p.remove_names.is_empty());
        assert_eq!(p.withheld.len(), 99);
        assert!(p.summary.cleanup_needs_confirmation);
        assert_eq!(p.summary.to_remove, 99);
        assert!(p.remove_tokens.is_empty(), "contents of withheld names stay");
        let confirmed: HashSet<String> = p.withheld.iter().cloned().collect();
        let p = plan_with(&desired, &m, &s, Some(&confirmed), None);
        assert_eq!(p.remove_names.len(), 99);
        assert!(!p.summary.cleanup_needs_confirmation);
        // 10 confirmed, 89 more since then: those wait again
        let ten: HashSet<String> = (90..100).map(|i| format!("f{i}.jpg")).collect();
        let p = plan_with(&desired, &m, &s, Some(&ten), None);
        assert_eq!(p.remove_names.len(), 10);
        assert_eq!(p.withheld.len(), 89);
        assert_eq!(p.remove_tokens.len(), 10);
        // Below the threshold the rest goes as without a confirmation
        let sixty: HashSet<String> = (40..100).map(|i| format!("f{i}.jpg")).collect();
        assert_eq!(plan_with(&desired, &m, &s, Some(&sixty), None).remove_names.len(), 99);
    }

    #[test]
    fn rule_4_an_incomplete_listing_removes_nothing() {
        let m = manifest(&[("old.jpg", "t1")]);
        let s = scan(&["old.jpg"], &["t1"]);
        let p = m.read(|manifest| {
            build_plan(PlanInput {
                desired: &[],
                manifest,
                scan: &s,
                keep_old_files: false,
                listing_complete: false,
                listing: ListingMode::Full,
                confirmed: None,
                duplicates: 0,
                adoption: None,
            })
        });
        assert!(p.remove_names.is_empty() && p.remove_tokens.is_empty());
    }

    #[test]
    fn what_is_left_after_part_of_a_plan_ran() {
        let desired = [want("a.jpg", "t1"), want("b.jpg", "t1"), want("c.jpg", "t2")];
        let m = manifest(&[]);
        let p = plan(&desired, &m, &scan(&[], &[]));
        m.set("a.jpg", ManifestEntry { token: "t1".into(), size: None, mode: ManifestMode::Link, remote_name: None });
        let left = summary_left(&p, &m, 0);
        assert_eq!((left.to_download, left.to_link, left.up_to_date), (1, 1, 1));
        let only = only_names(&p, &HashSet::from(["c.jpg".to_string()]));
        assert_eq!(only.downloads.len(), 1);
        assert_eq!(only.downloads[0].token, "t2");
    }

    #[test]
    fn plans_100_000_files_quickly() {
        let n = 100_000;
        let desired: Vec<DesiredFile> =
            (0..n).map(|i| want(&format!("Prodotto-{i}-vista.jpg"), &format!("tok{i}"))).collect();
        let m = Manifest::new(Path::new("data"), "p");
        let mut s = FolderScan::default();
        let mut add = |name: String, token: String| {
            m.set(
                &name,
                ManifestEntry { token: token.clone(), size: None, mode: ManifestMode::Link, remote_name: None },
            );
            s.entries.insert(name_key(&name), FolderEntry { name, kind: EntryType::File });
            s.data_tokens.insert(token);
        };
        for i in (0..n).step_by(2) {
            add(format!("Prodotto-{i}-vista.jpg"), format!("tok{i}"));
        }
        for i in 0..5000 {
            add(format!("vecchio-{i}.jpg"), format!("old{i}"));
        }
        let started = std::time::Instant::now();
        let p = plan(&desired, &m, &s);
        assert_eq!(p.downloads.len(), n / 2);
        assert_eq!(p.up_to_date as usize, n / 2);
        assert_eq!(p.remove_names.len(), 5000);
        assert!(started.elapsed().as_secs_f64() < 10.0, "{:?}", started.elapsed());
    }
}
