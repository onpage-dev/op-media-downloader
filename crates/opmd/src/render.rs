//! What `opmd` prints: the answers of the operations (JSON, the same the
//! app's window gets) as short lines and tables for a person. `--json`
//! prints them as they are instead.

use serde_json::Value;

pub fn number(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn bytes(value: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut size = value as f64;
    let mut unit = 0;
    while size >= 1000.0 && unit < UNITS.len() - 1 {
        size /= 1000.0;
        unit += 1;
    }
    if unit == 0 { format!("{value} B") } else { format!("{size:.1} {}", UNITS[unit]) }
}

fn duration(seconds: u64) -> String {
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m {:02}s", seconds / 60, seconds % 60),
        _ => format!("{}h {:02}m", seconds / 3600, seconds % 3600 / 60),
    }
}

fn u(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// One project's state in a few words, as the app's table says it
pub fn state(project: &Value) -> String {
    let runtime = &project["runtime"];
    let phase = s(runtime, "phase");
    if phase != "idle" && !phase.is_empty() {
        return progress_line(runtime);
    }
    // In the app's order: errors, removals to confirm, files to download, warnings
    let issues: Vec<&Value> = runtime["issues"].as_array().into_iter().flatten().collect();
    let words = |issue: &Value| match issue.get("count").and_then(Value::as_u64) {
        Some(count) => format!("{} ({})", s(issue, "code").replace('_', " "), number(count)),
        None => s(issue, "code").replace('_', " "),
    };
    if let Some(error) = issues.iter().find(|issue| s(issue, "severity") == "error") {
        return words(error);
    }
    if let Some(cleanup) = issues.iter().find(|issue| s(issue, "code") == "cleanup_needs_confirmation") {
        return words(cleanup);
    }
    let plan = &runtime["plan"];
    if u(plan, "to_download_names") > 0 {
        return format!("{} files to download", number(u(plan, "to_download_names")));
    }
    if let Some(warning) = issues.iter().find(|issue| s(issue, "severity") == "warning") {
        return words(warning);
    }
    match runtime["last_result"].get("outcome").and_then(Value::as_str) {
        Some("completed") => "up to date".into(),
        Some(outcome) => format!("last job {outcome}"),
        None => "never synced".into(),
    }
}

/// What a running job is doing: its phase, and how far it got
pub fn progress_line(runtime: &Value) -> String {
    let phase = s(runtime, "phase");
    let job = s(runtime, "job").replace('_', " ");
    let progress = &runtime["progress"];
    let mut line = format!("{job}: {phase}");
    if phase == "listing" {
        let listing = &progress["listing"];
        if listing.is_object() {
            line += &format!(" {} items read", number(u(listing, "things_read")));
        }
    } else if progress.is_object() && u(progress, "total") > 0 {
        let done = u(progress, "downloaded") + u(progress, "linked") + u(progress, "removed") + u(progress, "failed");
        line += &format!(" {}/{}", number(done), number(u(progress, "total")));
        if u(progress, "bytes_total") > 0 {
            line += &format!(" ({} of {})", bytes(u(progress, "bytes_done")), bytes(u(progress, "bytes_total")));
        }
        let speed = progress["speed_bps"].as_f64().unwrap_or(0.0);
        if speed > 0.0 {
            line += &format!(", {}/s", bytes(speed as u64));
        }
        if let Some(eta) = progress.get("eta_seconds").and_then(Value::as_u64) {
            line += &format!(", {} left", duration(eta));
        }
        if u(progress, "failed") > 0 {
            line += &format!(", {} failed", number(u(progress, "failed")));
        }
    }
    line
}

/// Rows of columns, each as wide as its longest cell
pub fn table(header: &[&str], rows: &[Vec<String>]) -> String {
    let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    let line = |cells: Vec<String>| {
        let last = cells.len() - 1;
        cells
            .into_iter()
            .enumerate()
            .map(|(i, cell)| if i == last { cell } else { format!("{cell:<width$}", width = widths[i]) })
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut out = vec![line(header.iter().map(|h| h.to_string()).collect())];
    out.extend(rows.iter().map(|row| line(row.clone())));
    out.join("\n")
}

pub fn projects(list: &Value) -> String {
    let projects = list.as_array().cloned().unwrap_or_default();
    if projects.is_empty() {
        return "No projects. Add one with: opmd add --label NAME --folder PATH".into();
    }
    let rows: Vec<Vec<String>> = projects
        .iter()
        .map(|p| vec![s(p, "label").to_string(), state(p), s(p, "folder").to_string(), s(p, "id").to_string()])
        .collect();
    table(&["NAME", "STATE", "FOLDER", "ID"], &rows)
}

pub fn project(p: &Value) -> String {
    let runtime = &p["runtime"];
    let mut out = vec![
        format!("{}  ({})", s(p, "label"), s(p, "id")),
        format!("  Folder:      {}", s(p, "folder")),
        format!("  State:       {}", state(p)),
    ];
    if let Some(onpage) = p.get("onpage_project").filter(|o| o.is_object()) {
        out.push(format!("  On Page:     {} (#{})", s(onpage, "label"), u(onpage, "id")));
    }
    if p["keep_old_files"] == Value::Bool(true) {
        out.push("  Keeps the files On Page no longer has".into());
    }
    if !p["has_token"].as_bool().unwrap_or(false) {
        out.push("  No token here: set it with opmd edit PROJECT --token-stdin".into());
    }
    let plan = &runtime["plan"];
    if plan.is_object() {
        out.push(format!(
            "  Last sync:   {} names on On Page ({}): {} to download ({}), {} to link, {} to remove, {} up to date",
            number(u(plan, "remote_names")),
            bytes(u(plan, "remote_bytes")),
            number(u(plan, "to_download_names")),
            bytes(u(plan, "to_download_bytes")),
            number(u(plan, "to_link")),
            number(u(plan, "to_remove")),
            number(u(plan, "up_to_date")),
        ));
    }
    let result = &runtime["last_result"];
    if result.is_object() {
        out.push(format!("  Last job:    {}", result_line(result)));
    }
    for issue in runtime["issues"].as_array().into_iter().flatten() {
        let count = issue.get("count").and_then(Value::as_u64).map(|n| format!(" ({})", number(n))).unwrap_or_default();
        let detail = issue.get("detail").and_then(Value::as_str).map(|d| format!(": {d}")).unwrap_or_default();
        out.push(format!("  {:<12} {}{count}{detail}", format!("{}:", s(issue, "severity")), s(issue, "code")));
    }
    out.join("\n")
}

/// How a job ended, in a line
pub fn result_line(result: &Value) -> String {
    let mut line = format!(
        "{} {} at {}: {} downloaded, {} linked, {} removed",
        s(result, "job").replace('_', " "),
        s(result, "outcome"),
        s(result, "ended_at"),
        number(u(result, "downloaded")),
        number(u(result, "linked")),
        number(u(result, "removed")),
    );
    if u(result, "failed") > 0 {
        line += &format!(", {} failed", number(u(result, "failed")));
    }
    if let Some(error) = result.get("error").filter(|e| e.is_object()) {
        line += &format!(" ({})", s(error, "code"));
    }
    line
}

pub fn activity(entries: &Value) -> String {
    let rows: Vec<Vec<String>> = entries
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| {
            let note = e.get("reason").and_then(Value::as_str).or(e.get("same_as").and_then(Value::as_str));
            vec![
                s(e, "at").to_string(),
                s(e, "outcome").to_string(),
                s(e, "name").to_string(),
                note.unwrap_or("").to_string(),
            ]
        })
        .collect();
    if rows.is_empty() {
        "No activity here: a job's activity stays with the process that ran it (the app, or opmd while it runs)".into()
    } else {
        table(&["AT", "WHAT", "NAME", ""], &rows)
    }
}

pub fn failed(page: &Value) -> String {
    let rows: Vec<Vec<String>> = page["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| {
            let detail = e.get("detail").and_then(Value::as_str).map(|d| format!(" ({d})")).unwrap_or_default();
            vec![s(e, "name").to_string(), format!("{}{detail}", s(e, "reason")), u(e, "attempts").to_string()]
        })
        .collect();
    if rows.is_empty() {
        return "No failed files here: they stay with the process that ran the job (opmd download lists them at its end)"
            .into();
    }
    format!("{}\n{} failed in all", table(&["NAME", "REASON", "ATTEMPTS"], &rows), number(u(page, "total")))
}

