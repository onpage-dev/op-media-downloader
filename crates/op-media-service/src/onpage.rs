//! The On Page API through a token, as onpage-js speaks it: every call is a
//! POST to `https://api.onpage.it/view/<token>/<endpoint>` with a JSON body
//! (`_method` names the verb), the token in `Authorization`. Timeouts per
//! attempt, retries on network errors, 5xx and 429 (`Retry-After` honoured).
//! The schema is read as loose JSON: On Page adds fields over time and PHP
//! writes an empty object as `[]`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sha1::Digest;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, JobError, Result, TimeoutStage};
use crate::http::{API_RETRY, RetryPolicy, parse_retry_after, with_retry};
use crate::models::{IssueCode, TokenCheck, TokenError};
use crate::sync::remote_index::RemoteFile;

pub const DEFAULT_DOMAIN: &str = "https://app.onpage.it";

pub type RetryHook = Arc<dyn Fn(&Error, u32, Duration) + Send + Sync>;
pub type ServerDateHook = Arc<dyn Fn(i64) + Send + Sync>;

/// How requests to On Page go out
#[derive(Clone)]
pub struct OnPageContext {
    pub http: reqwest::Client,
    /// `https://app.onpage.it`, or a test server
    pub domain: String,
    pub policy: RetryPolicy,
    /// Per attempt, whole answer
    pub timeout: Duration,
    /// The running job's: a stop aborts the request and its waits
    pub cancel: Option<CancellationToken>,
    pub on_retry: Option<RetryHook>,
    /// Each successful answer's Date header (server clock), in ms
    pub on_server_date: Option<ServerDateHook>,
}

impl OnPageContext {
    pub fn new(http: reqwest::Client, domain: impl Into<String>) -> OnPageContext {
        OnPageContext {
            http,
            domain: domain.into(),
            policy: API_RETRY,
            timeout: Duration::from_secs(120),
            cancel: None,
            on_retry: None,
            on_server_date: None,
        }
    }
}

