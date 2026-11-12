//! The MCP server for AI agents: the operations of `ops` as tools, run by an
//! `Executor`: here on the projects (`local`), or in the app over HTTP
//! (`connect`, what `opmd mcp` does while the app is open).
//!
//! Two transports:
//! - stdio (`serve_stdio`): `opmd mcp`, started by the agent;
//! - Streamable HTTP on 127.0.0.1 (`serve_http`): the app, while it is open.
//!   Only this computer reaches it (loopback, `Host` checked), web pages are
//!   refused (`Origin`), and every request carries the app's secret
//!   (`Authorization: Bearer`). The address and the secret are in
//!   `<data>/mcp.json`, readable by the user only, for `opmd`.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, InitializeResult,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::ops::{self, OPERATIONS, error_message};
use crate::projects::ProjectService;

/// Where the app's MCP server is, for `opmd`
pub const CONTROL_FILE: &str = "mcp.json";
/// The app's address, the same every time unless another program took it
pub const DEFAULT_PORT: u16 = 47821;

const INSTRUCTIONS: &str = "On Page Media Downloader keeps local or network folders in sync with the media \
files (images, documents) of On Page projects. A project is named by its id or its name. The usual flow: \
list_projects; sync_project (lists On Page and compares with the folder, downloads nothing) then \
wait_for_project; read runtime.plan (files to download, link, remove) and runtime.issues; download_project then \
wait_for_project; get_failed_files and retry_failed when some failed. get_duplicates shows names On Page has for \
different files (only the first is downloaded). remove_project with delete_files and confirm_cleanup delete \
files: ask the user first. Tokens are never shown.";

/// Runs an operation by name with its JSON arguments: errors are codes (see `ops::error_message`)
pub type Executor =
    Arc<dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;

/// The operations on these projects, in this process
pub fn local(projects: Arc<ProjectService>) -> Executor {
    Arc::new(move |name, args| {
        let projects = projects.clone();
        Box::pin(async move { ops::call(&projects, &name, &args).await })
    })
}

#[derive(Clone)]
pub struct Server {
    executor: Executor,
}

impl Server {
    pub fn new(executor: Executor) -> Server {
        Server { executor }
    }
}

/// The operations as MCP tools, with their hints (read only, destructive)
pub fn tools() -> Vec<Tool> {
    OPERATIONS
        .iter()
        .map(|operation| {
            let schema = (operation.schema)().as_object().cloned().unwrap_or_default();
            let mut annotations = ToolAnnotations::with_title(operation.title).read_only(operation.read_only);
            if !operation.read_only {
                annotations = annotations.destructive(operation.destructive);
            }
            Tool::new(operation.name, operation.description, Arc::new(schema))
                .with_title(operation.title)
                .with_annotations(annotations)
        })
        .collect()
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("op-media-downloader", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if ops::operation(&request.name).is_none() {
            return Err(ErrorData::invalid_params(format!("no tool {}", request.name), None));
        }
        let args = Value::Object(request.arguments.unwrap_or_default());
        Ok(encode((self.executor)(request.name.to_string(), args).await).into())
    }
}

/// An answer as a tool result: the JSON as text (what `opmd` reads back, as
/// the operation gave it) and as structured content (an object, as MCP wants)
fn encode(answer: Result<Value, String>) -> CallToolResult {
    match answer {
        Ok(value) => {
            let structured = if value.is_object() { value.clone() } else { json!({ "items": value }) };
            let mut result = CallToolResult::success(vec![ContentBlock::text(value.to_string())]);
            result.structured_content = Some(structured);
            result
        }
        Err(code) => {
            let mut result = CallToolResult::error(vec![ContentBlock::text(error_message(&code))]);
            result.structured_content = Some(json!({ "error": code }));
            result
        }
    }
}

/// A tool result back as the operation's answer
fn decode(result: CallToolResult) -> Result<Value, String> {
    if result.is_error == Some(true) {
        let code = result.structured_content.as_ref().and_then(|content| content["error"].as_str());
        return Err(code.unwrap_or("unexpected").to_string());
    }
    let text = result.content.iter().find_map(|block| block.as_text()).map(|text| text.text.as_str());
    serde_json::from_str(text.unwrap_or("null")).map_err(|error| format!("unexpected: {error}"))
}

/* ------------------------------------------------------------------ stdio */

