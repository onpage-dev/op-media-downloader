//! The state vocabulary of `src/shared/status.ts`, as far as the app itself
//! needs it: the tone of each project for the tray dot and the taskbar, and
//! whether it waits for «Scarica».

use op_media_service::{IssueCode, JobPhase};

use crate::models::ProjectView;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tone {
    Success,
    Info,
    Accent,
    Warning,
    Danger,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Status {
    pub tone: Tone,
    /// Files waiting for «Scarica» (the Dock badge counts these projects)
    pub todo: bool,
}

const ERRORS: &[IssueCode] = &[
    IssueCode::TokenInvalid,
    IssueCode::ProjectUnavailable,
    IssueCode::FolderLocked,
    IssueCode::FolderOtherProject,
    IssueCode::FolderUnreachable,
    IssueCode::FolderNotWritable,
    IssueCode::FolderProtected,
    IssueCode::DiskFull,
    IssueCode::ListingFailed,
    IssueCode::Unexpected,
];

const WARNINGS: &[IssueCode] = &[
    IssueCode::Interrupted,
    IssueCode::ListingIncomplete,
    IssueCode::FailedFiles,
    IssueCode::Duplicates,
    IssueCode::NameConflicts,
    IssueCode::CopiesInsteadOfLinks,
];

pub fn project_status(project: &ProjectView) -> Status {
    let runtime = &project.runtime;
    let has = |code: IssueCode| runtime.issues.iter().any(|issue| issue.code == code);
    let status = |tone| Status { tone, todo: false };
    match runtime.phase {
        JobPhase::Stopping => return status(Tone::Warning),
        JobPhase::Preparing | JobPhase::Listing | JobPhase::Comparing | JobPhase::Downloading | JobPhase::Finishing => {
            return status(Tone::Accent);
        }
        JobPhase::Idle => {}
    }
    if ERRORS.iter().any(|code| has(*code)) {
        return status(Tone::Danger);
    }
    if has(IssueCode::Offline) {
        return status(Tone::Neutral);
    }
    if has(IssueCode::CleanupNeedsConfirmation) {
        return status(Tone::Warning);
    }
    if runtime.plan.as_ref().is_some_and(|plan| plan.to_download_names > 0) {
        return Status { tone: Tone::Info, todo: true };
    }
    if WARNINGS.iter().any(|code| has(*code)) {
        return status(Tone::Warning);
    }
    if runtime.last_result.is_some() { status(Tone::Success) } else { status(Tone::Neutral) }
}

/// Taskbar and tray: the worst state across projects wins
pub fn aggregate_tone(projects: &[ProjectView]) -> Option<Tone> {
    let tones: Vec<Tone> = projects.iter().map(|p| project_status(p).tone).collect();
    for tone in [Tone::Danger, Tone::Warning, Tone::Accent, Tone::Info] {
        if tones.contains(&tone) {
            return Some(tone);
        }
    }
    (!tones.is_empty()).then_some(Tone::Success)
}

/// What a running project has done, for the taskbar: bytes when known, names otherwise
pub fn progress_of(projects: &[ProjectView]) -> Option<(u64, u64)> {
    let mut done = 0;
    let mut total = 0;
    for project in projects.iter().filter(|p| p.runtime.phase != JobPhase::Idle) {
        let Some(progress) = &project.runtime.progress else {
            continue;
        };
        done += if progress.bytes_total > 0 {
            progress.bytes_done
        } else {
            progress.downloaded + progress.linked + progress.removed + progress.failed
        };
        total += if progress.bytes_total > 0 { progress.bytes_total } else { progress.total };
    }
    (total > 0).then_some((done, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use op_media_service::{Issue, PlanSummary, ProjectRuntime, Severity};

    fn view(runtime: ProjectRuntime) -> ProjectView {
        ProjectView {
            id: "p".into(),
            label: "P".into(),
            folder: "/f".into(),
            keep_old_files: false,
            created_at: String::new(),
            has_token: true,
            runtime,
            folder_info: None,
            onpage_project: None,
        }
    }

    fn issue(code: IssueCode) -> Issue {
        Issue { code, severity: Severity::Error, count: None, detail: None, at: String::new() }
    }

    #[test]
    fn tones_follow_the_shared_vocabulary() {
        assert_eq!(project_status(&view(ProjectRuntime::default())).tone, Tone::Neutral);
        let running = ProjectRuntime { phase: JobPhase::Downloading, ..Default::default() };
        assert_eq!(project_status(&view(running)).tone, Tone::Accent);
        let error = ProjectRuntime {
            issues: vec![issue(IssueCode::DiskFull), issue(IssueCode::FailedFiles)],
            ..Default::default()
        };
        assert_eq!(project_status(&view(error)).tone, Tone::Danger);
        let todo = ProjectRuntime {
            plan: Some(PlanSummary { to_download_names: 3, ..Default::default() }),
            issues: vec![issue(IssueCode::Duplicates)],
            ..Default::default()
        };
        assert_eq!(project_status(&view(todo.clone())), Status { tone: Tone::Info, todo: true });
        let views =
            [view(todo), view(ProjectRuntime { issues: vec![issue(IssueCode::Duplicates)], ..Default::default() })];
        assert_eq!(aggregate_tone(&views), Some(Tone::Warning));
        assert_eq!(aggregate_tone(&[]), None);
    }
}
