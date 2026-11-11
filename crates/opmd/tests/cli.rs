//! `opmd` itself, as a person or a script runs it, against the fake On Page:
//! its own data folder (as on a server), the token in its settings file.

use std::path::Path;
use std::process::Output;

use op_media_service::testing::{FakeOnPage, sample_project};
use serde_json::Value;

struct Opmd<'a> {
    data: &'a Path,
    fake: &'a FakeOnPage,
}

impl Opmd<'_> {
    async fn run(&self, args: &[&str]) -> Output {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_opmd"));
        command
            .args(args)
            .env("OPMD_DATA_DIR", self.data)
            .env("OPMD_NO_KEYRING", "1")
            .env("OPMD_API_DOMAIN", &self.fake.url)
            .env("TEST_TOKEN", &self.fake.token)
            .stdin(std::process::Stdio::null());
        command.output().await.expect("opmd runs")
    }

    async fn ok(&self, args: &[&str]) -> String {
        let output = self.run(args).await;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        assert!(
            output.status.success(),
            "opmd {args:?}: {:?}\n{stdout}\n{}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        stdout
    }

    async fn json(&self, args: &[&str]) -> Value {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        serde_json::from_str(&self.ok(&all).await).expect("JSON")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_from_the_terminal_to_the_end() {
    let fake = FakeOnPage::start(sample_project(30, 3, "cli"), "cli-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let folder = dir.path().join("Media");
    std::fs::create_dir_all(&folder).unwrap();
    let opmd = Opmd { data: &data, fake: &fake };
    let folder_arg = folder.display().to_string();

    assert!(opmd.ok(&["list"]).await.contains("No projects"));
    let added = opmd.ok(&["add", "--label", "Catalogo", "--folder", &folder_arg, "--token-env", "TEST_TOKEN"]).await;
    assert!(added.starts_with("Added Catalogo"), "{added}");

    // Sync: a plan, nothing downloaded; then the download
    let synced = opmd.ok(&["sync", "catalogo"]).await;
    assert!(synced.contains("files to download"), "{synced}");
    let project = opmd.json(&["show", "Catalogo"]).await;
    let to_download = project["runtime"]["plan"]["to_download_names"].as_u64().unwrap();
    assert!(to_download > 0);
    let downloaded = opmd.ok(&["download", "Catalogo"]).await;
    assert!(downloaded.contains("download completed"), "{downloaded}");
    let names = std::fs::read_dir(&folder).unwrap().filter(|e| e.as_ref().unwrap().file_name() != "data").count();
    assert_eq!(names as u64, to_download);

    // The rest of what the app does
    let duplicates = opmd.json(&["duplicates", "Catalogo"]).await;
    assert_eq!(duplicates["total"], 3);
    assert!(opmd.ok(&["verify-token", "--project", "Catalogo"]).await.starts_with("Token works"));
    assert_eq!(opmd.ok(&["token", "Catalogo"]).await.trim(), "cli-token");
    assert_eq!(opmd.json(&["settings", "concurrency=2"]).await["concurrency"], 2);

    // The token is in the settings file (no credential store asked)
    let settings = std::fs::read_to_string(data.join("op-media-downloader-config.json")).unwrap();
    assert!(settings.contains("\"token_plain\""));

    // A wrong name, an unconfirmed deletion
    let missing = opmd.run(&["show", "Altro"]).await;
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("project_not_found"));
    let unconfirmed = opmd.run(&["remove", "Catalogo", "--delete-files"]).await;
    assert_eq!(unconfirmed.status.code(), Some(1));

    // Removed with its files: only the app's ones were there, the folder goes too
    opmd.ok(&["remove", "Catalogo", "--delete-files", "--yes"]).await;
    assert!(opmd.ok(&["list"]).await.contains("No projects"));
    assert!(!folder.exists() || std::fs::read_dir(&folder).unwrap().next().is_none());
    fake.close();
}

/// `opmd mcp` as an agent speaks to it: JSON-RPC lines on its standard input and output
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opmd_mcp_answers_an_agent() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let fake = FakeOnPage::start(sample_project(10, 1, "mcp"), "mcp-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let folder = dir.path().join("Media");
    std::fs::create_dir_all(&folder).unwrap();
    let opmd = Opmd { data: &data, fake: &fake };
    opmd.ok(&["add", "--label", "Agente", "--folder", &folder.display().to_string(), "--token-env", "TEST_TOKEN"])
        .await;

    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_opmd"))
        .arg("mcp")
        .env("OPMD_DATA_DIR", &data)
        .env("OPMD_NO_KEYRING", "1")
        .env("OPMD_API_DOMAIN", &fake.url)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut ask = async |message: Value| -> Option<Value> {
        stdin.write_all(format!("{message}\n").as_bytes()).await.unwrap();
        message.get("id")?;
        let line =
            tokio::time::timeout(std::time::Duration::from_secs(30), lines.next_line()).await.unwrap().unwrap()?;
        Some(serde_json::from_str(&line).unwrap())
    };

    let init = ask(serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } }))
    .await
    .unwrap();
    assert_eq!(init["result"]["serverInfo"]["name"], "op-media-downloader");
    ask(serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;

    let tools = ask(serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.unwrap();
    let names: Vec<&str> =
        tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"download_project") && names.contains(&"get_duplicates"), "{names:?}");
    assert!(!names.iter().any(|name| name.contains("token") && name.contains("reveal")));

    let call = |id: u64, name: &str, arguments: Value| serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } });
    let listed = ask(call(3, "list_projects", serde_json::json!({}))).await.unwrap();
    assert_eq!(listed["result"]["structuredContent"]["items"][0]["label"], "Agente");

    ask(call(4, "download_project", serde_json::json!({ "project": "agente" }))).await.unwrap();
    let waited = ask(call(5, "wait_for_project", serde_json::json!({ "project": "Agente", "timeout_seconds": 60 })))
        .await
        .unwrap();
    assert_eq!(waited["result"]["structuredContent"]["runtime"]["last_result"]["outcome"], "completed");

    let missing = ask(call(6, "get_project", serde_json::json!({ "project": "Nessuno" }))).await.unwrap();
    assert_eq!(missing["result"]["isError"], true);
    assert_eq!(missing["result"]["structuredContent"]["error"], "project_not_found");

    drop(stdin);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
    fake.close();
}