/// `opmd mcp`: serves on stdin and stdout until the agent closes them
pub async fn serve_stdio(executor: Executor) -> Result<(), String> {
    let running = Server::new(executor).serve(rmcp::transport::stdio()).await.map_err(|error| error.to_string())?;
    running.waiting().await.map_err(|error| error.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------------ HTTP (the app) */

/// The app's server: where it listens, and the secret every request carries
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Control {
    pub url: String,
    pub secret: String,
    pub pid: u32,
}

pub struct HttpServer {
    pub control: Control,
    stop: CancellationToken,
    data_dir: PathBuf,
}

impl HttpServer {
    /// Stops listening and removes `mcp.json`
    pub fn stop(&self) {
        self.stop.cancel();
        remove_control(&self.data_dir, self.control.pid);
    }
}

/// Listens on 127.0.0.1 (`port`, else any free one) and tells `opmd` where in `<data>/mcp.json`
pub async fn serve_http(executor: Executor, port: u16, secret: String, data_dir: &Path) -> std::io::Result<HttpServer> {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
    };
    let address = listener.local_addr()?;
    let stop = CancellationToken::new();
    let config = StreamableHttpServerConfig::default()
        .with_cancellation_token(stop.child_token())
        // A page in a browser carries an Origin: refused
        .enforce_origin_validation();
    let service = StreamableHttpService::new(
        move || Ok(Server::new(executor.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let expected = format!("Bearer {secret}");
    let router = axum::Router::new().route_service("/mcp", service).layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let authorized = request
                .headers()
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| constant_time_eq(value.as_bytes(), expected.as_bytes()));
            async move {
                if authorized {
                    next.run(request).await
                } else {
                    axum::response::IntoResponse::into_response(axum::http::StatusCode::UNAUTHORIZED)
                }
            }
        },
    ));
    let shutdown = stop.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(shutdown.cancelled_owned()).await;
    });
    let control = Control { url: format!("http://{address}/mcp"), secret, pid: std::process::id() };
    write_control(data_dir, &control)?;
    Ok(HttpServer { control, stop, data_dir: data_dir.to_path_buf() })
}

/// A secret for the app's server: kept in the settings so an agent configured with it keeps working
pub fn new_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn write_control(dir: &Path, control: &Control) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let file = dir.join(CONTROL_FILE);
    let temp = dir.join(format!("{CONTROL_FILE}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut handle = options.open(&temp)?;
    handle.write_all(serde_json::to_string_pretty(control).unwrap_or_default().as_bytes())?;
    drop(handle);
    std::fs::rename(&temp, file)
}

/// Removes `mcp.json` when it is still this process's
fn remove_control(dir: &Path, pid: u32) {
    if read_control(dir).is_some_and(|control| control.pid == pid) {
        let _ = std::fs::remove_file(dir.join(CONTROL_FILE));
    }
}

pub fn read_control(dir: &Path) -> Option<Control> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(CONTROL_FILE)).ok()?).ok()
}

/// The app's server, when it is open on this data folder: its operations, run there
pub async fn connect(dir: &Path) -> Option<Executor> {
    let control = read_control(dir)?;
    let config = StreamableHttpClientTransportConfig::with_uri(control.url.as_str()).auth_header(control.secret);
    let transport = StreamableHttpClientTransport::from_config(config);
    let client = tokio::time::timeout(std::time::Duration::from_secs(3), ().serve(transport)).await.ok()?.ok()?;
    let client = Arc::new(client);
    Some(Arc::new(move |name, args| {
        let client = client.clone();
        Box::pin(async move {
            let mut params = CallToolRequestParams::new(name);
            params.arguments = args.as_object().cloned();
            let result = client.call_tool(params).await.map_err(|error| format!("app_unreachable: {error}"))?;
            decode(result)
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_is_a_tool() {
        let tools = tools();
        assert_eq!(tools.len(), OPERATIONS.len());
        let remove = tools.iter().find(|tool| tool.name == "remove_project").unwrap();
        let hints = remove.annotations.as_ref().unwrap();
        assert_eq!((hints.read_only_hint, hints.destructive_hint), (Some(false), Some(true)));
        let list = tools.iter().find(|tool| tool.name == "list_projects").unwrap();
        assert_eq!(list.annotations.as_ref().unwrap().read_only_hint, Some(true));
    }

    #[test]
    fn answers_go_and_come_back_the_same() {
        let list = json!([{ "id": "a" }]);
        assert_eq!(decode(encode(Ok(list.clone()))).unwrap(), list);
        let encoded = encode(Ok(list));
        assert_eq!(encoded.structured_content.unwrap()["items"][0]["id"], "a");
        assert_eq!(decode(encode(Err("project_busy".into()))).unwrap_err(), "project_busy");
    }

    #[test]
    fn secrets_compare_in_constant_time() {
        assert!(constant_time_eq(b"Bearer abc", b"Bearer abc"));
        assert!(!constant_time_eq(b"Bearer abd", b"Bearer abc"));
        assert!(!constant_time_eq(b"Bearer ab", b"Bearer abc"));
    }
}
