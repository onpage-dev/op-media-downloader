//! On Page's webhooks, for `opmd run --listen`. In On Page an Observer
//! watches a collection (its things created, edited, deleted; only some
//! fields if asked) and calls a URL when they change, with the ids touched:
//! `{"observer_id", "schema_id", "resource_id", "updates": {"creations",
//! "edits", "deletions"}}`. Here a call only rings a bell: the projects of
//! that On Page project are synced (what changed only, as at every round)
//! once the calls stop for a moment, so a burst of edits makes one sync (and
//! a call delivered twice, as the real On Page does now and then).
//!
//! The listener faces the internet, so nothing a caller sends is trusted:
//! - On Page signs nothing: the URL carries a secret (`opmd-webhook.json`,
//!   its owner's only), compared in constant time; any other path is a 404,
//!   answered without reading the body;
//! - a call names an On Page project and nothing else: the sync reads what
//!   changed from On Page with the project's token, so a forged call can do no
//!   more than one sync more;
//! - what a caller can hold is bounded: a connection lives 30 seconds at most
//!   (a slow client cannot keep it), 64 at a time and 8 per address (the
//!   others are closed at once), every answer closes its connection; a body
//!   is read up to 8 MiB and its ids are counted, not kept; at most 32 On
//!   Page projects wait (more: every project, once); at most 20 calls a minute
//!   are written one by one in the log.
//!
//! On Page calls public addresses only: HTTPS comes from a reverse proxy or a
//! tunnel in front of opmd (the secret travels in the URL).

use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::de::{self, IgnoredAny, SeqAccess, Visitor};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::time::{Instant, Sleep};

pub const SECRET_FILE: &str = "opmd-webhook.json";
/// The calls' path: `/onpage/<secret>`
pub const PREFIX: &str = "/onpage/";
/// A call's body read at most (a bulk edit of 100,000 things is about 2 MiB); a longer one still rings, for every project
const BODY_LIMIT: usize = 8 * 1024 * 1024;
/// On Page projects waiting at most: more ring for every project
const MAX_PENDING: usize = 32;
/// Calls written one by one in the log per minute
const LOGGED_PER_MINUTE: u32 = 20;
/// The secret is read again this often (`opmd webhook --new-secret` while it runs)
const SECRET_REFRESH: Duration = Duration::from_secs(2);

/// What a caller can hold
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub connections: usize,
    pub per_address: usize,
    /// A connection is closed after this, whatever it is doing
    pub lifetime: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { connections: 64, per_address: 8, lifetime: Duration::from_secs(30) }
    }
}

/* ------------------------------------------------------------------ secret */

/// The secret of the URL, made the first time; `renew`: a new one (the old URL stops working)
pub fn secret(data_dir: &Path, renew: bool) -> Result<String, String> {
    if !renew && let Some(secret) = read_secret(data_dir) {
        return Ok(secret);
    }
    let secret = op_media_projects::mcp::new_secret();
    write_secret(data_dir, &secret)
        .map_err(|error| format!("cannot save {}: {error}", data_dir.join(SECRET_FILE).display()))?;
    Ok(secret)
}

pub fn read_secret(data_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(data_dir.join(SECRET_FILE)).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json["secret"].as_str().filter(|secret| secret.len() >= 32).map(str::to_string)
}

fn write_secret(dir: &Path, secret: &str) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    // A name nobody can guess, made here: nothing planted in its place is written through
    let temp = dir.join(format!("{SECRET_FILE}.{}.tmp", &op_media_projects::mcp::new_secret()[..16]));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        // Whoever reads it can make opmd sync: its owner's only
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp)?;
        let text = json!({ "secret": secret, "created_at": op_media_service::now_iso() });
        file.write_all(serde_json::to_string_pretty(&text).unwrap_or_default().as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, dir.join(SECRET_FILE))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/* ------------------------------------------------------------------ calls */

/// What a call says: its On Page project and how many things changed
#[derive(Debug, Default, PartialEq)]
pub struct Call {
    pub schema_id: Option<i64>,
    pub resource_id: Option<i64>,
    pub created: usize,
    pub edited: usize,
    pub deleted: usize,
}

#[derive(Deserialize, Default)]
struct Body {
    #[serde(default)]
    schema_id: Id,
    #[serde(default)]
    resource_id: Id,
    #[serde(default)]
    updates: Updates,
}

