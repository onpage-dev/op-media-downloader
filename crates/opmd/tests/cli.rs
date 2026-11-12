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

/// What a script reads from opmd: exit codes, the token from the standard
/// input, refusals without a person at the keyboard, wrong arguments
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scripts_get_clear_answers_and_exit_codes() {
    use tokio::io::AsyncWriteExt;

    let fake = FakeOnPage::start(sample_project(5, 0, "script"), "script-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let folder = dir.path().join("Media");
    std::fs::create_dir_all(&folder).unwrap();
    let opmd = Opmd { data: &data, fake: &fake };

    // The token from the standard input, as a secret manager pipes it
    let mut add = tokio::process::Command::new(env!("CARGO_BIN_EXE_opmd"))
        .args(["add", "--label", "Script", "--folder", &folder.display().to_string(), "--token-stdin"])
        .env("OPMD_DATA_DIR", &data)
        .env("OPMD_NO_KEYRING", "1")
        .env("OPMD_API_DOMAIN", &fake.url)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    add.stdin.take().unwrap().write_all(format!("{}\n", fake.token).as_bytes()).await.unwrap();
    let added = add.wait_with_output().await.unwrap();
    assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stdout));
    assert_eq!(opmd.ok(&["token", "Script"]).await.trim(), fake.token);

    // A file that cannot be downloaded: done, with failed files (3), and they are listed
    let gone = fake.with(|state| {
        state.project.things.iter().find(|t| t.id == 1002).unwrap().files["galleria"].all()[0].token.clone()
    });
    fake.with(|state| {
        state
            .storage
            .insert(gone.clone(), op_media_service::testing::StorageBehaviour { missing: true, ..Default::default() })
    });
    let partial = opmd.run(&["download", "Script"]).await;
    let stdout = String::from_utf8_lossy(&partial.stdout);
    assert_eq!(partial.status.code(), Some(3), "{stdout}");
    assert!(stdout.contains("prodotto-2-retro.jpg") && stdout.contains("not_found"), "{stdout}");
    fake.with(|state| state.storage.clear());
    assert_eq!(opmd.run(&["retry", "Script"]).await.status.code(), Some(0));

    // Wrong arguments, a missing variable, a deletion nobody confirmed
    let wrong = opmd.run(&["settings", "concurrency"]).await;
    assert_eq!(wrong.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("KEY=VALUE"));
    let missing = opmd.run(&["verify-token", "--token-env", "OPMD_TEST_NOT_SET"]).await;
    assert_eq!(missing.status.code(), Some(1));
    let unconfirmed = opmd.run(&["cleanup", "Script"]).await;
    assert_eq!(unconfirmed.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&unconfirmed.stderr).contains("--yes"));
    assert_eq!(opmd.run(&["sync"]).await.status.code(), Some(2), "a usage error is clap's 2");

    // JSON for scripts, the same the MCP tools answer
    let list = opmd.json(&["list"]).await;
    assert_eq!(list[0]["label"], "Script");
    assert_eq!(list[0]["runtime"]["last_result"]["outcome"], "completed");
    let status = opmd.json(&["status"]).await;
    assert_eq!(status["running_jobs"], 0);
    fake.close();
}

/// A server: `download --all` once, then `run` round after round; On Page
/// failing in the middle of it only puts a warning in the log, the next
/// round ends the work; a second `run` on the same data is refused
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_keeps_every_project_up_to_date_round_after_round() {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let fake = FakeOnPage::start(sample_project(6, 0, "server"), "server-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let opmd = Opmd { data: &data, fake: &fake };
    let folders = [dir.path().join("Uno"), dir.path().join("Due")];
    for (label, folder) in ["Uno", "Due"].iter().zip(&folders) {
        opmd.ok(&["add", "--label", label, "--folder", &folder.display().to_string(), "--token-env", "TEST_TOKEN"])
            .await;
    }

    let all = opmd.ok(&["download", "--all"]).await;
    assert!(all.contains("Uno: download completed") && all.contains("Due: download completed"), "{all}");
    for folder in &folders {
        assert!(folder.join("prodotto-3.jpg").exists());
    }

    let mut server = tokio::process::Command::new(env!("CARGO_BIN_EXE_opmd"))
        .args(["run", "--every", "2s", "--rounds", "3"])
        .env("OPMD_DATA_DIR", &data)
        .env("OPMD_NO_KEYRING", "1")
        .env("OPMD_API_DOMAIN", &fake.url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
    let mut seen: Vec<String> = Vec::new();
    let mut until = async |what: &str, seen: &mut Vec<String>| {
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            while let Some(line) = lines.next_line().await.unwrap() {
                seen.push(line.clone());
                if line.contains(what) {
                    return;
                }
            }
            panic!("opmd run ended before «{what}»: {seen:#?}");
        })
        .await
        .unwrap_or_else(|_| panic!("no «{what}»: {seen:#?}"));
    };

    until("Round 1 done", &mut seen).await;
    // A second server on the same data is refused
    let second = opmd.run(&["run", "--every", "1m"]).await;
    assert_eq!(second.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&second.stderr).contains("another `opmd run`"));

    // On Page fails during the second round, and a product leaves it meanwhile
    fake.with(|state| {
        state.api.fail_times = 10_000;
        state.project.things.retain(|thing| thing.id != 1003);
    });
    until("Round 2 done", &mut seen).await;
    fake.with(|state| state.api.fail_times = 0);
    until("Stopped", &mut seen).await;
    let status = tokio::time::timeout(std::time::Duration::from_secs(30), server.wait()).await.unwrap().unwrap();
    assert_eq!(status.code(), Some(0), "{seen:#?}");

    let log = seen.join("\n");
    assert!(log.contains("WARNING Uno: needs attention") && log.contains("WARNING Due: needs attention"), "{log}");
    assert!(log.contains("Round 3 done"), "{log}");
    // The third round ended the work: the product's files left both folders
    for folder in &folders {
        assert!(!folder.join("prodotto-3.jpg").exists(), "{log}");
        assert!(folder.join("prodotto-1.jpg").exists());
    }
    // The rounds are in opmd's log too
    let file = std::fs::read_to_string(data.join("logs").join("opmd.log")).unwrap();
    assert!(file.contains("Round 2 done") && file.contains("needs attention"));
    fake.close();
}

