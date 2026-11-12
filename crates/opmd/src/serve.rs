//! `opmd run`: keeps every project up to date, round after round, until the
//! user or the system stops it (`stop`). A round brings every project up to
//! date (`update_all`): what changed on On Page is listed, what the folder
//! lacks is downloaded, renames and removals within the safety limit are
//! applied, and the files that failed before are tried again. Nothing stops the rounds but
//! a stop: On Page out of reach, a folder that does not answer, a project
//! removed meanwhile are written in the log and the next round tries again.
//! Large removals still wait for a person (`opmd cleanup`): each round says so.
//!
//! With `--listen` On Page's webhooks bring a project up to date as soon as
//! its files change (`webhook`), and the rounds become a safety net for the
//! calls that never came (opmd down, On Page not calling again).
//!
//! One `opmd run` per data folder (a lock in it): two would race for the same
//! projects. With the app open on the same data the jobs run in the app.

use std::fs::File;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use op_media_projects::ops::error_message;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::backend::Backend;
use crate::webhook::{self, Pending};
use crate::{FAILED, OK, WaitArgs, render, stop, update_projects};

/// The shortest interval: each round asks On Page about every project, and
/// media change seldom; a round every few minutes would only load On Page
const SHORTEST: Duration = Duration::from_secs(15 * 60);

/// `15m`, `2h`, `1d`; at least 15 minutes (development builds take less, for the tests)
pub fn parse_every(text: &str) -> Result<Duration, String> {
    let every = parse_duration(text)?;
    if every < SHORTEST && !cfg!(debug_assertions) {
        return Err("the interval is at least 15m: each round asks On Page about every project".into());
    }
    Ok(every)
}

/// `45s`, `2m`…: more than zero
pub fn parse_duration(text: &str) -> Result<Duration, String> {
    let text = text.trim();
    let split = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let number: u64 = number.parse().map_err(|_| format!("«{text}» is not a duration like 30m, 2h or 1d"))?;
    let seconds = match unit.trim() {
        "s" => number,
        "m" => number * 60,
        "h" => number * 3600,
        "d" => number * 86_400,
        _ => return Err(format!("«{text}» is not a duration like 30m, 2h or 1d")),
    };
    if seconds == 0 {
        return Err("the duration is more than zero".into());
    }
    Ok(Duration::from_secs(seconds))
}

/// `47822` (this computer only: a proxy in front, on this server) or
/// `0.0.0.0:47822` (every interface: a container, a proxy on another machine)
pub fn parse_listen(text: &str) -> Result<SocketAddr, String> {
    let text = text.trim();
    if let Ok(port) = text.parse::<u16>() {
        return Ok(SocketAddr::from(([127, 0, 0, 1], port)));
    }
    text.parse().map_err(|_| format!("«{text}» is not a port or an ADDRESS:PORT like 127.0.0.1:47822"))
}

/// What `opmd run --listen` listens on, and how long the calls must stop before the sync
pub struct Listen {
    pub address: SocketAddr,
    pub quiet: Duration,
}

/// A duration as the log says it: 45s, 30m, 1h 30m
pub fn words(duration: Duration) -> String {
    let seconds = duration.as_secs();
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m", seconds / 60),
        _ if seconds.is_multiple_of(86_400) => format!("{}d", seconds / 86_400),
        _ if seconds.is_multiple_of(3600) => format!("{}h", seconds / 3600),
        _ => format!("{}h {}m", seconds / 3600, seconds % 3600 / 60),
    }
}

