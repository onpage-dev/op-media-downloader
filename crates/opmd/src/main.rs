//! `opmd`: On Page Media Downloader from the terminal. Everything the app does
//! with its projects (adding them, «Sincronizza», «Scarica», the failed files,
//! the duplicates, the settings…), with or without the app:
//!
//! - by default on the app's projects and tokens (the app need not be open);
//! - with `--data-dir` (or `OPMD_DATA_DIR`) on projects of its own, for a
//!   server or a NAS where the app is not installed.
//!
//! Every command is an operation of `op_media_projects::ops`, the same the
//! MCP server offers to AI agents (`opmd mcp`). A job runs in this process:
//! `opmd` follows it to its end, and Ctrl+C stops it cleanly.

mod backend;
mod render;

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::time::Duration;

use backend::Backend;
use clap::{Args, Parser, Subcommand};
use op_media_projects::ops::error_message;
use op_media_projects::paths::AppPaths;
use serde_json::{Map, Value, json};

/// Exit codes: done; a failure; a job that ended with failed files; stopped with Ctrl+C
const OK: i32 = 0;
const FAILED: i32 = 1;
const PARTIAL: i32 = 3;
const INTERRUPTED: i32 = 130;

#[derive(Parser)]
#[command(
    name = "opmd",
    version,
    about = "On Page Media Downloader from the terminal: the app's projects, with or without the app",
    after_help = "A project is named by its id or its name. Jobs run until they end (Ctrl+C stops them).\n\
                  On a server or a NAS: --data-dir DIR (or OPMD_DATA_DIR) keeps projects and tokens of its own;\n\
                  without a credential store the tokens stay in DIR's settings file, readable by its owner only.",
    disable_help_subcommand = true
)]
struct Cli {
    /// A data folder of its own instead of the app's: its projects, tokens and settings
    #[arg(long, global = true, env = "OPMD_DATA_DIR", value_name = "DIR")]
    data_dir: Option<PathBuf>,
    /// Print the answers as JSON (as the app and the MCP tools get them)
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// The projects and their state
    #[command(alias = "ls")]
    List,
    /// One project in detail: folder, state, last sync and job, issues
    Show { project: String },
    /// Add a project: an On Page API token and the folder to keep in sync
    Add {
        #[arg(long)]
        label: String,
        #[arg(long)]
        folder: PathBuf,
        #[command(flatten)]
        token: TokenArgs,
        /// Keep the files On Page no longer has
        #[arg(long)]
        keep_old_files: bool,
        /// Sync right after
        #[arg(long)]
        sync: bool,
    },
    /// Change a project's name, folder, token or old-files rule
    Edit {
        project: String,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        folder: Option<PathBuf>,
        #[command(flatten)]
        token: TokenArgs,
        /// Keep (true) or remove (false) the files On Page no longer has
        #[arg(long, value_name = "true|false")]
        keep_old_files: Option<bool>,
    },
    /// Remove a project (its files stay, unless --delete-files)
    #[command(alias = "rm")]
    Remove {
        project: String,
        /// Also delete the files the app downloaded (the folder's other files stay)
        #[arg(long)]
        delete_files: bool,
        /// Do not ask
        #[arg(long, short)]
        yes: bool,
    },
    /// «Sincronizza»: list on On Page and compare with the folder (no downloads)
    Sync {
        /// The project; --all for every one
        #[arg(required_unless_present = "all")]
        project: Option<String>,
        #[arg(long, conflicts_with = "project")]
        all: bool,
        /// List everything again, not only what changed
        #[arg(long)]
        full: bool,
        /// Use the folder although another On Page project synced it
        #[arg(long)]
        take_over_folder: bool,
        #[command(flatten)]
        wait: WaitArgs,
    },
    /// «Scarica»: download what the folder lacks
    Download {
        project: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    /// Download again only the files that failed
    Retry {
        project: String,
        #[command(flatten)]
        wait: WaitArgs,
    },
    /// Confirm the removals a job held back (deletes the files On Page no longer has)
    Cleanup {
        project: String,
        /// Do not ask
        #[arg(long, short)]
        yes: bool,
        #[command(flatten)]
        wait: WaitArgs,
    },
    /// Stop a project's job
    Stop { project: String },
    /// The last events of a project's jobs
    Activity {
        project: String,
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// The files that failed in the last job
    Failed {
        project: String,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Names with different files on On Page (only the first is downloaded)
    Duplicates {
        project: String,
        /// Part of the name
        #[arg(long)]
        search: Option<String>,
        /// All the files of this name, past the first 10
        #[arg(long, conflicts_with = "search")]
        name: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Check a folder: reachable, writable, kind, free space, problems
    Inspect {
        folder: PathBuf,
        /// The project it would be for
        #[arg(long)]
        project: Option<String>,
    },
    /// Check an On Page token, or a project's saved one (--project)
    VerifyToken {
        #[arg(long)]
        project: Option<String>,
        #[command(flatten)]
        token: TokenArgs,
    },
    /// Print a project's token
    Token { project: String },
    /// Show the settings, or change some: opmd settings concurrency=6 language=en
    Settings {
        #[arg(value_name = "KEY=VALUE")]
        changes: Vec<String>,
    },
    /// Jobs running, speed and totals
    Status,
    /// Where the data is
    Info,
}

#[derive(Args)]
struct TokenArgs {
    /// The On Page API token (stays in the shell's history: prefer --token-stdin or --token-env)
    #[arg(long, conflicts_with_all = ["token_stdin", "token_env"])]
    token: Option<String>,
    /// Read the token from the standard input
    #[arg(long, conflicts_with = "token_env")]
    token_stdin: bool,
    /// Read the token from this environment variable
    #[arg(long, value_name = "VAR")]
    token_env: Option<String>,
}

#[derive(Args)]
struct WaitArgs {
    /// Stop following the job after this many seconds (it goes on only where the app runs it)
    #[arg(long, value_name = "SECONDS")]
    timeout: Option<u64>,
}

#[derive(Args)]
struct PageArgs {
    #[arg(long, default_value_t = 0)]
    offset: u64,
    #[arg(long, default_value_t = 50)]
    limit: u64,
}

fn main() {
    let cli = Cli::parse();
    let paths = match &cli.data_dir {
        Some(dir) => AppPaths::at(dir.clone()),
        None => AppPaths::resolve(cfg!(debug_assertions)),
    };
    op_media_projects::log::quiet_console();
    op_media_projects::log::init_named(&paths.logs, "opmd.log");
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => fail(&format!("cannot start: {error}")),
    };
    let code = runtime.block_on(run(cli, paths));
    op_media_projects::log::flush();
    // The service's own runtime and threads end with the process
    std::process::exit(code);
}

async fn run(cli: Cli, paths: AppPaths) -> i32 {
    if let Command::Info = cli.command {
        return info(&cli, &paths);
    }
    let backend = match Backend::open(paths) {
        Ok(backend) => backend,
        Err(error) => fail(&error),
    };
    match execute(&cli, &backend).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("opmd: {}", error_message(&error));
            FAILED
        }
    }
}

async fn execute(cli: &Cli, backend: &Backend) -> Result<i32, String> {
    let print = |value: &Value, human: &dyn Fn(&Value) -> String| {
        if cli.json {
            println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
        } else {
            println!("{}", human(value));
        }
    };
    match &cli.command {
        Command::List => print(&backend.call("list_projects", json!({})).await?, &render::projects),
        Command::Show { project } => {
            print(&backend.call("get_project", json!({ "project": project })).await?, &render::project)
        }
        Command::Add { label, folder, token, keep_old_files, sync } => {
            let token = read_token(token, true)?.unwrap_or_default();
            let args =
                json!({ "label": label, "folder": absolute(folder), "token": token, "keep_old_files": keep_old_files });
            let created = backend.call("create_project", args).await?;
            if !cli.json {
                println!(
                    "Added {} ({})",
                    created["label"].as_str().unwrap_or(""),
                    created["id"].as_str().unwrap_or("")
                );
            }
            if *sync {
                let id = created["id"].as_str().unwrap_or("").to_string();
                return job(cli, backend, &id, "sync_project", json!({}), &WaitArgs { timeout: None }).await;
            }
            if cli.json {
                print(&created, &render::project);
            }
        }
        Command::Edit { project, label, folder, token, keep_old_files } => {
            let mut args = Map::new();
            args.insert("project".into(), json!(project));
            if let Some(label) = label {
                args.insert("label".into(), json!(label));
            }
            if let Some(folder) = folder {
                args.insert("folder".into(), json!(absolute(folder)));
            }
            if let Some(token) = read_token(token, false)? {
                args.insert("token".into(), json!(token));
            }
            if let Some(keep) = keep_old_files {
                args.insert("keep_old_files".into(), json!(keep));
            }
            print(&backend.call("update_project", Value::Object(args)).await?, &render::project);
        }
        Command::Remove { project, delete_files, yes } => {
            let view = backend.call("get_project", json!({ "project": project })).await?;
            let label = view["label"].as_str().unwrap_or("");
            if *delete_files {
                confirm(
                    *yes,
                    &format!(
                        "Remove {label} and delete the files the app downloaded in {}?",
                        view["folder"].as_str().unwrap_or("")
                    ),
                )?;
            }
            backend.call("remove_project", json!({ "project": view["id"], "delete_files": delete_files })).await?;
            if !cli.json {
                println!("Removed {label}{}", if *delete_files { ": its files are being deleted" } else { "" });
            }
            if *delete_files && backend.runs_jobs_here() {
                // The deletion runs in the background of this process: it ends with it
                wait_deletions(backend).await;
            }
        }
        Command::Sync { project, all, full, take_over_folder, wait } => {
            if *all {
                return sync_all(cli, backend, wait).await;
            }
            let args = json!({ "full_listing": full, "take_over_folder": take_over_folder });
            return job(cli, backend, project.as_deref().unwrap_or(""), "sync_project", args, wait).await;
        }
        Command::Download { project, wait } => {
            return job(cli, backend, project, "download_project", json!({}), wait).await;
        }
        Command::Retry { project, wait } => return job(cli, backend, project, "retry_failed", json!({}), wait).await,
        Command::Cleanup { project, yes, wait } => {
            let view = backend.call("get_project", json!({ "project": project })).await?;
            let removals = view["runtime"]["plan"]["to_remove"].as_u64().unwrap_or(0);
            confirm(
                *yes,
                &format!(
                    "Delete from {} the {removals} files On Page no longer has?",
                    view["folder"].as_str().unwrap_or("")
                ),
            )?;
            return job(cli, backend, project, "confirm_cleanup", json!({}), wait).await;
        }
        Command::Stop { project } => {
            backend.call("stop_project", json!({ "project": project })).await?;
            if !cli.json {
                println!("Stopping");
            }
        }
        Command::Activity { project, limit } => print(
            &backend.call("get_activity", json!({ "project": project, "limit": limit })).await?,
            &render::activity,
        ),
        Command::Failed { project, page } => print(
            &backend
                .call("get_failed_files", json!({ "project": project, "offset": page.offset, "limit": page.limit }))
                .await?,
            &render::failed,
        ),
        Command::Duplicates { project, search, name, page } => match name {
            Some(name) => {
                let args = json!({ "project": project, "name": name, "offset": page.offset, "limit": page.limit });
                print(&backend.call("get_duplicate_files", args).await?, &|files| {
                    let mut out = render::variants(&files["variants"]);
                    let more = files["more_variants"].as_u64().unwrap_or(0);
                    if more > 0 {
                        out.push(format!(
                            "… and {} more (--offset {})",
                            render::number(more),
                            page.offset + page.limit
                        ));
                    }
                    out.join("\n")
                });
            }
            None => {
                let args = json!({ "project": project, "query": search, "offset": page.offset, "limit": page.limit });
                print(&backend.call("get_duplicates", args).await?, &render::duplicates);
            }
        },
        Command::Inspect { folder, project } => {
            let args = json!({ "folder": absolute(folder), "project": project });
            print(&backend.call("inspect_folder", args).await?, &render::folder);
        }
        Command::VerifyToken { project, token } => {
            let check = match project {
                Some(project) => backend.call("verify_project_token", json!({ "project": project })).await?,
                None => backend.call("verify_token", json!({ "token": read_token(token, true)? })).await?,
            };
            print(&check, &render::token_check);
            if check["ok"] != Value::Bool(true) {
                return Ok(FAILED);
            }
        }
        Command::Token { project } => println!("{}", backend.reveal_token(project)?),
        Command::Settings { changes } => {
            let settings = if changes.is_empty() {
                backend.call("get_settings", json!({})).await?
            } else {
                backend.call("update_settings", settings_patch(changes)?).await?
            };
            print(&settings, &render::settings);
        }
        Command::Status => print(&backend.call("get_status", json!({})).await?, &render::status),
        Command::Info => unreachable!("answered before the projects are opened"),
    }
    Ok(OK)
}

/// Starts a job and follows it to its end, printing its progress; Ctrl+C stops it
async fn job(
    cli: &Cli,
    backend: &Backend,
    project: &str,
    operation: &str,
    extra: Value,
    wait: &WaitArgs,
) -> Result<i32, String> {
    let view = backend.call("get_project", json!({ "project": project })).await?;
    let id = view["id"].as_str().unwrap_or("").to_string();
    let before = view["runtime"]["last_result"]["ended_at"].clone();
    let mut args = extra.as_object().cloned().unwrap_or_default();
    args.insert("project".into(), json!(id));
    backend.call(operation, Value::Object(args)).await?;
    let (end, interrupted) = follow(backend, &[id], wait).await?;
    let Some(end) = end.into_iter().next() else { return Ok(FAILED) };
    // A «Sincronizza» that finds files to download ends with a plan, not with a result
    let ended = end["runtime"]["last_result"]["ended_at"] != before;
    let label = end["label"].as_str().unwrap_or("");
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&end).unwrap_or_default());
    } else if end["runtime"]["phase"] != "idle" {
        println!("{label}: still running ({})", render::progress_line(&end["runtime"]));
    } else if ended {
        println!("{label}: {}", render::result_line(&end["runtime"]["last_result"]));
        // Kept by the process that ran the job only: shown now, while they are here
        if end["runtime"]["last_result"]["failed"].as_u64().unwrap_or(0) > 0 {
            let failed = backend.call("get_failed_files", json!({ "project": end["id"], "limit": 20 })).await?;
            println!("{}", render::failed(&failed));
        }
    } else {
        println!("{label}: {}", render::state(&end));
    }
    Ok(exit_code(&end, ended, interrupted))
}

