//! The fake On Page server, standalone: try the whole app without real data.
//!
//!   cargo run -p op-media-service --features fake-server --bin fake-onpage -- --port 4310 --things 3000
//!
//! Also `--duplicates N` (names with several files) and `--api-delay-ms N` (a
//! slow On Page: each API request waits that long).
//!
//! then start a debug build of the app with OPMD_API_DOMAIN=http://127.0.0.1:4310
//! and the token printed on the console.

use op_media_service::testing::{FakeOnPage, sample_project};

fn arg(name: &str, fallback: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == &format!("--{name}"))
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| fallback.to_string())
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let port: u16 = arg("port", "4310").parse().unwrap_or(4310);
    let things: usize = arg("things", "3000").parse().unwrap_or(3000);
    let duplicates: usize = arg("duplicates", "3").parse().unwrap_or(3);
    let token = arg("token", "fake-token");
    // A slow On Page: every API request waits this long (the files do not)
    let api_delay: u64 = arg("api-delay-ms", "0").parse().unwrap_or(0);
    let project = sample_project(things, duplicates, "opmd");
    let files: usize = project.things.iter().flat_map(|t| t.files.values()).map(|v| v.all().len()).sum();
    let things = project.things.len();
    let fake = FakeOnPage::start(project, &token, port).await?;
    fake.with(|state| state.api.delay = std::time::Duration::from_millis(api_delay));
    println!("Fake On Page on {}", fake.url);
    println!("  token:  {}", fake.token);
    println!("  things: {things}, files: {files}");
    println!("  start the app with OPMD_API_DOMAIN={}", fake.url);
    // Until the process is stopped (Ctrl+C)
    std::future::pending::<()>().await;
    fake.close();
    Ok(())
}
