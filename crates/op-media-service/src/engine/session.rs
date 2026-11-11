//! A job's hold on its project folder: the checks before the first write,
//! the lock, the manifest, the scan and the plan, the guard that stops every
//! write once the lock is lost, the final save of the manifest and the release.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::slot::Job;
use crate::error::{Error, JobError, Result};
use crate::folder::data_dir::{DataDirOwner, data_dir_owner};
use crate::folder::inspect::{is_inside, is_protected_path, normalize, path_text, root_of};
use crate::folder::lock::{FolderLock, LockOptions};
use crate::folder::manifest::{DATA_DIR, Manifest, ManifestSource};
use crate::folder::scan::scan_folder;
use crate::fsx::{free_space, path_exists, reachable, unlink_quiet};
use crate::http::sleep;
use crate::models::{IssueCode, ListingMode, LogLevel, OnPageProject, ProjectFolder};
use crate::sync::names::DesiredFile;
use crate::sync::plan::{AdoptionStat, Plan, PlanInput, adoption_candidates, build_plan};
use crate::sync::queue::run_queue;

pub struct SessionOptions<'a> {
    /// The folders of all projects: none may be inside another
    pub project_folders: Vec<ProjectFolder>,
    pub instance_id: String,
    pub reach_timeout: Duration,
    pub lock_stale: Duration,
    pub lock_heartbeat: Duration,
    pub log: &'a (dyn Fn(LogLevel, String) + Send + Sync),
}

/// File system calls at a time for stats and leftovers: a share answers each one slowly
const FS_LANES: usize = 8;

fn lock_lost() -> JobError {
    JobError::new(IssueCode::FolderLocked, "Another computer took over the folder")
}

pub struct FolderSession {
    pub folder: PathBuf,
    pub data_dir: PathBuf,
    pub manifest: Arc<Manifest>,
    lock: FolderLock,
    watcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub struct PlanRequest<'a> {
    pub desired: &'a [DesiredFile],
    pub keep_old_files: bool,
    pub listing_complete: bool,
    pub listing: ListingMode,
    pub confirmed: Option<&'a HashSet<String>>,
    pub duplicates: u64,
}

impl FolderSession {
    /// Folder checks, the lock and the manifest. A lock lost later fails the
    /// job at once: the transfers in flight stop, nothing more is written.
    pub async fn open(job: &Arc<Job>, options: SessionOptions<'_>) -> Result<FolderSession> {
        let project = &job.project;
        let folder = normalize(&project.folder);
        if is_protected_path(&folder) {
            return Err(JobError::with_detail(
                IssueCode::FolderProtected,
                "This folder cannot be used",
                path_text(&folder),
            )
            .into());
        }
        if let Some(other) = options.project_folders.iter().find(|f| {
            f.id != project.id && (is_inside(&folder, Path::new(&f.folder)) || is_inside(Path::new(&f.folder), &folder))
        }) {
            return Err(JobError::with_detail(
                IssueCode::FolderProtected,
                "The folder is used by another project",
                other.id.clone(),
            )
            .into());
        }
        let root = root_of(&folder);
        if !reachable(&root, options.reach_timeout, Some(job.signal())).await? {
            return Err(JobError::with_detail(
                IssueCode::FolderUnreachable,
                "The folder cannot be reached",
                path_text(&root),
            )
            .into());
        }
        job.check()?;
        let data_dir = folder.join(DATA_DIR);
        if data_dir_owner(&data_dir).await.map_err(Error::into_job_error)? == DataDirOwner::Foreign {
            return Err(JobError::with_detail(
                IssueCode::FolderProtected,
                "The folder already has a \"data\" folder that the app did not create",
                path_text(&data_dir),
            )
            .into());
        }
        if let Err(error) = tokio::fs::create_dir_all(&data_dir).await {
            let parent = folder.parent().map(Path::to_path_buf).unwrap_or_else(|| folder.clone());
            let issue = if !path_exists(&folder).await && !path_exists(&parent).await {
                JobError::with_detail(IssueCode::FolderUnreachable, "The folder cannot be reached", error.to_string())
            } else {
                JobError::with_detail(IssueCode::FolderNotWritable, "The folder cannot be written", error.to_string())
            };
            return Err(issue.into());
        }
        let lock = FolderLock::acquire(
            &data_dir,
            LockOptions {
                stale: options.lock_stale,
                heartbeat: options.lock_heartbeat,
                cancel: Some(job.signal().clone()),
                ..LockOptions::new(&options.instance_id, &project.id)
            },
        )
        .await
        .map_err(Error::into_job_error)?;
        let opened: Result<Manifest> = async {
            job.check()?;
            let loaded = Manifest::load(&data_dir, &project.id).await.map_err(Error::into_job_error)?;
            if loaded.source == ManifestSource::LinkJson {
                (options.log)(LogLevel::Info, "Imported data/link.json from 1.x".into());
            }
            if loaded.recovered {
                (options.log)(LogLevel::Warn, "data/manifest.json was unreadable: rebuilt".into());
            }
            Ok(loaded.manifest)
        }
        .await;
        let manifest = match opened {
            Ok(manifest) => manifest,
            Err(error) => {
                lock.release().await;
                return Err(error);
            }
        };
        // A lock lost later fails the job: the transfers in flight stop
        let lost = lock.lost_token();
        let watched = Arc::downgrade(job);
        let watcher = tokio::spawn(async move {
            lost.cancelled().await;
            if let Some(job) = watched.upgrade() {
                job.fail(lock_lost());
            }
        });
        Ok(FolderSession { folder, data_dir, manifest: Arc::new(manifest), lock, watcher: Mutex::new(Some(watcher)) })
    }