async fn sync_all(cli: &Cli, backend: &Backend, wait: &WaitArgs) -> Result<i32, String> {
    backend.call("sync_all", json!({})).await?;
    let ids: Vec<String> = backend
        .call("list_projects", json!({}))
        .await?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["id"].as_str().map(str::to_string))
        .collect();
    let (ends, interrupted) = follow(backend, &ids, wait).await?;
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&ends).unwrap_or_default());
    } else {
        println!("{}", render::projects(&Value::Array(ends.clone())));
    }
    Ok(ends.iter().map(|end| exit_code(end, true, interrupted)).max().unwrap_or(OK))
}

/// Polls the projects until their jobs end (or the timeout): their last views,
/// and whether the user stopped them with Ctrl+C
async fn follow(backend: &Backend, ids: &[String], wait: &WaitArgs) -> Result<(Vec<Value>, bool), String> {
    let tty = std::io::stderr().is_terminal();
    let deadline = wait.timeout.map(|seconds| tokio::time::Instant::now() + Duration::from_secs(seconds));
    let mut ctrl_c = std::pin::pin!(tokio::signal::ctrl_c());
    let mut interrupted = false;
    let mut last_line = String::new();
    let mut last_print = tokio::time::Instant::now();
    loop {
        let mut views = Vec::new();
        for id in ids {
            views.push(backend.call("get_project", json!({ "project": id })).await?);
        }
        let running: Vec<&Value> = views.iter().filter(|v| v["runtime"]["phase"] != "idle").collect();
        if running.is_empty() {
            if tty && !last_line.is_empty() {
                eprint!("\r{}\r", " ".repeat(last_line.chars().count()));
            }
            return Ok((views, interrupted));
        }
        if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) && !backend.runs_jobs_here() {
            return Ok((views, interrupted));
        }
        let line = running
            .iter()
            .map(|v| format!("{}: {}", v["label"].as_str().unwrap_or(""), render::progress_line(&v["runtime"])))
            .collect::<Vec<_>>()
            .join(" | ");
        if tty {
            let width = last_line.chars().count().max(line.chars().count());
            eprint!("\r{line:<width$}");
            let _ = std::io::stderr().flush();
        } else if line != last_line && last_print.elapsed() >= Duration::from_secs(5) {
            eprintln!("{line}");
            last_print = tokio::time::Instant::now();
        }
        last_line = line;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            _ = &mut ctrl_c, if !interrupted => {
                interrupted = true;
                eprintln!("\nStopping (what is done stays done)…");
                for id in ids {
                    let _ = backend.call("stop_project", json!({ "project": id })).await;
                }
            }
        }
    }
}

