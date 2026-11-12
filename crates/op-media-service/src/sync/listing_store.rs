//! What the last listing of each project found. In memory, the listing and
//! its names (100+ MB with 200k files) for `max_age` only: «Scarica» reuses
//! them meanwhile, then they are dropped. On disk
//! (`<cache_dir>/<project>.json.gz`), the index for incremental listings,
//! and beside it (`<project>.duplicates.json.gz`) what the duplicates tab
//! needs, small, to open at once after a restart. One copy of the names per
//! project: names read from the disk while a listing runs are not kept, the
//! listing brings new ones.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::duplicates::Duplicates;
use super::listing::ListingResult;
use super::names::{ResolvedNames, resolve_names};
use super::remote_index::{RemoteIndex, read_index_cache, write_index_cache};
use crate::error::Result;
use crate::fsx::{path_exists, unlink_quiet};
use crate::models::ProjectId;
use crate::onpage::Schema;

#[derive(Clone)]
pub struct Listed {
    pub token: String,
    pub listing: Arc<ListingResult>,
    pub resolved: Arc<ResolvedNames>,
    pub at: Instant,
}

struct Kept {
    token: String,
    /// Missing for names resolved from the cache on disk
    listing: Option<Arc<ListingResult>>,
    resolved: Option<Arc<ResolvedNames>>,
    /// The duplicates tab's, with the thing labels it read
    duplicates: Option<Arc<Duplicates>>,
    at: Instant,
    generation: u64,
}

pub struct ListingStore {
    kept: Arc<Mutex<HashMap<ProjectId, Kept>>>,
    /// One per project: the caches on disk are written in the background, and
    /// read or removed only once the write in flight is done
    files: Mutex<HashMap<ProjectId, Arc<tokio::sync::Mutex<()>>>>,
    listing: Mutex<HashSet<ProjectId>>,
    cache_dir: PathBuf,
    max_age: Duration,
    generation: Mutex<u64>,
}

impl ListingStore {
    pub fn new(cache_dir: PathBuf, max_age: Duration) -> ListingStore {
        ListingStore {
            kept: Arc::new(Mutex::new(HashMap::new())),
            files: Mutex::new(HashMap::new()),
            listing: Mutex::new(HashSet::new()),
            cache_dir,
            max_age,
            generation: Mutex::new(0),
        }
    }

    fn file(&self, id: &str, suffix: &str) -> PathBuf {
        let safe: String =
            id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        self.cache_dir.join(format!("{safe}{suffix}"))
    }

    pub fn cache_file(&self, id: &str) -> PathBuf {
        self.file(id, ".json.gz")
    }

    pub fn duplicates_file(&self, id: &str) -> PathBuf {
        self.file(id, ".duplicates.json.gz")
    }