#[derive(Deserialize, Default)]
struct Updates {
    #[serde(default)]
    creations: Count,
    #[serde(default)]
    edits: Count,
    #[serde(default)]
    deletions: Count,
}

/// An id as a number or as text; null is none
#[derive(Default)]
struct Id(Option<i64>);

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Id, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Id;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an id")
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Id, E> {
                Ok(Id(Some(value)))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Id, E> {
                Ok(Id(i64::try_from(value).ok()))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Id, E> {
                Ok(Id(value.trim().parse().ok()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Id, E> {
                Ok(Id(None))
            }
        }
        deserializer.deserialize_any(V)
    }
}

/// The length of a list of ids, counted without keeping them
#[derive(Default)]
struct Count(usize);

impl<'de> Deserialize<'de> for Count {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Count, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Count;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a list of ids")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Count, A::Error> {
                let mut count = 0;
                while seq.next_element::<IgnoredAny>()?.is_some() {
                    count += 1;
                }
                Ok(Count(count))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Count, E> {
                Ok(Count(0))
            }
        }
        deserializer.deserialize_any(V)
    }
}

/// A body On Page did not write as documented still rings: for every project
pub fn read_call(body: &[u8]) -> Call {
    let body: Body = serde_json::from_slice(body).unwrap_or_default();
    let updates = body.updates;
    Call {
        schema_id: body.schema_id.0,
        resource_id: body.resource_id.0,
        created: updates.creations.0,
        // A thing created is in the edits too
        edited: updates.edits.0.saturating_sub(updates.creations.0),
        deleted: updates.deletions.0,
    }
}

/// `On Page project 77, collection 1: 2 created, 1 edited` (numbers only: nothing a caller wrote)
pub fn describe(call: &Call) -> String {
    let Some(schema) = call.schema_id else {
        return "a call that names no On Page project (every project is synced)".into();
    };
    let mut text = format!("On Page project {schema}");
    if let Some(resource) = call.resource_id {
        text.push_str(&format!(", collection {resource}"));
    }
    let counts: Vec<String> = [(call.created, "created"), (call.edited, "edited"), (call.deleted, "deleted")]
        .iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| format!("{count} {what}"))
        .collect();
    if !counts.is_empty() {
        text.push_str(&format!(": {}", counts.join(", ")));
    }
    text
}

/// The calls not acted on yet, per On Page project (`None`: a call that did
/// not say, for every project): the first and the last
pub struct Pending {
    calls: Mutex<HashMap<Option<i64>, (Instant, Instant)>>,
    rung: Notify,
    /// The calls must stop this long before the sync…
    quiet: Duration,
    /// …but no longer than this after the first: a steady stream of calls still syncs
    longest: Duration,
    /// The log's minute: when it began, the calls written, those not
    logged: Mutex<(Instant, u32, u32)>,
}

impl Pending {
    pub fn new(quiet: Duration) -> Pending {
        Pending {
            calls: Mutex::new(HashMap::new()),
            rung: Notify::new(),
            quiet,
            longest: quiet * 10,
            logged: Mutex::new((Instant::now(), 0, 0)),
        }
    }

    pub fn ring(&self, schema: Option<i64>) {
        self.ring_at(schema, Instant::now());
    }

    fn ring_at(&self, schema: Option<i64>, now: Instant) {
        let mut calls = lock(&self.calls);
        // Many On Page projects at once (no server has that many): every project, once
        let schema = if calls.contains_key(&schema) || calls.len() < MAX_PENDING { schema } else { None };
        calls.entry(schema).and_modify(|(_, last)| *last = now).or_insert((now, now));
        // Kept for the next wait when nobody waits now
        self.rung.notify_one();
    }

    /// When the first On Page project's calls have settled
    pub fn due(&self) -> Option<Instant> {
        lock(&self.calls).values().map(|calls| self.settled(calls)).min()
    }

    /// The On Page projects whose calls have settled, taken off
    pub fn take_due(&self, now: Instant) -> Vec<Option<i64>> {
        let mut calls = lock(&self.calls);
        let due: Vec<Option<i64>> =
            calls.iter().filter(|(_, at)| self.settled(at) <= now).map(|(schema, _)| *schema).collect();
        for schema in &due {
            calls.remove(schema);
        }
        due
    }

    /// A round syncs every project: the calls before it are answered
    pub fn clear(&self) {
        lock(&self.calls).clear();
    }

    /// Ends at the next call (at once when one came meanwhile)
    pub async fn rung(&self) {
        self.rung.notified().await;
    }

