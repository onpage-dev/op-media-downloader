//! The duplicates tab: a page of the names with different files on On Page,
//! searched by name, with the labels of the things read for that page only.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::Value;

use super::names::{FileUse, ResolvedNames, nfc};
use crate::error::Error;
use crate::models::{DuplicateGroup, DuplicatePage, DuplicateUse, DuplicateVariant, PageQuery};
use crate::onpage::{Api, Schema, thing_edit_url, thumbnail_link};

/// Uses shown per variant
const MAX_USES: usize = 20;

pub async fn duplicates_page(
    resolved: Option<&ResolvedNames>,
    page: &PageQuery,
    load: impl Future<Output = Result<(std::sync::Arc<Schema>, Api), Error>>,
    domain: &str,
    log: impl Fn(String),
) -> Result<DuplicatePage, Error> {
    let Some(resolved) = resolved.filter(|r| !r.duplicates.is_empty()) else {
        return Ok(DuplicatePage::default());
    };
    let query = page.query.as_deref().map(|q| nfc(q.trim()).to_lowercase()).filter(|q| !q.is_empty());
    let matching: Vec<_> = match &query {
        Some(q) => resolved.duplicates.iter().filter(|g| g.key.contains(q.as_str())).collect(),
        None => resolved.duplicates.iter().collect(),
    };
    let total = matching.len() as u64;
    let language_variants = resolved.language_variants;
    let groups: Vec<_> = matching.into_iter().skip(page.offset).take(page.limit.max(1)).collect();
    if groups.is_empty() {
        return Ok(DuplicatePage { total, language_variants, groups: Vec::new() });
    }
    let (schema, api) = load.await?;
    let lang = schema.lang().to_string();

    // Thing labels, read only for the things involved
    let mut by_resource: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
    for group in &groups {
        for variant in &group.variants {
            for use_ in variant.uses.iter().take(MAX_USES) {
                by_resource.entry(use_.resource_id).or_default().insert(use_.thing_id);
            }
        }
    }
    let mut labels: HashMap<i64, String> = HashMap::new();
    for (resource_id, ids) in by_resource {
        let Some(resource) = schema.resource(resource_id) else {
            continue;
        };
        let Some(label_field) = resource.fields.iter().find(|f| f.is_textual) else {
            continue;
        };
        let ids: Vec<i64> = ids.into_iter().collect();
        for chunk in ids.chunks(1000) {
            match api.things(&schema, resource, &[label_field.name.as_str()], chunk).await {
                Ok(things) => {
                    for thing in things {
                        let Some(id) = thing.get("id").and_then(Value::as_i64) else {
                            continue;
                        };
                        let value = thing["fields"]
                            .get(label_field.identifier(&lang))
                            .and_then(|v| v.as_array()?.first().cloned());
                        match value {
                            Some(Value::Null) | None => {}
                            Some(Value::String(s)) => {
                                labels.insert(id, s);
                            }
                            Some(other @ (Value::Object(_) | Value::Array(_))) => {
                                labels.insert(id, other.to_string());
                            }
                            Some(other) => {
                                labels.insert(id, other.to_string());
                            }
                        }
                    }
                }
                Err(error) => log(format!("Labels not read: {}", error.detail())),
            }
        }
    }

    let describe_use = |use_: &FileUse| DuplicateUse {
        resource_label: schema
            .resource(use_.resource_id)
            .map(|r| schema.resource_label(r, &lang))
            .unwrap_or_else(|| use_.resource_id.to_string()),
        field_label: schema
            .field(use_.field_id)
            .map(|f| schema.field_label(f, &lang))
            .unwrap_or_else(|| use_.field_id.to_string()),
        thing_id: use_.thing_id,
        thing_label: labels.get(&use_.thing_id).cloned(),
        lang: use_.lang.clone(),
        edit_url: thing_edit_url(schema.id, use_.resource_id, use_.thing_id, use_.field_id),
    };
    Ok(DuplicatePage {
        total,
        language_variants,
        groups: groups
            .into_iter()
            .map(|group| DuplicateGroup {
                name: group.name.clone(),
                variants: group
                    .variants
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
                    .collect(),
            })
            .collect(),
    })
}