/// With the app open on the same data, opmd's commands run in it (here an
/// app made of the same pieces: the projects and the MCP server over HTTP)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_the_app_open_the_commands_run_in_it() {
    use op_media_projects::{OpenOptions, mcp, paths::AppPaths};

    let fake = FakeOnPage::start(sample_project(10, 1, "app"), "app-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let folder = dir.path().join("Media");
    std::fs::create_dir_all(&folder).unwrap();

    let events = std::sync::Arc::new(std::sync::Mutex::new(0usize));
    let seen = events.clone();
    let app = op_media_projects::open(OpenOptions {
        paths: AppPaths::at(data.clone()),
        default_language: op_media_projects::models::AppLanguage::En,
        keyring_service: None,
        api_domain: Some(fake.url.clone()),
        runtime: tokio::runtime::Handle::current(),
        notify: Box::new(move |_| *seen.lock().unwrap() += 1),
    })
    .unwrap();
    let server = mcp::serve_http(mcp::local(app.projects.clone()), 0, mcp::new_secret(), &data).await.unwrap();

    let opmd = Opmd { data: &data, fake: &fake };
    assert_eq!(opmd.json(&["info"]).await["app_open"], true);
    opmd.ok(&["add", "--label", "Nell'app", "--folder", &folder.display().to_string(), "--token-env", "TEST_TOKEN"])
        .await;
    // Created by the app itself: it knows the project without reading the file again
    assert_eq!(app.projects.views().len(), 1);
    let downloaded = opmd.ok(&["download", "Nell'app"]).await;
    assert!(downloaded.contains("download completed"), "{downloaded}");
    assert!(*events.lock().unwrap() > 0, "the app heard of the job");
    // The token is read here, never through the app's server
    assert_eq!(opmd.ok(&["token", "Nell'app"]).await.trim(), "app-token");

    // Wrong secret: refused
    let control = mcp::read_control(&data).unwrap();
    let refused = reqwest_post(&control.url).await;
    assert_eq!(refused, 401);

    // The app closes: opmd works on its own again
    server.stop();
    assert!(mcp::read_control(&data).is_none());
    assert_eq!(opmd.json(&["info"]).await["app_open"], false);
    assert_eq!(opmd.json(&["list"]).await.as_array().unwrap().len(), 1);
    fake.close();
}

/// A request without the app's secret
async fn reqwest_post(url: &str) -> u16 {
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    let address = url.trim_start_matches("http://").split('/').next().unwrap().to_string();
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer wrong\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(&address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer).await;
    answer.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0)
}