    /// Whether this call may be written in the log: 20 a minute
    pub fn may_log(&self) -> bool {
        self.may_log_at(Instant::now())
    }

    fn may_log_at(&self, now: Instant) -> bool {
        let mut logged = lock(&self.logged);
        if now.duration_since(logged.0) >= Duration::from_secs(60) {
            *logged = (now, 0, logged.2);
        }
        if logged.1 < LOGGED_PER_MINUTE {
            logged.1 += 1;
            true
        } else {
            logged.2 += 1;
            false
        }
    }

    /// The calls not written one by one since the last time, counted off
    pub fn take_unlogged(&self) -> u32 {
        std::mem::take(&mut lock(&self.logged).2)
    }

    fn settled(&self, (first, last): &(Instant, Instant)) -> Instant {
        (*last + self.quiet).min(*first + self.longest)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The projects these calls are for: those of their On Page projects, and
/// those whose On Page project is not known yet (never synced); every project
/// for a call that did not say
pub fn projects_for(projects: &Value, schemas: &[Option<i64>]) -> Vec<String> {
    projects
        .as_array()
        .into_iter()
        .flatten()
        .filter(|project| {
            let onpage = project["onpage_project"]["id"].as_i64();
            schemas.iter().any(|schema| schema.is_none() || onpage.is_none() || onpage == *schema)
        })
        .filter_map(|project| project["id"].as_str().map(str::to_string))
        .collect()
}

/* ------------------------------------------------------------------ listener */

/// Listens for On Page's calls until the stop; the address it got (port 0: a free one)
pub async fn listen(address: SocketAddr, data_dir: PathBuf, pending: Arc<Pending>) -> std::io::Result<SocketAddr> {
    listen_with(address, data_dir, pending, Limits::default()).await
}

pub async fn listen_with(
    address: SocketAddr,
    data_dir: PathBuf,
    pending: Arc<Pending>,
    limits: Limits,
) -> std::io::Result<SocketAddr> {
    let inner = TcpListener::bind(address).await?;
    let bound = inner.local_addr()?;
    let listener = Guarded { inner, slots: Slots { open: Arc::new(Mutex::new(HashMap::new())), limits } };
    let hook = Arc::new(Hook { data_dir, pending, secret: Mutex::new(None) });
    let router = axum::Router::new().fallback(move |request: axum::extract::Request| {
        let hook = hook.clone();
        async move { hook.answer(request).await }
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(crate::stop::stopped()).await;
    });
    Ok(bound)
}

struct Hook {
    data_dir: PathBuf,
    pending: Arc<Pending>,
    /// The secret as last read, and when
    secret: Mutex<Option<(Option<String>, Instant)>>,
}

impl Hook {
    async fn answer(&self, request: axum::extract::Request) -> Response {
        let mut response = self.reply(request).await;
        // One request per connection: nobody keeps one open between calls
        response.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
        response
    }

    async fn reply(&self, request: axum::extract::Request) -> Response {
        // Any other path, or a wrong secret, is not here: nothing tells them apart, and the body is not read
        let given = request.uri().path().strip_prefix(PREFIX).map(|given| given.trim_end_matches('/'));
        let known = given.zip(self.secret());
        if !known.is_some_and(|(given, secret)| constant_time_eq(given.as_bytes(), secret.as_bytes())) {
            return StatusCode::NOT_FOUND.into_response();
        }
        match *request.method() {
            // A person checking the address in a browser, through the proxy
            Method::GET | Method::HEAD => {
                (StatusCode::OK, "opmd is listening: On Page can call this address\n").into_response()
            }
            Method::POST => {
                let declared = request
                    .headers()
                    .get(header::CONTENT_LENGTH)
                    .and_then(|length| length.to_str().ok()?.parse::<u64>().ok());
                let call = if declared.is_some_and(|length| length > BODY_LIMIT as u64) {
                    // Too long to read: it rings for every project
                    Call::default()
                } else {
                    match axum::body::to_bytes(request.into_body(), BODY_LIMIT).await {
                        Ok(body) => read_call(&body),
                        // Cut short (a slow or broken client, a body longer than it said): nothing rings
                        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
                    }
                };
                if self.pending.may_log() {
                    crate::serve::say(&format!("On Page called: {}", describe(&call)));
                }
                self.pending.ring(call.schema_id);
                // On Page counts 2xx as delivered; the sync comes when the calls settle
                (StatusCode::ACCEPTED, "queued\n").into_response()
            }
            _ => (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "GET, POST")]).into_response(),
        }
    }