pub fn duplicates(page: &Value) -> String {
    let mut out = Vec::new();
    for group in page["groups"].as_array().into_iter().flatten() {
        out.push(s(group, "name").to_string());
        out.extend(variants(&group["variants"]));
        if u(group, "more_variants") > 0 {
            out.push(format!("    … and {} more files with this name (--name)", number(u(group, "more_variants"))));
        }
    }
    if out.is_empty() {
        return "No names with different files.".into();
    }
    out.push(format!("{} names in all", number(u(page, "total"))));
    out.join("\n")
}

pub fn variants(list: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for variant in list.as_array().into_iter().flatten() {
        let chosen = if variant["chosen"] == Value::Bool(true) { "downloaded" } else { "skipped   " };
        let size = variant.get("size").and_then(Value::as_u64).map(bytes).unwrap_or_default();
        out.push(format!("  {chosen}  {size:>9}  {}", s(variant, "token")));
        for used in variant["uses"].as_array().into_iter().flatten() {
            let label = used.get("thing_label").and_then(Value::as_str).map(|l| format!("{l} ")).unwrap_or_default();
            let lang = used.get("lang").and_then(Value::as_str).map(|l| format!(" ({l})")).unwrap_or_default();
            out.push(format!(
                "      {} › {} · {label}#{}{lang}  {}",
                s(used, "resource_label"),
                s(used, "field_label"),
                u(used, "thing_id"),
                s(used, "edit_url")
            ));
        }
    }
    out
}

