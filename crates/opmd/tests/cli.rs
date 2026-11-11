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