    /// Fails once the folder is not the job's to write: another computer took it
    pub fn guard(&self) -> Result<()> {
        if self.lock.lost() { Err(Error::Job(lock_lost())) } else { Ok(()) }
    }

    /// The folder is one On Page project's: the first job names it in the
    /// registry. A job of another project stops before touching anything,
    /// unless the user chose the folder for this token (a new project, another
    /// token or folder): then the folder becomes this project's.
    pub fn bind(&self, project: &OnPageProject, take_over: bool) -> Result<()> {
        if let Some(bound) = self.manifest.onpage_project()
            && bound.id != project.id
            && !take_over
        {
            return Err(JobError::with_detail(
                IssueCode::FolderOtherProject,
                "The folder is synced with another On Page project",
                bound.label,
            )
            .into());
        }
        self.manifest.bind(project);
        Ok(())
    }

    /// Scan, adoption checks, plan
    pub async fn plan(&self, request: PlanRequest<'_>, job: &Job) -> Result<Plan> {
        let scan = scan_folder(&self.folder).await.map_err(Error::into_job_error)?;
        // Leftovers of interrupted runs: ours by name
        let leftovers: Vec<PathBuf> = scan
            .data_leftovers
            .iter()
            .map(|n| self.data_dir.join(n))
            .chain(scan.folder_leftovers.iter().map(|n| self.folder.join(n)))
            .collect();
        run_queue(&leftovers, FS_LANES, None, |file, _| async move {
            let _ = unlink_quiet(file).await;
            Ok(())
        })
        .await?;
        let candidates = adoption_candidates(request.desired, &self.manifest, &scan);
        let adoption: Mutex<HashMap<String, AdoptionStat>> = Mutex::new(HashMap::new());
        run_queue(&candidates, FS_LANES, Some(job.signal()), |candidate, _| {
            let (adoption, scan) = (&adoption, &scan);
            async move {
                let name = self.folder.join(&candidate.name);
                let mut stat = AdoptionStat::default();
                if let Ok(meta) = tokio::fs::metadata(&name).await {
                    stat.name_size = Some(meta.len());
                }
                if stat.name_size.is_some() && scan.data_tokens.contains(&candidate.token) {
                    let blob = self.data_dir.join(&candidate.token);
                    stat.same_file =
                        tokio::task::spawn_blocking(move || same_file::is_same_file(name, blob).unwrap_or(false))
                            .await
                            .unwrap_or(false);
                }
                adoption.lock().insert(candidate.key.clone(), stat);
                Ok(())
            }
        })
        .await?;
        if job.signal().is_cancelled() {
            job.check()?;
            return Err(Error::Aborted);
        }
        let adoption = adoption.into_inner();
        Ok(build_plan(PlanInput {
            desired: request.desired,
            manifest: &self.manifest,
            scan: &scan,
            keep_old_files: request.keep_old_files,
            listing_complete: request.listing_complete,
            listing: request.listing,
            confirmed: request.confirmed,
            duplicates: request.duplicates,
            adoption: Some(&adoption),
        }))
    }

    /// Before downloading: the contents, and the copies where the folder
    /// copies, must fit. A clear «disk full» now beats a disk filled to the
    /// last byte; a file system that does not tell its free space is not checked.
    pub async fn check_room(&self, plan: &Plan, copies: bool) -> Result<()> {
        let contents: u64 = plan.downloads.iter().map(|t| t.size.unwrap_or(0)).sum();
        if contents == 0 {
            return Ok(());
        }
        let copied: u64 = if copies {
            plan.downloads.iter().map(|t| t.size.unwrap_or(0) * t.names.len() as u64).sum::<u64>()
                + plan.links.iter().map(|l| l.target.size.unwrap_or(0)).sum::<u64>()
        } else {
            0
        };
        let needed = contents + copied;
        if let Some(free) = free_space(&self.folder).await
            && free > 0
            && free < needed
        {
            return Err(JobError::with_detail(
                IssueCode::DiskFull,
                "Not enough free space",
                format!("{needed} bytes needed, {free} free"),
            )
            .into());
        }
        Ok(())
    }

    /// The final save of the manifest, retried: a busy share or an antivirus
    /// can refuse it for a moment. Never once the lock is lost: the registry
    /// is the new owner's. The error, when it could not be saved.
    pub async fn save(&self) -> Option<Error> {
        let mut attempt = 1;
        loop {
            if self.guard().is_err() {
                return None;
            }
            match self.manifest.flush().await {
                Ok(()) => return None,
                Err(error) if attempt >= 3 => return Some(error),
                Err(_) => {
                    let _ = sleep(Duration::from_millis(500 * attempt), None).await;
                    attempt += 1;
                }
            }
        }
    }

    /// Frees the folder: the lock goes, and data/ too when a first job left it empty
    pub async fn close(&self) {
        if let Some(watcher) = self.watcher.lock().take() {
            watcher.abort();
        }
        self.lock.release().await;
        let _ = tokio::fs::remove_dir(&self.data_dir).await;
    }
}