    /// The secret, read again every 2 seconds at most
    fn secret(&self) -> Option<String> {
        let mut cached = lock(&self.secret);
        match &*cached {
            Some((secret, at)) if at.elapsed() < SECRET_REFRESH => secret.clone(),
            _ => {
                let secret = read_secret(&self.data_dir);
                *cached = Some((secret.clone(), Instant::now()));
                secret
            }
        }
    }
}

/// The open connections, per address
#[derive(Clone)]
struct Slots {
    open: Arc<Mutex<HashMap<IpAddr, usize>>>,
    limits: Limits,
}

impl Slots {
    /// A place for a connection from this address, while there is one
    fn take(&self, ip: IpAddr) -> Option<Slot> {
        let ip = ip.to_canonical();
        let mut open = lock(&self.open);
        let total: usize = open.values().sum();
        if total >= self.limits.connections || open.get(&ip).copied().unwrap_or(0) >= self.limits.per_address {
            return None;
        }
        *open.entry(ip).or_default() += 1;
        Some(Slot { slots: self.clone(), ip })
    }
}

/// Given back when its connection ends
struct Slot {
    slots: Slots,
    ip: IpAddr,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut open = lock(&self.slots.open);
        if let Some(count) = open.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                open.remove(&self.ip);
            }
        }
    }
}

/// The TCP listener with the limits: a connection over them is closed at once
struct Guarded {
    inner: TcpListener,
    slots: Slots,
}

