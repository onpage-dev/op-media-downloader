//! `opmd run`: keeps every project up to date, round after round, until the
//! user or the system stops it (`stop`). A round brings every project up to
//! date (`update_all`): what changed on On Page is listed, what the folder
//! lacks is downloaded, renames and removals within the safety limit are
//! applied, and the files that failed before are tried again. Nothing stops the rounds but
//! a stop: On Page out of reach, a folder that does not answer, a project
//! removed meanwhile are written in the log and the next round tries again.
//! Large removals still wait for a person (`opmd cleanup`): each round says so.
//!
//! One `opmd run` per data folder (a lock in it): two would race for the same
//! projects. With the app open on the same data the rounds run in the app.

use std::fs::File;
use std::path::Path;
use std::time::Duration;

use op_media_projects::ops::error_message;
use serde_json::Value;

use crate::backend::Backend;
use crate::{FAILED, OK, WaitArgs, render, stop, update_all};

/// The shortest interval: On Page is asked about every project each round
const SHORTEST: Duration = Duration::from_secs(60);

/// `30s`, `15m`, `2h`, `1d`; at least a minute (development builds take less, for the tests)
pub fn parse_every(text: &str) -> Result<Duration, String> {
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
    let every = Duration::from_secs(seconds);
    if every.is_zero() || (every < SHORTEST && !cfg!(debug_assertions)) {
        return Err("the interval is at least 1m: On Page is asked about every project at each round".into());
    }
    Ok(every)
}

/// A duration as the log says it: 45s, 30m, 1h 30m
pub fn words(duration: Duration) -> String {
    let seconds = duration.as_secs();
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m", seconds / 60),
        _ if seconds.is_multiple_of(3600) => format!("{}h", seconds / 3600),
        _ => format!("{}h {}m", seconds / 3600, seconds % 3600 / 60),
    }
}

/// The rounds, until a stop (or `rounds` of them). The exit code: 0 after a stop, 1 when it cannot start
pub async fn serve(backend: &Backend, data_dir: &Path, every: Duration, rounds: Option<u32>) -> i32 {
    let Some(_lock) = one_runner(data_dir) else {
        eprintln!("opmd: another `opmd run` is keeping this data folder up to date ({})", data_dir.display());
        return FAILED;
    };
    stop::listen();
    say(&format!("Keeping every project up to date every {}; Ctrl+C or a stop of the service ends it", words(every)));
    let mut round = 0u32;
    while !stop::is_stopped() {
        round += 1;
        let started = tokio::time::Instant::now();
        match one_round(backend).await {
            Ok(lines) => {
                for (line, warning) in lines {
                    if warning { warn(&line) } else { say(&line) }
                }
            }
            Err(error) => {
                warn(&format!("Round {round} ended early: {} (the next round tries again)", error_message(&error)))
            }
        }
        if stop::is_stopped() || rounds.is_some_and(|rounds| round >= rounds) {
            say(&format!("Round {round} done"));
            break;
        }
        let next = started + every;
        let wait = next.saturating_duration_since(tokio::time::Instant::now());
        say(&format!("Round {round} done in {}; the next in {}", words(started.elapsed()), words(wait)));
        tokio::select! {
            _ = tokio::time::sleep_until(next) => {}
            _ = stop::stopped() => {}
        }
    }
    say("Stopped");
    OK
}

/// Every project up to date: a line each, and the warnings of those that need a person
async fn one_round(backend: &Backend) -> Result<Vec<(String, bool)>, String> {
    let (ends, _) = update_all(backend, &WaitArgs { timeout: None }).await?;
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

fn say(line: &str) {
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
        assert_eq!(words(Duration::from_secs(5400)), "1h 30m");
        assert_eq!(words(Duration::from_secs(7200)), "2h");
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
