//! Reading the file list from On Page.
//!
//! Phase 1, for every resource with media fields: the ids of the things with
//! at least one file (cheap). With a valid cache the listing is incremental:
//! only things that are new, or whose `_updated_at` is after the last complete
//! listing (minus a margin), are read again; things that disappeared from the
//! ids (deleted, or out of the token's View) are dropped.
//! Phase 2: the things to read, in pages of 1,000, 2 pages at a time, only the
//! media fields. Transport retries (network, 5xx, 429) live in the API client.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use super::queue::run_queue;
use super::remote_index::{RemoteFile, RemoteIndex, RemoteResource};
use crate::error::{Error, JobError, Result};
use crate::models::{IssueCode, ListingMode, ListingProgress, LogLevel, iso_ms, parse_iso_ms};
use crate::onpage::{Api, OnPageContext, Schema, not_empty_filter, schema_error, thing_files, updated_since_filter};

pub const PAGE_SIZE: usize = 1000;
pub const PARALLEL_PAGES: usize = 2;
pub const MAX_CACHE_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
pub const MARGIN: Duration = Duration::from_secs(10 * 60);

pub struct ListingOptions<'a> {
    pub token: &'a str,
    pub ctx: OnPageContext,
    pub cache: Option<RemoteIndex>,
    pub full: bool,
    pub page_size: usize,
    pub parallel: usize,
    pub max_cache_age: Duration,
    pub margin: Duration,
    pub cancel: Option<CancellationToken>,
    pub on_progress: &'a (dyn Fn(ListingProgress) + Send + Sync),
    pub log: &'a (dyn Fn(LogLevel, String) + Send + Sync),
}