pub fn folder(info: &Value) -> String {
    let mut out = vec![
        info["path"].as_str().unwrap_or("").to_string(),
        format!("  Kind:        {}", s(info, "kind")),
        format!(
            "  Exists:      {}, writable: {}",
            if info["exists"] == Value::Bool(true) { "yes" } else { "no" },
            if info["writable"] == Value::Bool(true) { "yes" } else { "no" }
        ),
    ];
    if let Some(free) = info.get("free_bytes").and_then(Value::as_u64) {
        out.push(format!("  Free space:  {}", bytes(free)));
    }
    if let Some(onpage) = info.get("onpage_project").filter(|o| o.is_object()) {
        out.push(format!("  Synced with: {} (#{})", s(onpage, "label"), u(onpage, "id")));
    }
    let problems: Vec<&str> = info["problems"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if problems.is_empty() {
        out.push("  No problems".into());
    } else {
        let detail = info.get("problem_detail").and_then(Value::as_str).map(|d| format!(" ({d})")).unwrap_or_default();
        out.push(format!("  Problems:    {}{detail}", problems.join(", ")));
    }
    out.join("\n")
}

pub fn token_check(check: &Value) -> String {
    if check["ok"] == Value::Bool(true) {
        let langs =
            check["langs"].as_array().map(|l| l.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "));
        format!(
            "Token works: On Page project {} (#{}), {} collections with files{}",
            s(check, "project_label"),
            u(check, "project_id"),
            u(check, "collections_with_files"),
            langs.map(|l| format!(", languages {l}")).unwrap_or_default()
        )
    } else {
        format!("Token does not work: {}", s(check, "error"))
    }
}

pub fn settings(settings: &Value) -> String {
    settings
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| {
            format!("{key}={}", value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn status(status: &Value) -> String {
    format!(
        "{} jobs running, {}/s, {} files ({}) in all the projects",
        u(status, "running_jobs"),
        bytes(status["speed_bps"].as_f64().unwrap_or(0.0) as u64),
        number(u(status, "total_files")),
        bytes(u(status, "total_bytes"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_and_sizes() {
        assert_eq!(number(186794), "186,794");
        assert_eq!(number(12), "12");
        assert_eq!(bytes(999), "999 B");
        assert_eq!(bytes(6_600_000), "6.6 MB");
        assert_eq!(duration(3725), "1h 02m");
    }

    #[test]
    fn states_read_as_the_app_says_them() {
        let idle = |runtime: Value| json!({ "runtime": runtime });
        assert_eq!(state(&idle(json!({ "phase": "idle" }))), "never synced");
        assert_eq!(
            state(&idle(json!({ "phase": "idle", "plan": { "to_download_names": 1200 } }))),
            "1,200 files to download"
        );
        let duplicates = json!({ "code": "duplicates", "severity": "warning", "count": 20 });
        assert_eq!(
            state(&idle(json!({ "phase": "idle", "plan": { "to_download_names": 5 }, "issues": [duplicates] }))),
            "5 files to download"
        );
        assert_eq!(state(&idle(json!({ "phase": "idle", "issues": [duplicates] }))), "duplicates (20)");
        assert_eq!(
            state(&idle(json!({ "phase": "idle", "issues": [{ "code": "token_invalid", "severity": "error" }] }))),
            "token invalid"
        );
        let running = json!({ "runtime": { "phase": "downloading", "job": "download",
            "progress": { "total": 10, "downloaded": 4, "linked": 0, "removed": 0, "failed": 1, "bytes_done": 0, "bytes_total": 0, "speed_bps": 2000000.0 } } });
        assert_eq!(state(&running), "download: downloading 5/10, 2.0 MB/s, 1 failed");
    }

    #[test]
    fn tables_align() {
        let out = table(&["A", "B"], &[vec!["long cell".into(), "x".into()]]);
        assert_eq!(out, "A          B\nlong cell  x");
    }
}
