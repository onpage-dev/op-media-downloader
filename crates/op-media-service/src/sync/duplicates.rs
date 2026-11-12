//! The duplicates tab: a page of the names with different files on On Page,
//! searched by name, with the labels of the things read for that page only.
//!
//! What the tab needs (the groups, the schema for the labels of collections
//! and fields) is kept apart from the listing: in memory with the listing,
//! and on disk in a small file written after each complete listing, so that
//! opening the tab after a restart never rebuilds the names of a whole
//! project (seconds with 200k files) nor asks On Page for the schema. The
//! labels of the things are read once and remembered; On Page answering
//! slowly or not at all only leaves a page without them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use futures::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::names::{DuplicateRaw, DuplicateVariantRaw, FileUse, ResolvedNames, nfc};
use crate::error::{Error, Result};
use crate::fsx::replace_file;
use crate::models::{
    DuplicateGroup, DuplicatePage, DuplicateUse, DuplicateVariant, DuplicateVariants, PageQuery, VariantsQuery,
};
use crate::onpage::{Api, Schema, thing_edit_url, thumbnail_link};

/// Variants shown per name (the chosen one first): generated files (a catalog
/// a day) can share a name by the thousands, and a page of them would weigh
/// megabytes and draw for seconds
const MAX_VARIANTS: usize = 10;
/// Uses shown per variant
const MAX_USES: usize = 20;
/// Things per request, and requests at a time, for the labels
const LABELS_PER_REQUEST: usize = 1000;
const LABEL_REQUESTS: usize = 4;
/// The format of the file on disk; another one is read as missing
const FILE_VERSION: u32 = 1;

/// What the duplicates tab shows of a project
pub struct Duplicates {
    pub schema: Arc<Schema>,
    pub groups: Arc<Vec<DuplicateRaw>>,
    /// Of all the groups: names whose files are one field of one item in different languages
    pub language_variants: u64,
    /// Thing labels read so far; None: the thing has no label
    labels: Mutex<HashMap<i64, Option<String>>>,
}

#[derive(Serialize)]
struct FileOut<'a> {
    version: u32,
    schema: &'a Schema,
    language_variants: u64,
    groups: &'a [DuplicateRaw],
}

#[derive(Deserialize)]
struct FileIn {
    version: u32,
    schema: Schema,
    language_variants: u64,
    groups: Vec<DuplicateRaw>,
}

impl Duplicates {
    pub fn new(schema: Arc<Schema>, resolved: &ResolvedNames) -> Duplicates {
        Duplicates {
            schema,
            groups: resolved.duplicates.clone(),
            language_variants: resolved.language_variants,
            labels: Mutex::new(HashMap::new()),
        }
    }

    /// The file of a complete listing, when there is a readable one
    pub async fn read(file: &Path) -> Option<Duplicates> {
        let raw = tokio::fs::read(file).await.ok()?;
        tokio::task::spawn_blocking(move || {
            let mut text = Vec::new();
            GzDecoder::new(&raw[..]).read_to_end(&mut text).ok()?;
            let json: FileIn = serde_json::from_slice(&text).ok()?;
            (json.version == FILE_VERSION).then(|| Duplicates {
                schema: Arc::new(json.schema),
                groups: Arc::new(json.groups),
                language_variants: json.language_variants,
                labels: Mutex::new(HashMap::new()),
            })
        })
        .await
        .ok()
        .flatten()
    }

    pub async fn write(file: &Path, schema: Arc<Schema>, resolved: &ResolvedNames) -> Result<()> {
        let groups = resolved.duplicates.clone();
        let language_variants = resolved.language_variants;
        let data = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
            let json = FileOut { version: FILE_VERSION, schema: &schema, language_variants, groups: &groups };
            let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
            serde_json::to_writer(&mut encoder, &json)?;
            encoder.flush()?;
            encoder.finish()
        })
        .await
        .map_err(|e| Error::Other(e.to_string()))??;
        replace_file(file, &data).await
    }

    /// The labels of these things that are not known yet, read from On Page
    /// (a few requests at a time); what cannot be read stays unknown
    async fn read_labels(&self, uses: &[&FileUse], api: &Api, log: &(dyn Fn(String) + Send + Sync)) {
        let mut wanted: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
        {
            let known = self.labels.lock();
            for use_ in uses {
                if !known.contains_key(&use_.thing_id) {
                    wanted.entry(use_.resource_id).or_default().insert(use_.thing_id);
                }
            }
        }
        let lang = self.schema.lang().to_string();
        let mut requests = Vec::new();
        for (resource_id, ids) in wanted {
            let Some(resource) = self.schema.resource(resource_id) else { continue };
            let ids: Vec<i64> = ids.into_iter().collect();
            let Some(field) = resource.fields.iter().find(|f| f.is_textual) else {
                // No text field: no label to read
                self.labels.lock().extend(ids.into_iter().map(|id| (id, None)));
                continue;
            };
            for chunk in ids.chunks(LABELS_PER_REQUEST) {
                requests.push((resource, field, chunk.to_vec()));
            }
        }
        let schema = &self.schema;
        let lang = &lang;
        // Built first, then run a few at a time: a stream that builds them would not be Send
        let calls: Vec<_> = requests
            .into_iter()
            .map(|(resource, field, ids)| async move {
                let answer = api.things(schema, resource, &[field.name.as_str()], &ids).await;
                (field, ids, answer)
            })
            .collect();
        let answers: Vec<_> = futures::stream::iter(calls).buffer_unordered(LABEL_REQUESTS).collect().await;
        let mut known = self.labels.lock();
        for (field, ids, answer) in answers {
            let things = match answer {
                Ok(things) => things,
                Err(error) => {
                    log(format!("Labels not read: {}", error.detail()));
                    continue;
                }
            };
            for id in &ids {
                known.insert(*id, None);
            }
            for thing in things {
                let Some(id) = thing.get("id").and_then(Value::as_i64) else { continue };
                let value = thing["fields"].get(field.identifier(lang)).and_then(|v| v.as_array()?.first().cloned());
                let label = match value {
                    None | Some(Value::Null) => None,
                    Some(Value::String(s)) => Some(s),
                    Some(other) => Some(other.to_string()),
                };
                known.insert(id, label);
            }
        }
    }
}