#[derive(Debug, Clone)]
pub struct FailedResource {
    pub id: i64,
    pub label: String,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct ListingResult {
    pub schema: Schema,
    pub index: RemoteIndex,
    /// Every resource was read: removals are allowed
    pub complete: bool,
    pub mode: ListingMode,
    pub failed_resources: Vec<FailedResource>,
}

/// The collections not read, for the detail of `listing_incomplete`: three names, then +N
pub fn failed_labels(failed: &[FailedResource]) -> String {
    let labels: Vec<&str> = failed.iter().map(|f| f.label.as_str()).collect();
    if labels.len() > 3 { format!("{} +{}", labels[..3].join(", "), labels.len() - 3) } else { labels.join(", ") }
}

/// On Page compares dates as text: UTC, `YYYY-MM-DD HH:mm:ss`
pub fn format_server_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// Errors that stop the whole listing instead of one resource: stop, token refused, no network
fn is_fatal(error: &Error) -> bool {
    match error {
        Error::Aborted | Error::Job(_) => true,
        Error::Http { status, .. } => *status == 401 || *status == 403,
        Error::Timeout(_) => false,
        _ => error.is_network(),
    }
}

fn fatal(error: Error) -> Error {
    match error {
        Error::Aborted | Error::Job(_) => error,
        other => Error::Job(schema_error(&other)),
    }
}

fn describe(error: &Error) -> String {
    match error {
        Error::Http { status, .. } => format!("HTTP {status}"),
        other => other.to_string(),
    }
}

struct ResourceWork {
    resource_index: usize,
    label: String,
    things: BTreeMap<i64, Vec<RemoteFile>>,
    to_read: Vec<i64>,
    pages_left: usize,
    failed: Option<String>,
}

struct Page {
    work: usize,
    ids: Vec<i64>,
}

pub async fn list_remote(options: ListingOptions<'_>) -> Result<ListingResult> {
    let server_now: Arc<Mutex<Option<i64>>> = Arc::new(Mutex::new(None));
    let mut ctx = options.ctx.clone();
    ctx.cancel = options.cancel.clone().or(ctx.cancel);
    let previous = ctx.on_server_date.clone();
    let first = server_now.clone();
    ctx.on_server_date = Some(Arc::new(move |date| {
        first.lock().get_or_insert(date);
        if let Some(hook) = &previous {
            hook(date)
        }
    }));
    let cancelled = || options.cancel.as_ref().is_some_and(|c| c.is_cancelled());

    let mut api = Api::new(options.token, ctx);
    let schema = api.load_schema().await?;
    let now = chrono::Utc::now().timestamp_millis();
    // Changes made while we read are caught by the next listing
    let started_at = server_now.lock().unwrap_or(now);
    let signature = schema.signature(options.token);
    let cache = options.cache.as_ref();
    let checkpoint = cache.and_then(|c| parse_iso_ms(&c.checkpoint));
    let incremental = !options.full
        && cache.is_some_and(|c| c.signature == signature && c.schema_id == schema.id)
        && checkpoint.is_some_and(|at| now - at < options.max_cache_age.as_millis() as i64);
    let since = checkpoint.filter(|_| incremental).map(|at| format_server_date(at - options.margin.as_millis() as i64));

    let media = schema.media_resources();
    let progress = Mutex::new(ListingProgress {
        resources_total: media.len() as u64,
        ..ListingProgress::default()
    });
    let report = || (options.on_progress)(progress.lock().clone());
    let lang = schema.lang().to_string();
    let mut work: Vec<ResourceWork> = Vec::new();

    // Phase 1: which things to read
    for (resource_index, item) in media.iter().enumerate() {
        if cancelled() {
            return Err(Error::Aborted);
        }
        let label = schema.resource_label(item.resource, &lang);
        progress.lock().resource_label = Some(label.clone());
        report();
        let mut entry =
            ResourceWork { resource_index, label: label.clone(), things: BTreeMap::new(), to_read: Vec::new(), pages_left: 0, failed: None };
        let filter = not_empty_filter(&item.fields);
        let found: Result<()> = async {
            let ids = api.ids(&schema, item.resource, vec![filter.clone()]).await?;
            let cached = if incremental { cache.and_then(|c| c.resources.iter().find(|r| r.id == item.resource.id)) } else { None };
            match (cached, &since) {
                (Some(cached), Some(since)) => {
                    let current: HashSet<i64> = ids.iter().copied().collect();
                    for (id, files) in &cached.things {
                        if current.contains(id) {
                            entry.things.insert(*id, files.clone());
                        }
                    }
                    let updated: HashSet<i64> = api
                        .ids(&schema, item.resource, vec![filter.clone(), updated_since_filter(since)])
                        .await?
                        .into_iter()
                        .collect();
                    entry.to_read = ids.into_iter().filter(|id| !cached.things.contains_key(id) || updated.contains(id)).collect();
                }
                _ => entry.to_read = ids,
            }
            Ok(())
        }
        .await;
        if let Err(error) = found {
            if is_fatal(&error) {
                return Err(fatal(error));
            }
            let text = describe(&error);
            (options.log)(LogLevel::Warn, format!("Listing of {label} failed: {text}"));
            entry.failed = Some(text);
        }
        work.push(entry);
    }
    progress.lock().things_total = Some(work.iter().map(|w| w.to_read.len() as u64).sum());
    report();

    // Phase 2: read the things, page by page
    let mut pages: Vec<Page> = Vec::new();
    for (index, entry) in work.iter_mut().enumerate() {
        if entry.failed.is_some() {
            continue;
        }
        for chunk in entry.to_read.chunks(options.page_size.max(1)) {
            pages.push(Page { work: index, ids: chunk.to_vec() });
            entry.pages_left += 1;
        }
        if entry.pages_left == 0 {
            progress.lock().resources_done += 1;
        }
    }
    report();

    let work: Vec<Mutex<ResourceWork>> = work.into_iter().map(Mutex::new).collect();
    let (api, schema_ref, media_ref, work_ref) = (&api, &schema, &media, &work);
    run_queue(&pages, options.parallel, options.cancel.as_ref(), |page, _| {
        let (progress, report) = (&progress, &report);
        async move {
            let (resource_index, label, failed) = {
                let entry = work_ref[page.work].lock();
                (entry.resource_index, entry.label.clone(), entry.failed.is_some())
            };
            if failed {
                return Ok(());
            }
            let item = &media_ref[resource_index];
            let names: Vec<&str> = item.fields.iter().map(|f| f.name.as_str()).collect();
            match api.things(schema_ref, item.resource, &names, &page.ids).await {
                Ok(things) => {
                    let mut entry = work_ref[page.work].lock();
                    let mut seen = HashSet::new();
                    for thing in &things {
                        let Some(id) = thing.get("id").and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok())) else { continue };
                        seen.insert(id);
                        let files = thing_files(thing, &item.fields, &schema_ref.langs);
                        if files.is_empty() {
                            entry.things.remove(&id);
                        } else {
                            entry.things.insert(id, files);
                        }
                    }
                    // Asked for but not returned: gone in the meantime
                    for id in &page.ids {
                        if !seen.contains(id) {
                            entry.things.remove(id);
                        }
                    }
                    progress.lock().things_read += page.ids.len() as u64;
                }
                Err(error) => {
                    if is_fatal(&error) {
                        return Err(fatal(error));
                    }
                    let text = describe(&error);
                    (options.log)(LogLevel::Warn, format!("Listing of {label} failed: {text}"));
                    work_ref[page.work].lock().failed = Some(text);
                }
            }
            let done = {
                let mut entry = work_ref[page.work].lock();
                entry.pages_left = entry.pages_left.saturating_sub(1);
                entry.pages_left == 0
            };
            {
                let mut p = progress.lock();
                if done {
                    p.resources_done += 1;
                }
                p.resource_label = Some(label);
            }
            report();
            Ok(())
        }
    })
    .await?;
    if cancelled() {
        return Err(Error::Aborted);
    }

    let work: Vec<ResourceWork> = work.into_iter().map(Mutex::into_inner).collect();
    let failed_resources: Vec<FailedResource> = work
        .iter()
        .filter_map(|w| {
            w.failed.as_ref().map(|error| FailedResource {
                id: media[w.resource_index].resource.id,
                label: w.label.clone(),
                error: error.clone(),
            })
        })
        .collect();
    if !media.is_empty() && failed_resources.len() == media.len() {
        return Err(Error::Job(JobError::with_detail(
            IssueCode::ListingFailed,
            "The file list could not be read",
            failed_resources[0].error.clone(),
        )));
    }

    // A resource that failed keeps what the cache knew (no removals anyway)
    let resources: Vec<RemoteResource> = work
        .into_iter()
        .map(|w| {
            let id = media[w.resource_index].resource.id;
            if w.failed.is_none() {
                return RemoteResource { id, things: w.things };
            }
            let cached = cache.and_then(|c| c.resources.iter().find(|r| r.id == id));
            RemoteResource { id, things: cached.map(|c| c.things.clone()).unwrap_or_default() }
        })
        .collect();
    let complete = failed_resources.is_empty();
    let schema_id = schema.id;
    Ok(ListingResult {
        index: RemoteIndex { schema_id, signature, checkpoint: iso_ms(started_at), resources },
        schema,
        complete,
        mode: if incremental { ListingMode::Incremental } else { ListingMode::Full },
        failed_resources,
    })
}
