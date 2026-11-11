//! What the last listing of each project found. In memory, the listing and
//! its names (100+ MB with 200k files) for `max_age` only: «Scarica» reuses
//! them meanwhile, then they are dropped. On disk
//! (`<cache_dir>/<project>.json.gz`), the index for incremental listings and
//! for the duplicates tab after a restart. One copy of the names per project:
//! names read from the disk while a listing runs are not kept, the listing
//! brings new ones.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::listing::ListingResult;
use super::names::{ResolvedNames, resolve_names};
use super::remote_index::{RemoteIndex, read_index_cache, write_index_cache};
use crate::error::Result;
use crate::fsx::unlink_quiet;
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
    /// Loaded for the labels of the duplicates tab, when there is no listing
    schema: Option<Arc<Schema>>,
    at: Instant,
    generation: u64,
}

pub struct ListingStore {
    kept: Arc<Mutex<HashMap<ProjectId, Kept>>>,
    listing: Mutex<HashSet<ProjectId>>,
    cache_dir: PathBuf,
    max_age: Duration,
    generation: Mutex<u64>,
}

impl ListingStore {
    pub fn new(cache_dir: PathBuf, max_age: Duration) -> ListingStore {
        ListingStore {
            kept: Arc::new(Mutex::new(HashMap::new())),
            listing: Mutex::new(HashSet::new()),
            cache_dir,
            max_age,
            generation: Mutex::new(0),
        }
    }

    pub fn cache_file(&self, id: &str) -> PathBuf {
        let safe: String =
            id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        self.cache_dir.join(format!("{safe}.json.gz"))
    }

    pub async fn read_cache(&self, id: &str) -> Option<RemoteIndex> {
        read_index_cache(&self.cache_file(id)).await
    }

    pub async fn write_cache(&self, id: &str, index: &RemoteIndex) -> Result<()> {
        write_index_cache(&self.cache_file(id), index).await
    }

    pub async fn remove_cache(&self, id: &str) {
        let _ = unlink_quiet(&self.cache_file(id)).await;
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

    pub fn keep(&self, id: &str, token: &str, listing: ListingResult, resolved: ResolvedNames) -> Listed {
        let listing = Arc::new(listing);
        let resolved = Arc::new(resolved);
        let at = self.put(id, token, Some(listing.clone()), Some(resolved.clone()));
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
            self.put(id, token, None, Some(resolved.clone()));
        }
        Some(resolved)
    }

    /// The schema of the last listing, or loaded once for the names kept
    pub async fn schema<F, Fut>(&self, id: &str, token: &str, load: F) -> Result<Arc<Schema>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Schema>>,
    {
        {
            let kept = self.kept.lock();
            if let Some(kept) = kept.get(id).filter(|k| k.token == token) {
                if let Some(listing) = &kept.listing {
                    return Ok(Arc::new(listing.schema.clone()));
                }
                if let Some(schema) = &kept.schema {
                    return Ok(schema.clone());
                }
            }
        }
        let schema = Arc::new(load().await?);
        let mut kept = self.kept.lock();
        if let Some(now_kept) = kept.get_mut(id).filter(|k| k.token == token && k.listing.is_none()) {
            now_kept.schema = Some(schema.clone());
        }
        Ok(schema)
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
    ) -> Instant {
        let generation = {
            let mut generation = self.generation.lock();
            *generation += 1;
            *generation
        };
        let at = Instant::now();
        self.kept
            .lock()
            .insert(id.to_string(), Kept { token: token.to_string(), listing, resolved, schema: None, at, generation });
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