/// One request as On Page (or a person checking the address) makes it: the status code
async fn request(address: &str, method: &str, path: &str, body: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    let _ = stream.read_to_string(&mut answer).await;
    answer.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0)
}

/// `opmd run --listen`: On Page's calls bring the projects of their On Page
/// project up to date, a burst of calls in one sync; a call for another On
/// Page project asks On Page nothing; a wrong secret is not even a path
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn on_page_calls_bring_its_projects_up_to_date() {
    use std::collections::BTreeMap;

    use op_media_service::testing::{FakeFile, FakeValue, token};
    use tokio::io::{AsyncBufReadExt, BufReader};

    let fake = FakeOnPage::start(sample_project(6, 0, "hook"), "hook-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let opmd = Opmd { data: &data, fake: &fake };
    let folders = [dir.path().join("Uno"), dir.path().join("Due")];
    for (label, folder) in ["Uno", "Due"].iter().zip(&folders) {
        opmd.ok(&["add", "--label", label, "--folder", &folder.display().to_string(), "--token-env", "TEST_TOKEN"])
            .await;
    }

    // What to give On Page: the URL, and the collections to observe with their file fields
    let hook = opmd.json(&["webhook", "--public-url", "https://media.example.com/"]).await;
    let old_path = hook["path"].as_str().unwrap().to_string();
    assert_eq!(old_path.len(), "/onpage/".len() + 64, "{hook}");
    assert_eq!(hook["url"], format!("https://media.example.com{old_path}"));
    let onpage = hook["onpage_projects"].as_array().unwrap();
    assert_eq!(onpage.len(), 1, "{hook}");
    assert_eq!(onpage[0]["id"], 77);
    assert_eq!(onpage[0]["for"], serde_json::json!(["Uno", "Due"]));
    let human = opmd.ok(&["webhook"]).await;
    assert!(human.contains(&format!("<this server's public address>{old_path}")), "{human}");
    assert!(
        human.contains("Prodotti: Foto principale, Galleria") && human.contains("Schede tecniche: Scheda PDF"),
        "{human}"
    );
    // An address without HTTPS: the secret would travel in the clear
    let plain = opmd.run(&["webhook", "--public-url", "http://media.example.com"]).await;
    assert!(String::from_utf8_lossy(&plain.stderr).contains("not HTTPS"));
    // A new secret: the old URL stops working
    let path = opmd.json(&["webhook", "--new-secret"]).await["path"].as_str().unwrap().to_string();
    assert_ne!(path, old_path);

    let mut server = tokio::process::Command::new(env!("CARGO_BIN_EXE_opmd"))
        .args(["run", "--listen", "127.0.0.1:0", "--settle", "1s"])
        .env("OPMD_DATA_DIR", &data)
        .env("OPMD_NO_KEYRING", "1")
        .env("OPMD_API_DOMAIN", &fake.url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
    let mut seen: Vec<String> = Vec::new();
    let mut until = async |what: &str, seen: &mut Vec<String>| -> String {
        tokio::time::timeout(std::time::Duration::from_secs(60), async {
            while let Some(line) = lines.next_line().await.unwrap() {
                seen.push(line.clone());
                if line.contains(what) {
                    return line;
                }
            }
            panic!("opmd run ended before «{what}»: {seen:#?}");
        })
        .await
        .unwrap_or_else(|_| panic!("no «{what}»: {seen:#?}"))
    };

    let listening = until("Listening for On Page's calls on http://", &mut seen).await;
    let address = listening.split("http://").nth(1).unwrap().split('/').next().unwrap().to_string();
    // The rounds are the safety net: one a day
    assert!(until("Keeping every project up to date", &mut seen).await.contains("every 1d and when On Page calls"));
    until("Round 1 done", &mut seen).await;
    for folder in &folders {
        assert!(folder.join("prodotto-3.jpg").exists());
    }

    // Only the secret's path answers; a person can check it in a browser
    assert_eq!(request(&address, "GET", &path, "").await, 200);
    assert_eq!(request(&address, "POST", &old_path, "{}").await, 404);
    assert_eq!(request(&address, "POST", "/onpage/", "{}").await, 404);
    assert_eq!(request(&address, "GET", "/", "").await, 404);
    assert_eq!(request(&address, "PUT", &path, "{}").await, 405);

    // A product leaves On Page and a new one comes; On Page calls three times in a row
    fake.with(|state| {
        state.project.things.retain(|thing| thing.id != 1003);
        let mut new = state.project.things[0].clone();
        new.id = 1099;
        new.label = Some("Nuovo".into());
        let photo =
            FakeFile { token: token("hook-new"), name: "nuovo.jpg".into(), size: Some(1234), ..FakeFile::default() };
        new.files = BTreeMap::from([("foto".to_string(), FakeValue::Files(vec![photo]))]);
        state.project.things.push(new);
    });
    let call = r#"{"observer_id": 5, "schema_id": 77, "resource_id": 1, "updates": {"creations": [1099], "edits": [1099], "deletions": [1003]}}"#;
    for _ in 0..3 {
        assert_eq!(request(&address, "POST", &path, call).await, 202);
    }
    until("Done in", &mut seen).await;
    let log = seen.join("\n");
    assert!(log.contains("On Page called: On Page project 77, collection 1: 1 created, 1 deleted"), "{log}");
    assert_eq!(log.matches("Syncing what changed on On Page: Uno, Due").count(), 1, "one sync for the burst: {log}");
    for folder in &folders {
        assert!(folder.join("nuovo.jpg").exists(), "{log}");
        assert!(!folder.join("prodotto-3.jpg").exists(), "{log}");
    }

    // Another On Page project's call: On Page is not even asked
    let asked = fake.state.lock().hits.api;
    assert_eq!(request(&address, "POST", &path, r#"{"schema_id": 999}"#).await, 202);
    until("No project here downloads On Page project 999", &mut seen).await;
    assert_eq!(fake.state.lock().hits.api, asked);

    // A body that is not as documented still rings, for every project
    assert_eq!(request(&address, "POST", &path, "not json").await, 202);
    until("Syncing what changed on On Page: Uno, Due", &mut seen).await;
    until("Done in", &mut seen).await;

    // A flood of calls for thousands of On Page projects (whoever got the secret): one sync, a
    // log that does not drown
    let from = seen.len();
    for schema in 0..200 {
        let body = format!(r#"{{"schema_id": {}, "updates": {{"edits": [1]}}}}"#, 10_000 + schema);
        assert_eq!(request(&address, "POST", &path, &body).await, 202);
    }
    until("Done in", &mut seen).await;
    let flood = seen[from..].join("\n");
    assert_eq!(flood.matches("Syncing what changed on On Page: Uno, Due").count(), 1, "{flood}");
    assert!(flood.matches("On Page called").count() <= 20, "{flood}");
    assert!(flood.contains("more calls came, not written one by one"), "{flood}");

    server.start_kill().unwrap();
    let _ = server.wait().await;
    // The secret is in no log
    let secret = path.trim_start_matches("/onpage/");
    let file = std::fs::read_to_string(data.join("logs").join("opmd.log")).unwrap();
    assert!(file.contains("Syncing what changed") && !file.contains(secret));
    assert!(!seen.join("\n").contains(secret));
    fake.close();
}

/// A round leaves a shared folder to the computer that just brought it up to
/// date (`data/synced.json`), and brings the others up to date in one job each
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_round_leaves_a_shared_folder_to_the_computer_that_just_synced_it() {
    let fake = FakeOnPage::start(sample_project(4, 0, "shared"), "shared-token", 0).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let opmd = Opmd { data: &data, fake: &fake };
    let (uno, due) = (dir.path().join("Uno"), dir.path().join("Due"));
    for (label, folder) in [("Uno", &uno), ("Due", &due)] {
        opmd.ok(&["add", "--label", label, "--folder", &folder.display().to_string(), "--token-env", "TEST_TOKEN"])
            .await;
    }
    std::fs::create_dir_all(uno.join("data")).unwrap();
    let at = op_media_service::iso_ms(op_media_service::now_ms());
    let synced = format!(r#"{{"at":"{at}","instance_id":"another-app","host":"pc-di-luca"}}"#);
    std::fs::write(uno.join("data").join("synced.json"), synced).unwrap();

    let out = opmd.ok(&["run", "--every", "1h", "--rounds", "1"]).await;
    assert!(out.contains("Uno: left to pc-di-luca, which brought its shared folder up to date just now"), "{out}");
    assert!(out.contains("Due: download completed"), "{out}");
    assert!(due.join("prodotto-1.jpg").exists() && !uno.join("prodotto-1.jpg").exists());
    // A download asked by a person is not left to anybody
    assert!(opmd.ok(&["download", "--all"]).await.contains("Uno: download completed"));
    assert!(uno.join("prodotto-1.jpg").exists());
    fake.close();
}