/// A removed project's files are deleted in the background: this process waits for it
async fn wait_deletions(backend: &Backend) {
    for _ in 0..3600 {
        let status = backend.call("get_status", json!({})).await.unwrap_or_default();
        if status["deleting"] != Value::Bool(true) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// `ended`: the job left a result (a «Sincronizza» with files to download leaves a plan only)
fn exit_code(end: &Value, ended: bool, interrupted: bool) -> i32 {
    let runtime = &end["runtime"];
    let error = runtime["issues"].as_array().into_iter().flatten().any(|issue| issue["severity"] == "error");
    let result = &runtime["last_result"];
    match result["outcome"].as_str() {
        _ if interrupted => INTERRUPTED,
        _ if runtime["phase"] != "idle" => OK,
        _ if !ended => {
            if error {
                FAILED
            } else {
                OK
            }
        }
        Some("completed") if result["failed"].as_u64().unwrap_or(0) > 0 => PARTIAL,
        Some("completed") => OK,
        _ => FAILED,
    }
}

/// The token from the option, the environment, the standard input or, at a
/// terminal, asked without showing it. None when not given and not required
fn read_token(args: &TokenArgs, required: bool) -> Result<Option<String>, String> {
    let token = if let Some(token) = &args.token {
        Some(token.clone())
    } else if let Some(name) = &args.token_env {
        Some(std::env::var(name).map_err(|_| format!("invalid_input: the environment variable {name} is not set"))?)
    } else if args.token_stdin {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).map_err(|error| format!("invalid_input: {error}"))?;
        Some(line)
    } else if required && std::io::stdin().is_terminal() {
        Some(rpassword::prompt_password("On Page API token: ").map_err(|error| format!("invalid_input: {error}"))?)
    } else if required {
        return Err("invalid_input: give the token with --token-stdin or --token-env".into());
    } else {
        None
    };
    Ok(token.map(|token| token.trim().to_string()).filter(|token| !token.is_empty()))
}

/// `key=value` pairs as the settings patch: numbers and true/false as such, words as strings
fn settings_patch(changes: &[String]) -> Result<Value, String> {
    let mut patch = Map::new();
    for change in changes {
        let Some((key, value)) = change.split_once('=') else {
            return Err(format!("invalid_input: {change} is not KEY=VALUE"));
        };
        let value = match value {
            "true" => json!(true),
            "false" => json!(false),
            number if number.parse::<u64>().is_ok() => json!(number.parse::<u64>().unwrap_or(0)),
            text => json!(text),
        };
        patch.insert(key.trim().to_string(), value);
    }
    Ok(Value::Object(patch))
}

fn confirm(yes: bool, question: &str) -> Result<(), String> {
    if yes {
        return Ok(());
    }
    if !std::io::stdin().is_terminal() {
        return Err("invalid_input: add --yes to confirm".into());
    }
    eprint!("{question} [y/N] ");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    if matches!(answer.trim().to_lowercase().as_str(), "y" | "yes" | "s" | "si" | "sì") {
        Ok(())
    } else {
        Err("cancelled".into())
    }
}

/// Folders as absolute paths: the projects keep them so
fn absolute(path: &std::path::Path) -> String {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()).display().to_string()
}

fn info(cli: &Cli, paths: &AppPaths) -> i32 {
    let data = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "data_dir": paths.data.display().to_string(),
        "own_data": cli.data_dir.is_some(),
        "log": paths.logs.join("opmd.log").display().to_string(),
    });
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&data).unwrap_or_default());
    } else {
        println!("opmd {}", env!("CARGO_PKG_VERSION"));
        println!(
            "Data:  {}{}",
            paths.data.display(),
            if cli.data_dir.is_some() { " (its own)" } else { " (the app's)" }
        );
        println!("Log:   {}", paths.logs.join("opmd.log").display());
    }
    OK
}

fn fail(message: &str) -> ! {
    eprintln!("opmd: {message}");
    op_media_projects::log::flush();
    std::process::exit(FAILED)
}