/// The rounds, and On Page's calls in between, until a stop (or `rounds`
/// rounds). The exit code: 0 after a stop, 1 when it cannot start
pub async fn serve(
    backend: &Backend,
    data_dir: &Path,
    every: Duration,
    rounds: Option<u32>,
    listen: Option<Listen>,
) -> i32 {
    let Some(_lock) = one_runner(data_dir) else {
        eprintln!("opmd: another `opmd run` is keeping this data folder up to date ({})", data_dir.display());
        return FAILED;
    };
    stop::listen();
    let pending = Arc::new(Pending::new(listen.as_ref().map_or(Duration::from_secs(30), |listen| listen.quiet)));
    if let Some(listen) = &listen {
        if let Err(error) = webhook::secret(data_dir, false) {
            eprintln!("opmd: {error}");
            return FAILED;
        }
        match webhook::listen(listen.address, data_dir.to_path_buf(), pending.clone()).await {
            // The secret stays out of the log: `opmd webhook` prints the URL
            Ok(bound) => say(&format!(
                "Listening for On Page's calls on http://{bound}{}… (opmd webhook prints the URL to give On Page)",
                webhook::PREFIX
            )),
            Err(error) => {
                eprintln!("opmd: cannot listen on {}: {error}", listen.address);
                return FAILED;
            }
        }
    }
    say(&format!(
        "Keeping every project up to date every {}{}; Ctrl+C or a stop of the service ends it",
        words(every),
        if listen.is_some() { " and when On Page calls" } else { "" }
    ));
    let mut round = 0u32;
    let mut next_round = Instant::now();
    while !stop::is_stopped() {
        let due = pending.due();
        tokio::select! {
            _ = tokio::time::sleep_until(next_round) => {
                round += 1;
                // The round brings every project up to date: the calls before it are answered
                pending.clear();
                let started = Instant::now();
                match update(backend, None).await {
                    Ok(lines) => report(lines),
                    Err(error) => warn(&format!(
                        "Round {round} ended early: {} (the next round tries again)",
                        error_message(&error)
                    )),
                }
                if stop::is_stopped() || rounds.is_some_and(|rounds| round >= rounds) {
                    say(&format!("Round {round} done"));
                    break;
                }
                next_round = started + every;
                let wait = next_round.saturating_duration_since(Instant::now());
                say(&format!("Round {round} done in {}; the next in {}", words(started.elapsed()), words(wait)));
            }
            _ = tokio::time::sleep_until(due.unwrap_or(next_round)), if due.is_some() => {
                let schemas = pending.take_due(Instant::now());
                if !schemas.is_empty() {
                    on_calls(backend, &pending, &schemas).await;
                }
            }
            // A call: when the calls settle is reckoned again
            _ = pending.rung() => {}
            _ = stop::stopped() => {}
        }
    }
    say("Stopped");
    OK
}

/// The projects On Page called for, brought up to date. A project busy with
/// a job that started before the call (the app's, another round's) is synced
/// once more after it; a failure tries again once the calls settle again
async fn on_calls(backend: &Backend, pending: &Pending, schemas: &[Option<i64>]) {
    let started = Instant::now();
    let unlogged = pending.take_unlogged();
    if unlogged > 0 {
        warn(&format!("{unlogged} more calls came, not written one by one (more than 20 a minute)"));
    }
    let projects = match backend.call("list_projects", json!({})).await {
        Ok(projects) => projects,
        Err(error) => {
            warn(&format!("On Page's call is not answered yet: {} (tried again soon)", error_message(&error)));
            schemas.iter().for_each(|schema| pending.ring(*schema));
            return;
        }
    };
    let ids = webhook::projects_for(&projects, schemas);
    if ids.is_empty() {
        let mut named: Vec<String> = schemas.iter().flatten().take(5).map(i64::to_string).collect();
        if schemas.len() > named.len() {
            named.push(format!("{} more", schemas.len() - named.len()));
        }
        say(&format!("No project here downloads On Page project {}: nothing to sync", named.join(", ")));
        return;
    }
    let chosen: Vec<&Value> = projects
        .as_array()
        .into_iter()
        .flatten()
        .filter(|project| project["id"].as_str().is_some_and(|id| ids.iter().any(|chosen| chosen == id)))
        .collect();
    let labels: Vec<&str> = chosen.iter().filter_map(|project| project["label"].as_str()).collect();
    say(&format!("Syncing what changed on On Page: {}", labels.join(", ")));
    let busy: Vec<Option<i64>> = chosen
        .iter()
        .filter(|project| project["runtime"]["phase"] != "idle")
        .map(|project| project["onpage_project"]["id"].as_i64())
        .collect();
    match update(backend, Some(&ids)).await {
        Ok(lines) => report(lines),
        Err(error) => {
            warn(&format!("The sync On Page asked for ended early: {} (tried again soon)", error_message(&error)));
            schemas.iter().for_each(|schema| pending.ring(*schema));
        }
    }
    busy.into_iter().for_each(|schema| pending.ring(schema));
    say(&format!("Done in {}", words(started.elapsed())));
}