    fn files_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.files.lock().entry(id.to_string()).or_default().clone()
    }

    /// Temporary files of caches whose write an exit cut: they go at start-up
    pub fn clear_leftovers(&self) {
        let Ok(entries) = std::fs::read_dir(&self.cache_dir) else { return };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".tmp") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    pub async fn read_cache(&self, id: &str) -> Option<RemoteIndex> {
        let lock = self.files_lock(id);
        let _writes_done = lock.lock().await;
        read_index_cache(&self.cache_file(id)).await
    }

    /// After a complete listing: the index (always, its checkpoint moves on)
    /// and what the duplicates tab needs (when the listing changed, or its file
    /// is missing). Written in the background: the job goes on at once;
    /// whoever reads the caches next waits for the write
    pub async fn save_in_background(
        &self,
        id: &str,
        index: Arc<RemoteIndex>,
        duplicates: (Arc<Schema>, Arc<ResolvedNames>),
        changed: bool,
        failed: impl Fn(String) + Send + 'static,
    ) {
        let writing = self.files_lock(id).lock_owned().await;
        let (cache_file, duplicates_file) = (self.cache_file(id), self.duplicates_file(id));
        tokio::spawn(async move {
            let _writing = writing;
            if let Err(error) = write_index_cache(&cache_file, index).await {
                failed(format!("Listing cache not written: {}", error.detail()));
            }
            let (schema, resolved) = duplicates;
            if (changed || !path_exists(&duplicates_file).await)
                && let Err(error) = Duplicates::write(&duplicates_file, schema, &resolved).await
            {
                failed(format!("Duplicates cache not written: {}", error.detail()));
            }
        });
    }

    /// Until the caches being written for this project are on the disk
    pub async fn writes_done(&self, id: &str) {
        let lock = self.files_lock(id);
        let _done = lock.lock().await;
    }

    pub async fn remove_cache(&self, id: &str) {
        let lock = self.files_lock(id);
        let _writes_done = lock.lock().await;
        let _ = unlink_quiet(&self.cache_file(id)).await;
        let _ = unlink_quiet(&self.duplicates_file(id)).await;
    }

    /// A complete listing of this token, younger than max_age
    pub fn fresh(&self, id: &str, token: &str) -> Option<Listed> {
        let kept = self.kept.lock();
        let kept = kept.get(id)?;
        let (listing, resolved) = (kept.listing.clone()?, kept.resolved.clone()?);
        if kept.token != token || !listing.complete || kept.at.elapsed() >= self.max_age {
            return None;
        }
        Some(Listed { token: token.to_string(), listing, resolved, at: kept.at })
    }

    /// A listing starts: what it replaces goes now, not when it ends
    pub fn begin(&self, id: &str) {
        self.kept.lock().remove(id);
        self.listing.lock().insert(id.to_string());
    }

    /// The listing ended, done or not
    pub fn end(&self, id: &str) {
        self.listing.lock().remove(id);
    }

    /// The names of the last listing of this token still in memory, whatever its age
    pub fn kept_names(&self, id: &str, token: &str) -> Option<Arc<ResolvedNames>> {
        self.kept.lock().get(id).filter(|k| k.token == token).and_then(|k| k.resolved.clone())
    }

    pub fn keep(&self, id: &str, token: &str, listing: ListingResult, resolved: Arc<ResolvedNames>) -> Listed {
        let listing = Arc::new(listing);
        let at = self.put(id, token, Some(listing.clone()), Some(resolved.clone()), None);
        Listed { token: token.to_string(), listing, resolved, at }
    }

    /// The names of the last listing of this token, or of the cache on disk:
    /// resolved once (seconds with 100k+ files) and kept for max_age
    pub async fn resolved(&self, id: &str, token: &str) -> Option<Arc<ResolvedNames>> {
        {
            let kept = self.kept.lock();
            if let Some(kept) = kept.get(id).filter(|k| k.token == token && k.at.elapsed() < self.max_age)
                && let Some(resolved) = &kept.resolved
            {
                return Some(resolved.clone());
            }
        }
        let cache = self.read_cache(id).await?;
        let resolved = Arc::new(tokio::task::spawn_blocking(move || resolve_names(&cache)).await.ok()?);
        if !self.listing.lock().contains(id) {
            self.put(id, token, None, Some(resolved.clone()), None);
        }
        Some(resolved)
    }

    /// What the duplicates tab shows: from the listing in memory, else from
    /// its small file on disk, else (a cache written before that file existed)
    /// from the names of the cache and the schema `load` reads. None: no
    /// listing is known yet
    pub async fn duplicates<F, Fut>(&self, id: &str, token: &str, load: F) -> Result<Option<Arc<Duplicates>>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Schema>>,
    {
        {
            let mut kept = self.kept.lock();
            if let Some(kept) = kept.get_mut(id).filter(|k| k.token == token) {
                if let Some(duplicates) = &kept.duplicates {
                    return Ok(Some(duplicates.clone()));
                }
                if let (Some(listing), Some(resolved)) = (&kept.listing, &kept.resolved) {
                    let duplicates = Arc::new(Duplicates::new(Arc::new(listing.schema.clone()), resolved));
                    kept.duplicates = Some(duplicates.clone());
                    return Ok(Some(duplicates));
                }
            }
        }
        let from_file = {
            let lock = self.files_lock(id);
            let _writes_done = lock.lock().await;
            Duplicates::read(&self.duplicates_file(id)).await
        };
        let duplicates = match from_file {
            Some(duplicates) => Arc::new(duplicates),
            None => {
                let Some(resolved) = self.resolved(id, token).await else { return Ok(None) };
                let schema = Arc::new(load().await?);
                // Its own file from now on: the next start opens the tab at once
                let writing = self.files_lock(id).lock_owned().await;
                let (file, written_schema, written) = (self.duplicates_file(id), schema.clone(), resolved.clone());
                tokio::spawn(async move {
                    let _writing = writing;
                    let _ = Duplicates::write(&file, written_schema, &written).await;
                });
                Arc::new(Duplicates::new(schema, &resolved))
            }
        };
        if !self.listing.lock().contains(id) {
            let mut kept = self.kept.lock();
            match kept.get_mut(id).filter(|k| k.token == token) {
                Some(entry) => entry.duplicates = Some(duplicates.clone()),
                None => {
                    drop(kept);
                    self.put(id, token, None, None, Some(duplicates.clone()));
                }
            }
        }
        Ok(Some(duplicates))
    }

    pub fn forget(&self, id: &str) {
        self.kept.lock().remove(id);
    }

    fn put(
        &self,
        id: &str,
        token: &str,
        listing: Option<Arc<ListingResult>>,
        resolved: Option<Arc<ResolvedNames>>,
        duplicates: Option<Arc<Duplicates>>,
    ) -> Instant {
        let generation = {
            let mut generation = self.generation.lock();
            *generation += 1;
            *generation
        };
        let at = Instant::now();
        self.kept
            .lock()
            .insert(id.to_string(), Kept { token: token.to_string(), listing, resolved, duplicates, at, generation });
        // Dropped after max_age, unless something newer replaced it
        let kept = Arc::downgrade(&self.kept);
        let id = id.to_string();
        let max_age = self.max_age;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                tokio::time::sleep(max_age).await;
                if let Some(kept) = kept.upgrade() {
                    let mut kept = kept.lock();
                    if kept.get(&id).is_some_and(|k| k.generation == generation) {
                        kept.remove(&id);
                    }
                }
            });
        }
        at
    }
}