/// The HTTP client of the service: one connection pool for the API and the storage
pub fn http_client(user_agent: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// `https://app.onpage.it` → `https://<sub>.onpage.it`; a test domain stays itself
fn sub_domain(domain: &str, sub: &str) -> String {
    domain.trim_end_matches('/').replacen("//app.", &format!("//{sub}."), 1)
}

/// JavaScript's encodeURIComponent
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/* ------------------------------------------------------------------ schema */

/// Kept with the duplicates on disk: the labels of their uses without asking On Page again
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Field {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub is_translatable: bool,
    pub is_multiple: bool,
    pub is_textual: bool,
    pub labels: HashMap<String, String>,
}

impl Field {
    pub fn is_media(&self) -> bool {
        self.kind == "file" || self.kind == "image"
    }

    /// The key of the field's values in a thing: `name`, or `name_<lang>` when translatable
    pub fn identifier(&self, lang: &str) -> String {
        if self.is_translatable { format!("{}_{lang}", self.name) } else { self.name.clone() }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Resource {
    pub id: i64,
    pub name: String,
    pub labels: HashMap<String, String>,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Schema {
    pub id: i64,
    pub company_id: Option<i64>,
    pub label: String,
    pub langs: Vec<String>,
    pub default_lang: Option<String>,
    pub resources: Vec<Resource>,
}

fn labels(value: &Value) -> HashMap<String, String> {
    value
        .as_object()
        .map(|map| map.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

fn int(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64)).or_else(|| value.as_str()?.parse().ok())
}

/// A non-negative whole number of an answer (sizes, dimensions)
pub fn count(value: &Value) -> Option<u64> {
    let n = value.as_f64()?;
    (n.is_finite() && n >= 0.0).then_some(n as u64)
}

impl Schema {
    pub fn from_json(json: &Value) -> Result<Schema> {
        let id = int(&json["id"]).ok_or_else(|| Error::Other("The schema has no id".into()))?;
        let resources = json["resources"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|r| {
                        Some(Resource {
                            id: int(&r["id"])?,
                            name: r["name"].as_str()?.to_string(),
                            labels: labels(&r["labels"]),
                            fields: r["fields"]
                                .as_array()
                                .map(|fields| {
                                    fields
                                        .iter()
                                        .filter_map(|f| {
                                            Some(Field {
                                                id: int(&f["id"])?,
                                                name: f["name"].as_str()?.to_string(),
                                                kind: f["type"].as_str().unwrap_or_default().to_string(),
                                                is_translatable: f["is_translatable"].as_bool().unwrap_or(false),
                                                is_multiple: f["is_multiple"].as_bool().unwrap_or(true),
                                                is_textual: f["is_textual"].as_bool().unwrap_or(false),
                                                labels: labels(&f["labels"]),
                                            })
                                        })
                                        .collect()
                                })
                                .unwrap_or_default(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Schema {
            id,
            company_id: int(&json["company_id"]),
            label: json["label"].as_str().unwrap_or_default().to_string(),
            langs: json["langs"]
                .as_array()
                .map(|l| l.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            default_lang: json["default_lang"].as_str().map(str::to_string),
            resources,
        })
    }

    /// The language labels are shown in: the project's default one
    pub fn lang(&self) -> &str {
        self.default_lang.as_deref().or(self.langs.first().map(String::as_str)).unwrap_or("it")
    }

    pub fn resource(&self, id: i64) -> Option<&Resource> {
        self.resources.iter().find(|r| r.id == id)
    }

    pub fn field(&self, id: i64) -> Option<&Field> {
        self.resources.iter().flat_map(|r| &r.fields).find(|f| f.id == id)
    }

    pub fn resource_label(&self, resource: &Resource, lang: &str) -> String {
        self.pick_label(&resource.labels, lang).unwrap_or_else(|| resource.name.clone())
    }

    pub fn field_label(&self, field: &Field, lang: &str) -> String {
        self.pick_label(&field.labels, lang).unwrap_or_else(|| format!("#{}", field.id))
    }

    fn pick_label(&self, labels: &HashMap<String, String>, lang: &str) -> Option<String> {
        [Some(lang), Some(self.lang()), self.default_lang.as_deref()]
            .into_iter()
            .flatten()
            .find_map(|l| labels.get(l).filter(|s| !s.is_empty()).cloned())
    }

    /// Resources with at least one file or image field, in schema order
    pub fn media_resources(&self) -> Vec<MediaResource<'_>> {
        self.resources
            .iter()
            .map(|resource| MediaResource {
                resource,
                fields: resource.fields.iter().filter(|f| f.is_media()).collect(),
            })
            .filter(|r| !r.fields.is_empty())
            .collect()
    }

    /// Changes when what the listing reads changes: media fields, langs, project
    pub fn signature(&self, token: &str) -> String {
        let token_hash = hex::encode(sha2::Sha256::digest(token.as_bytes()));
        let resources: Vec<Value> = self
            .media_resources()
            .iter()
            .map(|m| {
                json!([
                    m.resource.id,
                    m.fields.iter().map(|f| json!([f.id, f.kind, f.is_translatable])).collect::<Vec<_>>()
                ])
            })
            .collect();
        // The keys in this order, as 2.0 wrote them
        let shape = format!(
            "{{\"schema\":{},\"token\":\"{token_hash}\",\"langs\":{},\"resources\":{}}}",
            self.id,
            serde_json::to_string(&self.langs).unwrap_or_default(),
            serde_json::to_string(&resources).unwrap_or_default(),
        );
        hex::encode(sha1::Sha1::digest(shape.as_bytes()))
    }
}

pub struct MediaResource<'a> {
    pub resource: &'a Resource,
    pub fields: Vec<&'a Field>,
}

/// A thing's files in field, lang and value order; no language fallback
pub fn thing_files(thing: &Value, fields: &[&Field], langs: &[String]) -> Vec<RemoteFile> {
    let values = &thing["fields"];
    let mut out = Vec::new();
    for field in fields {
        let field_langs: Vec<Option<&str>> =
            if field.is_translatable { langs.iter().map(|l| Some(l.as_str())).collect() } else { vec![None] };
        for lang in field_langs {
            let key = match lang {
                Some(lang) => field.identifier(lang),
                None => field.name.clone(),
            };
            let Some(files) = values.get(&key).and_then(Value::as_array) else {
                continue;
            };
            let files = if field.is_multiple { &files[..] } else { &files[..files.len().min(1)] };
            for file in files {
                let token = match &file["token"] {
                    Value::String(s) if !s.is_empty() => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => continue,
                };
                let name = match &file["name"] {
                    Value::String(s) => s.clone(),
                    Value::Null => token.clone(),
                    other => other.to_string(),
                };
                out.push(RemoteFile {
                    field_id: field.id,
                    lang: lang.map(str::to_string),
                    name,
                    token,
                    size: count(&file["size"]),
                    width: count(&file["width"]),
                    height: count(&file["height"]),
                });
            }
        }
    }
    out
}

/* ------------------------------------------------------------------ the API */

/// The API of one token
#[derive(Clone)]
pub struct Api {
    ctx: OnPageContext,
    token: String,
    base: String,
    /// x-schema and x-company, once the schema is known
    project: Option<(i64, Option<i64>)>,
}

impl Api {
    pub fn new(token: &str, ctx: OnPageContext) -> Api {
        let base = format!("{}/view/{}", sub_domain(&ctx.domain, "api"), token);
        Api { ctx, token: token.to_string(), base, project: None }
    }

    /// The API of a project whose schema is known: the calls name the project
    pub fn for_schema(token: &str, ctx: OnPageContext, schema: &Schema) -> Api {
        let mut api = Api::new(token, ctx);
        api.project = Some((schema.id, schema.company_id));
        api
    }

    pub fn context(&self) -> &OnPageContext {
        &self.ctx
    }

    /// One call, retried; the answer as JSON
    pub async fn call(&self, endpoint: &str, mut body: Value, method: &str) -> Result<Value> {
        if method != "post" {
            body["_method"] = Value::String(method.to_string());
        }
        let url = format!("{}/{}", self.base, endpoint);
        let body = serde_json::to_vec(&body).map_err(|e| Error::Other(e.to_string()))?;
        let ctx = &self.ctx;
        let on_retry = |error: &Error, attempt: u32, delay: Duration| {
            if let Some(hook) = &ctx.on_retry {
                hook(error, attempt, delay)
            }
        };
        with_retry(&ctx.policy, ctx.cancel.as_ref(), on_retry, |_| {
            let mut request = ctx
                .http
                .post(&url)
                .header("Authorization", &self.token)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .body(body.clone());
            if let Some((schema, company)) = self.project {
                request = request.header("x-schema", schema.to_string());
                if let Some(company) = company {
                    request = request.header("x-company", company.to_string());
                }
            }
            let attempt = async move {
                let response = request.send().await?;
                let status = response.status();
                let retry_after =
                    parse_retry_after(response.headers().get("retry-after").and_then(|v| v.to_str().ok()));
                let date = response
                    .headers()
                    .get("date")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|d| chrono::DateTime::parse_from_rfc2822(d).ok())
                    .map(|d| d.timestamp_millis());
                let text = response.bytes().await?;
                if !status.is_success() {
                    return Err(Error::Http { status: status.as_u16(), retry_after });
                }
                if let (Some(date), Some(hook)) = (date, &ctx.on_server_date) {
                    hook(date)
                }
                serde_json::from_slice::<Value>(&text).map_err(|e| Error::Other(format!("Unreadable answer: {e}")))
            };
            let timeout = ctx.timeout;
            let cancel = ctx.cancel.clone();
            async move {
                let timed = async {
                    match tokio::time::timeout(timeout, attempt).await {
                        Ok(result) => result,
                        Err(_) => Err(Error::Timeout(TimeoutStage::Request)),
                    }
                };
                match cancel {
                    Some(token) => tokio::select! {
                        result = timed => result,
                        _ = token.cancelled() => Err(Error::Aborted),
                    },
                    None => timed.await,
                }
            }
        })
        .await
    }

    /// The schema of the token's project; the API then names the project in every call. Errors are
    /// the issue the user sees (`Error::Job`), or `Aborted`
    pub async fn load_schema(&mut self) -> Result<Schema> {
        let json = self.call("schema", json!({}), "get").await.map_err(schema_failure)?;
        let schema = Schema::from_json(&json).map_err(schema_failure)?;
        self.project = Some((schema.id, schema.company_id));
        Ok(schema)
    }

    /// The body of a `things` query, as onpage-js builds it
    fn things_body(schema: &Schema, resource: &Resource, filters: Vec<Value>, fields: Vec<Value>, ret: &str) -> Value {
        json!({
            "filters": filters,
            "fields": fields,
            "is_trash": false,
            "options": { "no_labels": true, "hyper_compact": true, "hyper_compact_use_array": true, "use_field_names": true },
            "langs": schema.langs,
            "return": ret,
            "resource": resource.name,
        })
    }

    /// The ids of the things that match the filters
    pub async fn ids(&self, schema: &Schema, resource: &Resource, filters: Vec<Value>) -> Result<Vec<i64>> {
        let body = Self::things_body(schema, resource, filters, vec![json!("+")], "ids");
        let answer = self.call("things", body, "get").await?;
        Ok(answer.as_array().map(|ids| ids.iter().filter_map(int).collect()).unwrap_or_default())
    }

    /// The things with these ids, only the fields named
    pub async fn things(
        &self,
        schema: &Schema,
        resource: &Resource,
        fields: &[&str],
        ids: &[i64],
    ) -> Result<Vec<Value>> {
        let filters = vec![id_in(schema, resource, ids)];
        let fields = fields.iter().map(|f| json!(f)).collect();
        let body = Self::things_body(schema, resource, filters, fields, "list");
        let answer = self.call("things", body, "get").await?;
        Ok(match answer {
            Value::Array(things) => things,
            _ => Vec::new(),
        })
    }
}

/// `[_or, [field, not_empty, ''], …]`: a thing with at least one file in these fields
pub fn not_empty_filter(fields: &[&Field]) -> Value {
    let mut clause = vec![json!("_or")];
    clause.extend(fields.iter().map(|f| json!([f.name, "not_empty", ""])));
    Value::Array(clause)
}

/// `_updated_at > since` (On Page compares dates as text: UTC, `YYYY-MM-DD HH:mm:ss`)
pub fn updated_since_filter(since: &str) -> Value {
    json!(["_updated_at", ">", since])
}

fn id_in(schema: &Schema, resource: &Resource, ids: &[i64]) -> Value {
    json!({
        "type": "field",
        "resource_id": resource.id,
        "field": "_id",
        "operator": "in",
        "value": ids,
        "lang": schema.langs.first(),
    })
}

fn schema_failure(error: Error) -> Error {
    if error.is_aborted() { error } else { Error::Job(schema_error(&error)) }
}

/// Turns transport errors on the schema into the issue the user sees
pub fn schema_error(error: &Error) -> JobError {
    match error {
        Error::Job(job) => job.clone(),
        Error::Http { status: 401 | 403, .. } => {
            JobError::with_detail(IssueCode::TokenInvalid, "The API token was refused", error.detail())
        }
        Error::Aborted => JobError::new(IssueCode::Unexpected, "Aborted"),
        _ if error.is_network() || matches!(error, Error::Timeout(_)) => {
            JobError::with_detail(IssueCode::Offline, "On Page cannot be reached", error.to_string())
        }
        _ => JobError::with_detail(IssueCode::ProjectUnavailable, "The project could not be loaded", error.detail()),
    }
}

pub async fn verify_token(token: &str, ctx: OnPageContext) -> TokenCheck {
    let mut api = Api::new(token, ctx);
    match api.load_schema().await {
        Ok(schema) => TokenCheck {
            ok: true,
            error: None,
            project_id: Some(schema.id),
            project_label: Some(schema.label.clone()),
            collections_with_files: Some(schema.media_resources().len() as u64),
            langs: Some(schema.langs.clone()),
        },
        Err(error) => TokenCheck {
            ok: false,
            error: Some(match &error {
                Error::Job(job) if job.issue == IssueCode::TokenInvalid => TokenError::TokenInvalid,
                Error::Job(job) if job.issue == IssueCode::Offline => TokenError::Offline,
                _ => TokenError::ProjectUnavailable,
            }),
            ..TokenCheck::default()
        },
    }
}

/* ------------------------------------------------------------------ storage */

/// `a.b.c` → `c`; no extension without a dot (and `a.` has an empty one)
fn extension(name: &str) -> Option<&str> {
    let mut parts = name.rsplitn(2, '.');
    let last = parts.next()?;
    parts.next().map(|_| last)
}

/// Compiled once: a page of the duplicates tab builds a link per file (a
/// regex compiled each time cost ~0.3 ms per link)
static NAME_EXTENSION: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.\w+$").expect("valid"));

/// The storage link of a file, as onpage-js `storageLink` builds it
pub fn storage_link(domain: &str, token: &str, name: &str) -> String {
    let mut name = name.to_string();
    if let Some(token_ext) = extension(token).filter(|e| !e.is_empty()) {
        let name_ext = extension(&name).map(str::to_string);
        if name_ext.as_deref() != Some(token_ext) {
            match name_ext.filter(|e| !e.is_empty()) {
                Some(_) if !name.is_empty() => {
                    name = NAME_EXTENSION.replace(&name, format!(".{token_ext}")).into_owned();
                }
                _ => name = format!("{name}.{token_ext}"),
            }
        }
    }
    // onpage-js replaces the first slash of each part
    let mut url = format!("{}/{}", sub_domain(domain, "storage"), encode_uri_component(&token.replacen('/', "-", 1)));
    if !name.is_empty() {
        url.push('/');
        url.push_str(&encode_uri_component(&name.replacen('/', "-", 1)));
    }
    url
}

const IMAGE_FORMATS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "gif", "eps", "dwg", "svg", "tif", "tiff", "pdf", "psd", "ai"];

/// A 100×100 preview, for images
pub fn thumbnail_link(domain: &str, token: &str, name: &str) -> Option<String> {
    let ext = name.rsplit('.').next().unwrap_or_default().to_lowercase();
    IMAGE_FORMATS.contains(&ext.as_str()).then(|| storage_link(domain, &format!("{token}.100x100-contain.webp"), name))
}

pub fn thing_edit_url(schema_id: i64, resource_id: i64, thing_id: i64, field_id: i64) -> String {
    format!("https://app.onpage.it/#/things/edit/{thing_id}/{schema_id}/{resource_id}/{field_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_links_as_onpage_js() {
        assert_eq!(storage_link(DEFAULT_DOMAIN, "abc", "foto 1.jpg"), "https://storage.onpage.it/abc/foto%201.jpg");
        assert_eq!(storage_link(DEFAULT_DOMAIN, "abc.png", "foto.jpg"), "https://storage.onpage.it/abc.png/foto.png");
        assert_eq!(storage_link(DEFAULT_DOMAIN, "abc.png", "foto"), "https://storage.onpage.it/abc.png/foto.png");
        assert_eq!(storage_link("http://127.0.0.1:4310", "abc", "a/b.pdf"), "http://127.0.0.1:4310/abc/a-b.pdf");
        assert_eq!(
            thumbnail_link(DEFAULT_DOMAIN, "abc", "foto.JPG").unwrap(),
            "https://storage.onpage.it/abc.100x100-contain.webp/foto.webp"
        );
        assert!(thumbnail_link(DEFAULT_DOMAIN, "abc", "scheda.docx").is_none());
    }

    #[test]
    fn api_url_of_the_token() {
        let ctx = OnPageContext::new(reqwest::Client::new(), DEFAULT_DOMAIN);
        assert_eq!(Api::new("tok", ctx).base, "https://api.onpage.it/view/tok");
    }

    #[test]
    fn files_of_a_thing_per_field_and_lang() {
        let schema = Schema::from_json(&json!({
            "id": 1, "label": "P", "langs": ["it", "en"], "default_lang": "it",
            "resources": [{ "id": 1, "name": "r", "labels": [], "fields": [
                { "id": 1, "name": "foto", "type": "image", "is_multiple": false },
                { "id": 2, "name": "pdf", "type": "file", "is_translatable": true, "is_multiple": true },
                { "id": 3, "name": "nome", "type": "string" }
            ]}]
        }))
        .unwrap();
        let media = schema.media_resources();
        assert_eq!(media[0].fields.len(), 2);
        let thing = json!({ "id": 5, "fields": {
            "foto": [{ "token": "a", "name": "a.jpg", "size": 10 }, { "token": "b", "name": "b.jpg" }],
            "pdf_en": [{ "token": "c", "name": null, "size": 3.0 }],
            "pdf_it": [{ "token": "", "name": "x" }]
        }});
        let files = thing_files(&thing, &media[0].fields, &schema.langs);
        assert_eq!(files.len(), 2);
        assert_eq!((files[0].token.as_str(), files[0].size), ("a", Some(10)));
        assert_eq!((files[1].name.as_str(), files[1].lang.as_deref(), files[1].size), ("c", Some("en"), Some(3)));
    }
}