fn report(lines: Vec<(String, bool)>) {
    for (line, warning) in lines {
        if warning { warn(&line) } else { say(&line) }
    }
}

/// These projects (`None`: every one) up to date: a line each, and the warnings of those that need a person
async fn update(backend: &Backend, only: Option<&[String]>) -> Result<Vec<(String, bool)>, String> {
    let (ends, _) = update_projects(backend, only, &WaitArgs { timeout: None }).await?;
    if ends.is_empty() {
        return Ok(vec![("No projects: add one with opmd add".into(), false)]);
    }
    let mut lines = Vec::new();
    for (end, ended) in &ends {
        let label = end["label"].as_str().unwrap_or("");
        let what = if *ended { render::result_line(&end["runtime"]["last_result"]) } else { render::state(end) };
        lines.push((format!("{label}: {what}"), false));
        if let Some(attention) = attention(end) {
            lines.push((format!("{label}: {attention}"), true));
        }
    }
    Ok(lines)
}

/// What a person must do for a project, when the rounds cannot
fn attention(project: &Value) -> Option<String> {
    let runtime = &project["runtime"];
    let issues: Vec<&Value> = runtime["issues"].as_array().into_iter().flatten().collect();
    if let Some(cleanup) = issues.iter().find(|issue| issue["code"] == "cleanup_needs_confirmation") {
        let count = cleanup.get("count").and_then(Value::as_u64).map(render::number).unwrap_or_default();
        let label = project["label"].as_str().unwrap_or("");
        return Some(format!(
            "{count} files On Page no longer has wait for a confirmation: opmd cleanup \"{label}\" --yes"
        ));
    }
    issues.iter().find(|issue| issue["severity"] == "error").map(|issue| {
        let detail = issue.get("detail").and_then(Value::as_str).map(|d| format!(" ({d})")).unwrap_or_default();
        format!("needs attention: {}{detail}", error_message(issue["code"].as_str().unwrap_or("unexpected")))
    })
}

/// The lock that keeps a second `opmd run` off this data folder (released when the process ends)
fn one_runner(data_dir: &Path) -> Option<File> {
    std::fs::create_dir_all(data_dir).ok()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("opmd-run.lock"))
        .ok()?;
    file.try_lock().ok()?;
    Some(file)
}

pub fn say(line: &str) {
    println!("{} {line}", op_media_service::now_iso());
    op_media_projects::info!("{line}");
}

fn warn(line: &str) {
    println!("{} WARNING {line}", op_media_service::now_iso());
    op_media_projects::warn!("{line}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals_read_as_people_write_them() {
        assert_eq!(parse_every("30m"), Ok(Duration::from_secs(1800)));
        assert_eq!(parse_every(" 2h "), Ok(Duration::from_secs(7200)));
        assert_eq!(parse_every("1d"), Ok(Duration::from_secs(86_400)));
        assert!(parse_every("30").is_err());
        assert!(parse_every("m").is_err());
        assert!(parse_every("5x").is_err());
        assert!(parse_every("0m").is_err());
        assert_eq!(parse_duration("45s"), Ok(Duration::from_secs(45)));
        assert_eq!(parse_listen("47822"), Ok(SocketAddr::from(([127, 0, 0, 1], 47822))));
        assert_eq!(parse_listen("0.0.0.0:47822"), Ok(SocketAddr::from(([0, 0, 0, 0], 47822))));
        assert_eq!(parse_listen("127.0.0.1:47822"), Ok(SocketAddr::from(([127, 0, 0, 1], 47822))));
        assert_eq!(parse_listen("[::1]:80").map(|a| a.is_ipv6()), Ok(true));
        assert!(parse_listen("localhost").is_err());
        assert_eq!(words(Duration::from_secs(5400)), "1h 30m");
        assert_eq!(words(Duration::from_secs(7200)), "2h");
        assert_eq!(words(Duration::from_secs(86_400)), "1d");
        assert_eq!(words(Duration::from_secs(90_000)), "25h");
        assert_eq!(words(Duration::from_secs(45)), "45s");
    }

    #[test]
    fn a_second_runner_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let first = one_runner(dir.path());
        assert!(first.is_some());
        assert!(one_runner(dir.path()).is_none());
        drop(first);
        assert!(one_runner(dir.path()).is_some());
    }
}
