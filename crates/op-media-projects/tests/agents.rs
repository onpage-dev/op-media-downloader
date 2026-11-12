//! What agents and opmd drive: the operations (`ops`) with their arguments
//! checked as the window's, and the app's MCP server over HTTP, which only
//! this computer, without a web page in between and with the secret, may use.

use std::sync::Arc;
use std::time::Duration;

use op_media_projects::mcp;
use op_media_projects::models::AppLanguage;
use op_media_projects::ops::{self, OPERATIONS, error_message};
use op_media_projects::paths::AppPaths;
use op_media_projects::projects::ProjectService;
use op_media_projects::{OpenOptions, Opened};
use op_media_service::testing::{FakeOnPage, sample_project};
use serde_json::{Value, json};

async fn projects(fake: &FakeOnPage, dir: &tempfile::TempDir) -> Arc<ProjectService> {
    let Opened { projects, .. } = op_media_projects::open(OpenOptions {
        paths: AppPaths::at(dir.path().join("data")),
        default_language: AppLanguage::En,
        keyring_service: None,
        api_domain: Some(fake.url.clone()),
        runtime: tokio::runtime::Handle::current(),
        notify: Box::new(|_| {}),
    })
    .unwrap();
    projects
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_operation_listed_is_run_and_checks_its_arguments() {
    let fake = FakeOnPage::start(sample_project(4, 1, "ops"), "ops-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let projects = projects(&fake, &dir).await;
    // Every tool an agent sees is one the dispatcher knows
    for operation in OPERATIONS {
        let answer = ops::call(&projects, operation.name, &json!({})).await;
        assert_ne!(answer, Err("unknown_operation".into()), "{}", operation.name);
    }
    assert_eq!(ops::call(&projects, "format_disk", &json!({})).await.unwrap_err(), "unknown_operation");

    // Arguments checked as the window's
    assert_eq!(ops::call(&projects, "get_project", &json!({})).await.unwrap_err(), "invalid_input");
    assert_eq!(ops::call(&projects, "get_project", &json!({ "project": 7 })).await.unwrap_err(), "invalid_input");
    let no_token = json!({ "label": "X", "folder": dir.path().join("X") });
    assert_eq!(ops::call(&projects, "create_project", &no_token).await.unwrap_err(), "invalid_input");
    let relative = json!({ "label": "X", "token": fake.token, "folder": "relativa" });
    assert_eq!(ops::call(&projects, "create_project", &relative).await.unwrap_err(), "invalid_input");
    let unknown = json!({ "project": "Nessuno" });
    assert_eq!(ops::call(&projects, "sync_project", &unknown).await.unwrap_err(), "project_not_found");

    // A whole flow, as an agent runs it
    let folder = dir.path().join("Agente").display().to_string();
    let created =
        ops::call(&projects, "create_project", &json!({ "label": "Agente", "token": fake.token, "folder": folder }))
            .await
            .unwrap();
    assert!(created.get("token").is_none() && !created.to_string().contains(&fake.token), "no token in an answer");
    ops::call(&projects, "download_project", &json!({ "project": "agente" })).await.unwrap();
    let done =
        ops::call(&projects, "wait_for_project", &json!({ "project": "Agente", "timeout_seconds": 60 })).await.unwrap();
    assert_eq!(done["runtime"]["last_result"]["outcome"], "completed");
    let duplicates = ops::call(&projects, "get_duplicates", &json!({ "project": "Agente" })).await.unwrap();
    assert_eq!(duplicates["total"], 1);
    let uses = &duplicates["groups"][0]["variants"][0]["uses"][0];
    assert!(uses["thing_label"].is_string(), "an agent gets the item names: {uses}");
    let name = duplicates["groups"][0]["name"].as_str().unwrap();
    let files =
        ops::call(&projects, "get_duplicate_files", &json!({ "project": "Agente", "name": name })).await.unwrap();
    assert_eq!(files["more_variants"], 0);

    // As in the window: a number out of range is brought within it, a value that is not one is ignored
    let before = ops::call(&projects, "get_settings", &json!({})).await.unwrap();
    let after = ops::call(&projects, "update_settings", &json!({ "concurrency": 99, "theme": "neon" })).await.unwrap();
    assert_eq!((after["concurrency"].clone(), after["theme"].clone()), (json!(10), before["theme"].clone()));
    let changed = ops::call(&projects, "update_settings", &json!({ "concurrency": 3 })).await.unwrap();
    assert_eq!(changed["concurrency"], 3);

    // The folder check names another project by its name
    let taken = ops::call(&projects, "inspect_folder", &json!({ "folder": folder })).await.unwrap();
    assert_eq!(taken["problem_detail"], "Agente");
    let mine = ops::call(&projects, "inspect_folder", &json!({ "folder": folder, "project": "Agente" })).await.unwrap();
    assert!(mine["problems"].as_array().unwrap().is_empty(), "{mine}");

    // Removing with its files is the destructive one
    let remove = OPERATIONS.iter().find(|o| o.name == "remove_project").unwrap();
    assert!(remove.destructive && !remove.read_only);
    ops::call(&projects, "remove_project", &json!({ "project": "Agente", "delete_files": true })).await.unwrap();
    assert_eq!(ops::call(&projects, "list_projects", &json!({})).await.unwrap(), json!([]));
    assert!(error_message("folder_protected").contains("system folder"));
}

/// A raw HTTP request to the app's server: its status
async fn post(url: &str, headers: &[(&str, &str)], body: &Value) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let address = url.trim_start_matches("http://").split('/').next().unwrap().to_string();
    let body = body.to_string();
    let mut request = format!(
        "POST /mcp HTTP/1.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(&body);
    let mut stream = tokio::net::TcpStream::connect(&address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut answer)).await;
    answer.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_apps_server_answers_this_computer_with_the_secret_only() {
    let fake = FakeOnPage::start(sample_project(2, 0, "mcp"), "mcp-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let projects = projects(&fake, &dir).await;
    let data = dir.path().join("data");
    let server = mcp::serve_http(mcp::local(projects.clone()), 0, mcp::new_secret(), &data).await.unwrap();
    let control = mcp::read_control(&data).unwrap();
    assert_eq!(control.pid, std::process::id());
    let host = control.url.trim_start_matches("http://").split('/').next().unwrap().to_string();
    let bearer = format!("Bearer {}", control.secret);
    let initialize = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } });

    assert_eq!(post(&control.url, &[("Host", &host), ("Authorization", &bearer)], &initialize).await, 200);
    // No secret, a wrong one
    assert_eq!(post(&control.url, &[("Host", &host)], &initialize).await, 401);
    assert_eq!(post(&control.url, &[("Host", &host), ("Authorization", "Bearer guess")], &initialize).await, 401);
    // A web page (it sends an Origin) and a name that only points here (DNS rebinding)
    let page = post(
        &control.url,
        &[("Host", &host), ("Authorization", &bearer), ("Origin", "https://evil.example")],
        &initialize,
    )
    .await;
    assert!(page >= 400, "a page is refused: {page}");
    let rebound = post(&control.url, &[("Host", "evil.example"), ("Authorization", &bearer)], &initialize).await;
    assert!(rebound >= 400, "a foreign host is refused: {rebound}");

    // opmd's way in: the same answers as here
    let app = mcp::connect(&data).await.expect("opmd reaches the app");
    let here = ops::call(&projects, "list_projects", &json!({})).await.unwrap();
    assert_eq!(app("list_projects".into(), json!({})).await.unwrap(), here);
    assert_eq!(app("get_project".into(), json!({ "project": "x" })).await.unwrap_err(), "project_not_found");

    // Closed: the address goes, and an old mcp.json leads nowhere, quickly
    server.stop();
    assert!(mcp::read_control(&data).is_none());
    std::fs::write(data.join(mcp::CONTROL_FILE), serde_json::to_string(&control).unwrap()).unwrap();
    let started = std::time::Instant::now();
    assert!(mcp::connect(&data).await.is_none());
    assert!(started.elapsed() < Duration::from_secs(5));
}