/// A page of the groups that match the query, with the labels of their things:
/// read from On Page first when `page.labels`, else only those already known
/// (the page draws at once, the labels come with a second call)
pub async fn duplicates_page(
    duplicates: &Duplicates,
    page: &PageQuery,
    api: &Api,
    domain: &str,
    log: &(dyn Fn(String) + Send + Sync),
) -> DuplicatePage {
    let query = page.query.as_deref().map(|q| nfc(q.trim()).to_lowercase()).filter(|q| !q.is_empty());
    let matching: Vec<&DuplicateRaw> = match &query {
        Some(q) => duplicates.groups.iter().filter(|g| g.key.contains(q.as_str())).collect(),
        None => duplicates.groups.iter().collect(),
    };
    let total = matching.len() as u64;
    let groups: Vec<&DuplicateRaw> = matching.into_iter().skip(page.offset).take(page.limit.max(1)).collect();
    let language_variants = duplicates.language_variants;
    let shown: Vec<&[DuplicateVariantRaw]> =
        groups.iter().map(|g| &g.variants[..g.variants.len().min(MAX_VARIANTS)]).collect();
    let (variants, labels_pending) = describe_variants(duplicates, &shown, page.labels, api, domain, log).await;
    DuplicatePage {
        total,
        language_variants,
        labels_pending,
        groups: groups
            .into_iter()
            .zip(variants)
            .map(|(group, variants)| DuplicateGroup {
                name: group.name.clone(),
                more_variants: (group.variants.len() - variants.len()) as u64,
                variants,
            })
            .collect(),
    }
}

/// The next files of one name («show more»); none for a name the listing no longer has
pub async fn duplicate_variants(
    duplicates: &Duplicates,
    query: &VariantsQuery,
    api: &Api,
    domain: &str,
    log: &(dyn Fn(String) + Send + Sync),
) -> DuplicateVariants {
    let Some(group) = duplicates.groups.iter().find(|g| g.name == query.name) else {
        return DuplicateVariants::default();
    };
    let start = query.offset.min(group.variants.len());
    let end = start.saturating_add(query.limit.max(1)).min(group.variants.len());
    let (mut variants, labels_pending) =
        describe_variants(duplicates, &[&group.variants[start..end]], query.labels, api, domain, log).await;
    DuplicateVariants {
        variants: variants.pop().unwrap_or_default(),
        more_variants: (group.variants.len() - end) as u64,
        labels_pending,
    }
}

/// These files (a list per name) as the tab shows them, at most `MAX_USES`
/// uses each; the labels of their things read from On Page first when
/// `read_labels`, and whether some are still to read
async fn describe_variants(
    duplicates: &Duplicates,
    shown: &[&[DuplicateVariantRaw]],
    read_labels: bool,
    api: &Api,
    domain: &str,
    log: &(dyn Fn(String) + Send + Sync),
) -> (Vec<Vec<DuplicateVariant>>, bool) {
    let uses: Vec<&FileUse> =
        shown.iter().flat_map(|variants| variants.iter()).flat_map(|v| v.uses.iter().take(MAX_USES)).collect();
    if read_labels && !uses.is_empty() {
        duplicates.read_labels(&uses, api, log).await;
    }

    let schema = &duplicates.schema;
    let lang = schema.lang();
    // The labels of the collections and fields of the page, each looked up once in the schema
    // (hundreds of fields in a big project; a page has thousands of uses of a few of them)
    let mut resource_labels: HashMap<i64, String> = HashMap::new();
    let mut field_labels: HashMap<i64, String> = HashMap::new();
    for use_ in &uses {
        resource_labels.entry(use_.resource_id).or_insert_with(|| {
            schema
                .resource(use_.resource_id)
                .map(|r| schema.resource_label(r, lang))
                .unwrap_or_else(|| use_.resource_id.to_string())
        });
        field_labels.entry(use_.field_id).or_insert_with(|| {
            schema
                .field(use_.field_id)
                .map(|f| schema.field_label(f, lang))
                .unwrap_or_else(|| use_.field_id.to_string())
        });
    }
    let labels = duplicates.labels.lock();
    // Only without `labels`: after a read, what On Page did not answer stays without
    let labels_pending = !read_labels && uses.iter().any(|use_| !labels.contains_key(&use_.thing_id));
    let describe_use = |use_: &FileUse| DuplicateUse {
        resource_label: resource_labels[&use_.resource_id].clone(),
        field_label: field_labels[&use_.field_id].clone(),
        thing_id: use_.thing_id,
        thing_label: labels.get(&use_.thing_id).cloned().flatten(),
        lang: use_.lang.clone(),
        edit_url: thing_edit_url(schema.id, use_.resource_id, use_.thing_id, use_.field_id),
    };
    let described = shown
        .iter()
        .map(|variants| {
            variants
                .iter()
                .map(|variant| DuplicateVariant {
                    token: variant.token.clone(),
                    size: variant.size,
                    width: variant.width,
                    height: variant.height,
                    thumb_url: thumbnail_link(domain, &variant.token, &variant.remote_name),
                    chosen: variant.chosen,
                    uses: variant.uses.iter().take(MAX_USES).map(describe_use).collect(),
                })
                .collect()
        })
        .collect();
    (described, labels_pending)
}