impl axum::serve::Listener for Guarded {
    type Io = Guard;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Guard, SocketAddr) {
        loop {
            // axum's own: it waits and tries again on the errors of accept (too many open files…)
            let (stream, address) = axum::serve::Listener::accept(&mut self.inner).await;
            if let Some(slot) = self.slots.take(address.ip()) {
                let deadline = Box::pin(tokio::time::sleep(self.slots.limits.lifetime));
                return (Guard { stream, deadline, _slot: slot }, address);
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

/// A connection that ends at its deadline, whatever the other end does (a
/// slow client, one that sends nothing)
struct Guard {
    stream: TcpStream,
    deadline: Pin<Box<Sleep>>,
    _slot: Slot,
}

impl Guard {
    fn expired(&mut self, cx: &mut Context<'_>) -> bool {
        self.deadline.as_mut().poll(cx).is_ready()
    }
}

fn too_long() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, "the connection lasted too long")
}

impl AsyncRead for Guard {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.expired(cx) {
            return Poll::Ready(Err(too_long()));
        }
        Pin::new(&mut this.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for Guard {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        if this.expired(cx) {
            return Poll::Ready(Err(too_long()));
        }
        Pin::new(&mut this.stream).poll_write(cx, data)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

/* ------------------------------------------------------------------ setup */

/// The On Page project of a token and its collections with files, with those
/// fields: what the observers must watch
pub async fn collections(token: &str, domain: &str) -> Result<Value, String> {
    use op_media_service::onpage::{Api, OnPageContext, http_client, schema_error};
    let mut ctx = OnPageContext::new(http_client(concat!("opmd/", env!("CARGO_PKG_VERSION"))), domain);
    ctx.timeout = Duration::from_secs(30);
    let mut api = Api::new(token, ctx);
    let schema = api.load_schema().await.map_err(|error| {
        let issue = schema_error(&error).issue;
        serde_json::to_value(issue).ok().and_then(|code| code.as_str().map(str::to_string)).unwrap_or_default()
    })?;
    let lang = schema.lang().to_string();
    let collections: Vec<Value> = schema
        .media_resources()
        .iter()
        .map(|media| {
            let fields: Vec<Value> = media
                .fields
                .iter()
                .map(|field| json!({ "id": field.id, "label": schema.field_label(field, &lang) }))
                .collect();
            json!({
                "id": media.resource.id,
                "label": schema.resource_label(media.resource, &lang),
                "fields": fields,
            })
        })
        .collect();
    Ok(json!({ "id": schema.id, "label": schema.label, "collections": collections }))
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[test]
    fn a_call_reads_as_on_page_documents_it() {
        let body = br#"{"observer_id": 123, "schema_id": 1000, "resource_id": 392,
            "updates": {"creations": [2], "edits": [1, 2], "deletions": [3]}}"#;
        let call = read_call(body);
        assert_eq!(call, Call { schema_id: Some(1000), resource_id: Some(392), created: 1, edited: 1, deleted: 1 });
        assert_eq!(describe(&call), "On Page project 1000, collection 392: 1 created, 1 edited, 1 deleted");
        // Ids as text, nulls, fields nobody asked for
        let call =
            read_call(br#"{"schema_id": "77", "resource_id": null, "updates": {"edits": null}, "x": {"y": [1]}}"#);
        assert_eq!(call, Call { schema_id: Some(77), ..Call::default() });
        // What is not as documented rings for every project
        for body in [&b"hello"[..], br#"{"schema_id": true}"#, br#"{"schema_id": 1, "updates": {"edits": 5}}"#, b""] {
            assert_eq!(read_call(body), Call::default(), "{}", String::from_utf8_lossy(body));
        }
        assert!(describe(&Call::default()).contains("every project"));
    }

    #[test]
    fn a_long_list_of_ids_is_counted_not_kept() {
        let ids = (0..1_000_000).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let body = format!(r#"{{"schema_id": 5, "updates": {{"edits": [{ids}], "deletions": [{ids}]}}}}"#);
        let call = read_call(body.as_bytes());
        assert_eq!((call.edited, call.deleted), (1_000_000, 1_000_000));
    }

    #[test]
    fn a_burst_of_calls_makes_one_sync_once_they_settle() {
        let pending = Pending::new(Duration::from_secs(30));
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        pending.ring_at(Some(77), at(0));
        pending.ring_at(Some(77), at(20));
        pending.ring_at(Some(88), at(5));
        assert_eq!(pending.due(), Some(at(35)));
        assert!(pending.take_due(at(34)).is_empty());
        assert_eq!(pending.take_due(at(35)), vec![Some(88)]);
        assert_eq!(pending.take_due(at(50)), vec![Some(77)]);
        assert_eq!(pending.due(), None);

        // A steady stream still syncs: at most ten quiet periods after the first call
        for second in (100..=500).step_by(10) {
            pending.ring_at(None, at(second));
        }
        assert_eq!(pending.due(), Some(at(400)));
        pending.clear();
        assert_eq!(pending.due(), None);
    }

    #[test]
    fn calls_for_thousands_of_on_page_projects_wait_as_one() {
        let pending = Pending::new(Duration::from_secs(30));
        let now = Instant::now();
        for schema in 0..10_000 {
            pending.ring_at(Some(schema), now);
        }
        let due = pending.take_due(now + Duration::from_secs(30));
        assert_eq!(due.len(), MAX_PENDING + 1);
        assert!(due.contains(&None));
    }

    #[test]
    fn the_log_takes_twenty_calls_a_minute_and_counts_the_rest() {
        let pending = Pending::new(Duration::from_secs(30));
        let start = Instant::now();
        let written = (0..100).filter(|_| pending.may_log_at(start)).count();
        assert_eq!(written, 20);
        assert_eq!(pending.take_unlogged(), 80);
        assert_eq!(pending.take_unlogged(), 0);
        assert!(pending.may_log_at(start + Duration::from_secs(61)));
    }

    #[test]
    fn a_call_is_for_the_projects_of_its_on_page_project() {
        let projects = json!([
            { "id": "a", "onpage_project": { "id": 77, "label": "Uno" } },
            { "id": "b", "onpage_project": { "id": 88, "label": "Due" } },
            { "id": "c" },
        ]);
        assert_eq!(projects_for(&projects, &[Some(77)]), ["a", "c"]);
        assert_eq!(projects_for(&projects, &[Some(77), Some(88)]), ["a", "b", "c"]);
        assert_eq!(projects_for(&projects, &[None]), ["a", "b", "c"]);
        assert_eq!(
            projects_for(&json!([{ "id": "b", "onpage_project": { "id": 88 } }]), &[Some(99)]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_secret_is_made_once_and_renewed_on_demand() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_secret(dir.path()), None);
        let first = secret(dir.path(), false).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(secret(dir.path(), false).unwrap(), first);
        let second = secret(dir.path(), true).unwrap();
        assert_ne!(second, first);
        assert_eq!(read_secret(dir.path()), Some(second));
        // No temporary file left behind
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(SECRET_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd") && !constant_time_eq(b"ab", b"abc"));
    }

    #[test]
    fn the_connections_are_counted_per_address_and_in_all() {
        let limits = Limits { connections: 3, per_address: 2, lifetime: Duration::from_secs(1) };
        let slots = Slots { open: Arc::new(Mutex::new(HashMap::new())), limits };
        let a: IpAddr = "203.0.113.1".parse().unwrap();
        let b: IpAddr = "203.0.113.2".parse().unwrap();
        let first = slots.take(a).unwrap();
        let _second = slots.take(a).unwrap();
        assert!(slots.take(a).is_none(), "two per address");
        // The same address written as IPv6
        assert!(slots.take("::ffff:203.0.113.1".parse().unwrap()).is_none());
        let _third = slots.take(b).unwrap();
        assert!(slots.take(b).is_none(), "three in all");
        drop(first);
        assert!(slots.take(a).is_some());
    }

    /// Bytes until the other end closes, or None when it does not within `within`
    async fn until_closed(stream: &mut TcpStream, within: Duration) -> Option<Vec<u8>> {
        let mut bytes = Vec::new();
        match tokio::time::timeout(within, stream.read_to_end(&mut bytes)).await {
            Ok(_) => Some(bytes),
            Err(_) => None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slow_and_surplus_connections_are_cut() {
        let dir = tempfile::tempdir().unwrap();
        let secret = secret(dir.path(), false).unwrap();
        let limits = Limits { connections: 64, per_address: 2, lifetime: Duration::from_millis(800) };
        let pending = Arc::new(Pending::new(Duration::from_secs(30)));
        let address = listen_with("127.0.0.1:0".parse().unwrap(), dir.path().to_path_buf(), pending.clone(), limits)
            .await
            .unwrap();

        // Two clients that send nothing hold this address's places…
        let started = Instant::now();
        let mut silent = [TcpStream::connect(address).await.unwrap(), TcpStream::connect(address).await.unwrap()];
        tokio::time::sleep(Duration::from_millis(100)).await;
        // …a third is closed at once, without an answer
        let mut surplus = TcpStream::connect(address).await.unwrap();
        let _ = surplus.write_all(format!("GET {PREFIX}{secret} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await;
        let refused = until_closed(&mut surplus, Duration::from_millis(500)).await;
        assert_eq!(refused, Some(Vec::new()), "closed at once, without an answer");
        // The silent ones are cut at their deadline, not before
        for stream in &mut silent {
            assert!(until_closed(stream, Duration::from_secs(5)).await.is_some_and(|bytes| bytes.is_empty()));
        }
        assert!(started.elapsed() >= Duration::from_millis(700), "{:?}", started.elapsed());

        // A slow request (half the headers, then nothing) is cut too
        let mut slow = TcpStream::connect(address).await.unwrap();
        slow.write_all(
            format!("POST {PREFIX}{secret} HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{{").as_bytes(),
        )
        .await
        .unwrap();
        assert!(until_closed(&mut slow, Duration::from_secs(5)).await.is_some());

        // The places are free again; every answer closes its connection
        let mut good = TcpStream::connect(address).await.unwrap();
        good.write_all(format!("GET {PREFIX}{secret} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
        let answer = String::from_utf8(until_closed(&mut good, Duration::from_secs(5)).await.unwrap()).unwrap();
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert!(answer.to_lowercase().contains("connection: close"), "{answer}");

        // A wrong secret of the right length, a longer one, the bare prefix: not found
        for path in [format!("{PREFIX}{}", "0".repeat(64)), format!("{PREFIX}{secret}x"), PREFIX.to_string()] {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream
                .write_all(format!("POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{{}}").as_bytes())
                .await
                .unwrap();
            let answer = String::from_utf8(until_closed(&mut stream, Duration::from_secs(5)).await.unwrap()).unwrap();
            assert!(answer.starts_with("HTTP/1.1 404"), "{path}: {answer}");
        }
        assert_eq!(pending.due(), None, "nothing rang");

        // A body longer than the limit is not read; it rings for every project
        let mut huge = TcpStream::connect(address).await.unwrap();
        let head = format!("POST {PREFIX}{secret} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{{", BODY_LIMIT + 1);
        huge.write_all(head.as_bytes()).await.unwrap();
        let answer = String::from_utf8(until_closed(&mut huge, Duration::from_secs(5)).await.unwrap()).unwrap();
        assert!(answer.starts_with("HTTP/1.1 202"), "{answer}");
        assert_eq!(pending.take_due(Instant::now() + Duration::from_secs(30)), vec![None]);
    }
}
