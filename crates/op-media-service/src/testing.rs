//! A fake On Page for tests and for trying the whole app without real data:
//! it answers the API (`/view/<token>/schema`, `/view/<token>/things`, the
//! calls the client makes) and the storage links (`/<token>/<name>`) on the
//! same host, with switches for the bad days (429, 500, a cut connection, a
//! silent server, 404).
//!
//! Standalone:
//!   cargo run -p op-media-service --features fake-server --bin fake-onpage -- --port 4310 --things 3000
//! then start the app (a debug build) with OPMD_API_DOMAIN=http://127.0.0.1:4310
//! and the token printed on the console.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha1::Digest;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default)]
pub struct FakeFile {
    pub token: String,
    pub name: String,
    /// Size announced by the API; defaults to the content length
    pub size: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    /// Served bytes; generated from the token when missing
    pub content: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Image,
    File,
    Text,
}

#[derive(Debug, Clone)]
pub struct FakeField {
    pub id: i64,
    pub name: String,
    pub kind: FieldKind,
    pub translatable: bool,
    pub textual: bool,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct FakeResource {
    pub id: i64,
    pub name: String,
    pub label: String,
    pub fields: Vec<FakeField>,
}

/// The files of a field: one list, or one per language (translatable fields)
#[derive(Debug, Clone)]
pub enum FakeValue {
    Files(Vec<FakeFile>),
    ByLang(BTreeMap<String, Vec<FakeFile>>),
}

impl FakeValue {
    pub fn all(&self) -> Vec<&FakeFile> {
        match self {
            FakeValue::Files(files) => files.iter().collect(),
            FakeValue::ByLang(by_lang) => by_lang.values().flatten().collect(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct FakeThing {
    pub id: i64,
    pub resource_id: i64,
    pub files: BTreeMap<String, FakeValue>,
    pub label: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct FakeProject {
    pub id: i64,
    pub label: String,
    pub langs: Vec<String>,
    pub resources: Vec<FakeResource>,
    pub things: Vec<FakeThing>,
}

impl FakeProject {
    pub fn find_file(&self, token: &str) -> Option<&FakeFile> {
        self.things.iter().flat_map(|t| t.files.values()).flat_map(FakeValue::all).find(|f| f.token == token)
    }

    pub fn thing_mut(&mut self, id: i64) -> Option<&mut FakeThing> {
        self.things.iter_mut().find(|t| t.id == id)
    }
}

/// Per-token storage behaviour
#[derive(Debug, Clone, Default)]
pub struct StorageBehaviour {
    /// Answer 404
    pub missing: bool,
    /// Answer 500 this many times, then serve
    pub fail_times: u32,
    /// Cut the connection in the middle of the body this many times, then serve
    pub reset_times: u32,
    /// Send headers and then nothing, forever
    pub mute: bool,
    /// Answer 429 with this Retry-After (seconds) this many times
    pub rate_limit_times: u32,
    pub retry_after_s: u64,
    /// Wait before answering
    pub delay: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct ApiBehaviour {
    /// 429 to the next N requests
    pub rate_limit_times: u32,
    /// 500 to the next N requests
    pub fail_times: u32,
    pub retry_after_s: u64,
    pub delay: Duration,
    /// Always 500 for the things of this resource (by name)
    pub fail_resource: Option<String>,
}

#[derive(Default)]
pub struct Hits {
    pub api: u64,
    pub storage: HashMap<String, u64>,
}

pub struct FakeState {
    pub project: FakeProject,
    pub storage: HashMap<String, StorageBehaviour>,
    pub api: ApiBehaviour,
    pub hits: Hits,
}

pub struct FakeOnPage {
    pub url: String,
    pub port: u16,
    pub token: String,
    pub state: Arc<Mutex<FakeState>>,
    stop: CancellationToken,
}

impl FakeOnPage {
    pub async fn start(project: FakeProject, token: &str, port: u16) -> std::io::Result<FakeOnPage> {
        let state = Arc::new(Mutex::new(FakeState {
            project,
            storage: HashMap::new(),
            api: ApiBehaviour { retry_after_s: 1, ..ApiBehaviour::default() },
            hits: Hits::default(),
        }));
        let shared = Shared { token: token.to_string(), state: state.clone() };
        let router = Router::new().fallback(handle).with_state(shared);
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await?;
        let port = listener.local_addr()?.port();
        let stop = CancellationToken::new();
        let shutdown = stop.clone();
        tokio::spawn(async move {
            let _ =
                axum::serve(listener, router).with_graceful_shutdown(async move { shutdown.cancelled().await }).await;
        });
        Ok(FakeOnPage { url: format!("http://127.0.0.1:{port}"), port, token: token.to_string(), state, stop })
    }

    pub fn with<T>(&self, change: impl FnOnce(&mut FakeState) -> T) -> T {
        change(&mut self.state.lock())
    }

    /// Marks a thing as changed now (for `_updated_at` filters)
    pub fn touch(&self, thing_id: i64) {
        if let Some(thing) = self.state.lock().project.thing_mut(thing_id) {
            thing.updated_at = server_now();
        }
    }

    pub fn storage_hits(&self) -> u64 {
        self.state.lock().hits.storage.values().sum()
    }

    pub fn close(&self) {
        self.stop.cancel();
    }
}

impl Drop for FakeOnPage {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[derive(Clone)]
struct Shared {
    token: String,
    state: Arc<Mutex<FakeState>>,
}

/// The bytes of a file: its content, or bytes made from its token
pub fn file_content(file: &FakeFile) -> Vec<u8> {
    if let Some(content) = &file.content {
        return content.clone();
    }
    let size = file.size.unwrap_or(64) as usize;
    let seed = sha2::Sha256::digest(file.token.as_bytes());
    (0..size).map(|i| seed[i % seed.len()]).collect()
}

fn server_now() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

const STAMP: &str = "2026-01-01 00:00:00";

fn schema_json(project: &FakeProject) -> Value {
    let lang = &project.langs[0];
    json!({
        "id": project.id,
        "company_id": 1,
        "label": project.label,
        "langs": project.langs,
        "default_lang": lang,
        "created_at": STAMP,
        "updated_at": STAMP,
        "resources": project.resources.iter().map(|r| json!({
            "id": r.id,
            "name": r.name,
            "label": r.label,
            "labels": { lang.as_str(): r.label },
            "opts": {},
            "fields": r.fields.iter().enumerate().map(|(order, f)| json!({
                "id": f.id,
                "name": f.name,
                "type": match f.kind { FieldKind::Image => "image", FieldKind::File => "file", FieldKind::Text => "string" },
                "is_translatable": f.translatable,
                "is_multiple": true,
                "is_textual": f.textual,
                "resource_id": r.id,
                "order": order,
                "opts": {},
                "label": f.label,
                "labels": { lang.as_str(): f.label },
                "descriptions": [],
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn raw_file(file: &FakeFile) -> Value {
    let mut raw =
        json!({ "name": file.name, "token": file.token, "size": file.size.unwrap_or(file_content(file).len() as u64) });
    if let Some(width) = file.width {
        raw["width"] = json!(width);
    }
    if let Some(height) = file.height {
        raw["height"] = json!(height);
    }
    raw
}

fn has_media(thing: &FakeThing, names: &[String]) -> bool {
    names.iter().any(|name| thing.files.get(name).is_some_and(|v| !v.all().is_empty()))
}

/// The filters the client sends: `_or` not_empty, `_updated_at >`, `_id in`
fn matches(thing: &FakeThing, filters: &[Value]) -> bool {
    for clause in filters {
        match clause {
            Value::Array(parts) if parts.first().and_then(Value::as_str) == Some("_or") => {
                let names: Vec<String> =
                    parts[1..].iter().filter_map(|c| c.get(0)?.as_str().map(str::to_string)).collect();
                if !has_media(thing, &names) {
                    return false;
                }
            }
            Value::Array(parts) if parts.first().and_then(Value::as_str) == Some("_updated_at") => {
                let since = parts.get(2).and_then(Value::as_str).unwrap_or_default();
                if thing.updated_at.as_str() <= since {
                    return false;
                }
            }
            // `_id in`: read once per request (`id_filter`)
            _ => {}
        }
    }
    true
}

fn thing_json(thing: &FakeThing, resource: &FakeResource, wanted: &[String], langs: &[String]) -> Value {
    let mut fields = serde_json::Map::new();
    for field in &resource.fields {
        if !wanted.is_empty() && !wanted.contains(&field.name) {
            continue;
        }
        if field.kind == FieldKind::Text {
            if let Some(label) = &thing.label {
                let key = if field.translatable { format!("{}_{}", field.name, langs[0]) } else { field.name.clone() };
                fields.insert(key, json!([label]));
            }
            continue;
        }
        let Some(value) = thing.files.get(&field.name) else {
            continue;
        };
        if field.translatable {
            for lang in langs {
                let files: Vec<&FakeFile> = match value {
                    FakeValue::Files(files) if lang == &langs[0] => files.iter().collect(),
                    FakeValue::Files(_) => Vec::new(),
                    FakeValue::ByLang(by_lang) => by_lang.get(lang).map(|f| f.iter().collect()).unwrap_or_default(),
                };
                if !files.is_empty() {
                    fields.insert(
                        format!("{}_{lang}", field.name),
                        Value::Array(files.into_iter().map(raw_file).collect()),
                    );
                }
            }
        } else {
            let files = value.all();
            if !files.is_empty() {
                fields.insert(field.name.clone(), Value::Array(files.into_iter().map(raw_file).collect()));
            }
        }
    }
    json!({
        "id": thing.id,
        "resource_id": thing.resource_id,
        "fields": fields,
        "relations": {},
        "rel_ids": {},
        "created_at": STAMP,
        "updated_at": thing.updated_at,
    })
}

fn answer(status: StatusCode, body: Value) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    response.headers_mut().insert(header::DATE, HeaderValue::from_str(&httpdate_now()).expect("valid"));
    response
}

fn httpdate_now() -> String {
    chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

fn with_retry_after(mut response: Response, seconds: u64) -> Response {
    response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(seconds));
    response
}

fn percent_decode(part: &str) -> String {
    let bytes = part.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&part[i + 1..i + 3], 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn handle(State(shared): State<Shared>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let parts: Vec<String> = path.split('/').filter(|p| !p.is_empty()).map(percent_decode).collect();
    let auth = request.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(str::to_string);

    if parts.first().map(String::as_str) == Some("view") {
        let body = to_bytes(request.into_body(), 64 * 1024 * 1024).await.unwrap_or_default();
        return api(&shared, &parts, auth, &body).await;
    }
    storage(&shared, &parts).await
}

async fn api(shared: &Shared, parts: &[String], auth: Option<String>, body: &Bytes) -> Response {
    let delay = {
        let mut state = shared.state.lock();
        state.hits.api += 1;
        state.api.delay
    };
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let path_token = parts.get(1).filter(|_| parts.len() > 2);
    if path_token != Some(&shared.token) && auth.as_ref() != Some(&shared.token) {
        return answer(StatusCode::UNAUTHORIZED, json!({ "message": "Unauthenticated" }));
    }
    let mut state = shared.state.lock();
    if state.api.rate_limit_times > 0 {
        state.api.rate_limit_times -= 1;
        let after = state.api.retry_after_s;
        return with_retry_after(
            answer(StatusCode::TOO_MANY_REQUESTS, json!({ "message": "Too many requests" })),
            after,
        );
    }
    if state.api.fail_times > 0 {
        state.api.fail_times -= 1;
        return answer(StatusCode::INTERNAL_SERVER_ERROR, json!({ "message": "Server error" }));
    }
    let data: Value = serde_json::from_slice(body).unwrap_or(json!({}));
    match parts.last().map(String::as_str) {
        Some("schema") => answer(StatusCode::OK, schema_json(&state.project)),
        Some("things") => {
            let resource_name = data.get("resource").and_then(Value::as_str).unwrap_or_default().to_string();
            if state.api.fail_resource.as_deref() == Some(resource_name.as_str()) {
                return answer(StatusCode::INTERNAL_SERVER_ERROR, json!({ "message": "Server error" }));
            }
            let project = &state.project;
            let Some(resource) = project.resources.iter().find(|r| r.name == resource_name) else {
                return answer(StatusCode::NOT_FOUND, json!({ "message": "Resource not found" }));
            };
            let filters: Vec<Value> = data.get("filters").and_then(Value::as_array).cloned().unwrap_or_default();
            let id_filter: Option<std::collections::HashSet<i64>> = filters.iter().find_map(|clause| {
                let object = clause.as_object()?;
                (object.get("field").and_then(Value::as_str) == Some("_id")).then(|| {
                    object
                        .get("value")
                        .and_then(Value::as_array)
                        .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
                })?
            });
            let mut things: Vec<&FakeThing> = project
                .things
                .iter()
                .filter(|t| t.resource_id == resource.id && matches(t, &filters))
                .filter(|t| id_filter.as_ref().is_none_or(|ids| ids.contains(&t.id)))
                .collect();
            things.sort_by_key(|t| t.id);
            match data.get("return").and_then(Value::as_str) {
                Some("ids") => answer(StatusCode::OK, json!(things.iter().map(|t| t.id).collect::<Vec<_>>())),
                Some("count") => answer(StatusCode::OK, json!(things.len())),
                _ => {
                    let wanted: Vec<String> = data
                        .get("fields")
                        .and_then(Value::as_array)
                        .map(|f| f.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                    answer(
                        StatusCode::OK,
                        json!(
                            things.iter().map(|t| thing_json(t, resource, &wanted, &project.langs)).collect::<Vec<_>>()
                        ),
                    )
                }
            }
        }
        _ => answer(StatusCode::NOT_FOUND, json!({ "message": "Not found" })),
    }
}

async fn storage(shared: &Shared, parts: &[String]) -> Response {
    // Storage: /<token>[.transform]/<name> (sample tokens have no dots)
    let token = parts.first().map(|p| p.split('.').next().unwrap_or_default().to_string()).unwrap_or_default();
    let (file, behaviour) = {
        let mut state = shared.state.lock();
        *state.hits.storage.entry(token.clone()).or_default() += 1;
        (state.project.find_file(&token).cloned(), state.storage.get(&token).cloned().unwrap_or_default())
    };
    if !behaviour.delay.is_zero() {
        tokio::time::sleep(behaviour.delay).await;
    }
    let Some(file) = file.filter(|_| !behaviour.missing) else {
        return answer(StatusCode::NOT_FOUND, json!({ "message": "Not found" }));
    };
    {
        let mut state = shared.state.lock();
        let live = state.storage.entry(token.clone()).or_default();
        if live.rate_limit_times > 0 {
            live.rate_limit_times -= 1;
            let after = live.retry_after_s.max(1);
            return with_retry_after(
                answer(StatusCode::TOO_MANY_REQUESTS, json!({ "message": "Too many requests" })),
                after,
            );
        }
        if live.fail_times > 0 {
            live.fail_times -= 1;
            return answer(StatusCode::INTERNAL_SERVER_ERROR, json!({ "message": "Server error" }));
        }
        if live.reset_times > 0 {
            live.reset_times -= 1;
            // Half the body, then the connection goes
            let content = file_content(&file);
            let half = Bytes::from(content[..content.len() / 2].to_vec());
            let stream = futures::stream::iter(vec![
                Ok::<Bytes, std::io::Error>(half),
                Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset")),
            ]);
            return octets(content.len(), Body::from_stream(stream));
        }
    }
    let content = file_content(&file);
    if behaviour.mute {
        let stream = futures::stream::pending::<Result<Bytes, std::io::Error>>();
        return octets(content.len(), Body::from_stream(stream));
    }
    let length = content.len();
    octets(length, Body::from(content))
}

fn octets(length: usize, body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, length)
        .body(body)
        .expect("valid response")
}

/* ------------------------------------------------------------------ sample data */

pub fn token(seed: &str) -> String {
    hex::encode(sha1::Sha1::digest(seed.as_bytes()))
}

fn image(token_seed: &str, name: &str, size: u64) -> FakeFile {
    FakeFile { token: token(token_seed), name: name.into(), size: Some(size), ..FakeFile::default() }
}

/// A project with two collections: «Prodotti» (photo + gallery, a label field)
/// and «Schede tecniche» (a translatable PDF field, it/en). Some files share
/// a content (same token, two names) and a few names have different files
/// (duplicates).
pub fn sample_project(things: usize, duplicates: usize, seed: &str) -> FakeProject {
    let products = FakeResource {
        id: 1,
        name: "prodotti".into(),
        label: "Prodotti".into(),
        fields: vec![
            FakeField {
                id: 11,
                name: "nome".into(),
                kind: FieldKind::Text,
                translatable: false,
                textual: true,
                label: "Nome".into(),
            },
            FakeField {
                id: 12,
                name: "foto".into(),
                kind: FieldKind::Image,
                translatable: false,
                textual: false,
                label: "Foto principale".into(),
            },
            FakeField {
                id: 13,
                name: "galleria".into(),
                kind: FieldKind::Image,
                translatable: false,
                textual: false,
                label: "Galleria".into(),
            },
        ],
    };
    let sheets = FakeResource {
        id: 2,
        name: "schede".into(),
        label: "Schede tecniche".into(),
        fields: vec![
            FakeField {
                id: 21,
                name: "titolo".into(),
                kind: FieldKind::Text,
                translatable: false,
                textual: true,
                label: "Titolo".into(),
            },
            FakeField {
                id: 22,
                name: "pdf".into(),
                kind: FieldKind::File,
                translatable: true,
                textual: false,
                label: "Scheda PDF".into(),
            },
        ],
    };
    let mut list = Vec::new();
    for i in 1..=things {
        let photo = FakeFile {
            width: Some(1200),
            height: Some(900),
            ..image(&format!("{seed}-photo-{i}"), &format!("prodotto-{i}.jpg"), 2000 + (i as u64 % 7) * 100)
        };
        let gallery = vec![
            image(&format!("{seed}-gal-{i}-a"), &format!("prodotto-{i}-retro.jpg"), 1500),
            // Same content as the photo, another name: one download, two names
            FakeFile { name: format!("prodotto-{i}-copertina.jpg"), width: None, height: None, ..photo.clone() },
        ];
        list.push(FakeThing {
            id: 1000 + i as i64,
            resource_id: 1,
            label: Some(format!("Prodotto {i}")),
            files: BTreeMap::from([
                ("foto".to_string(), FakeValue::Files(vec![photo])),
                ("galleria".to_string(), FakeValue::Files(gallery)),
            ]),
            updated_at: STAMP.into(),
        });
    }
    for i in 1..=((things as f64 / 5.0).round() as usize).max(1) {
        list.push(FakeThing {
            id: 5000 + i as i64,
            resource_id: 2,
            label: Some(format!("Scheda {i}")),
            files: BTreeMap::from([(
                "pdf".to_string(),
                FakeValue::ByLang(BTreeMap::from([
                    ("it".to_string(), vec![image(&format!("{seed}-pdf-{i}-it"), &format!("scheda-{i}-it.pdf"), 4000)]),
                    ("en".to_string(), vec![image(&format!("{seed}-pdf-{i}-en"), &format!("scheda-{i}-en.pdf"), 4100)]),
                ])),
            )]),
            updated_at: STAMP.into(),
        });
    }
    // Duplicates: the same name (different case) for different contents
    for d in 1..=duplicates.min(things) {
        if let Some(FakeValue::Files(gallery)) = list[d - 1].files.get_mut("galleria") {
            gallery.push(image(&format!("{seed}-dup-{d}"), &format!("PRODOTTO-{d}.JPG"), 999));
        }
    }
    FakeProject {
        id: 77,
        label: "Progetto di prova".into(),
        langs: vec!["it".into(), "en".into()],
        resources: vec![products, sheets],
        things: list,
    }
}
