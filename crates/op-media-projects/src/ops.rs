//! Everything the app's window can do with the projects, as named operations
//! with JSON arguments and a JSON answer: the tools of the MCP server (in the
//! app, and `opmd mcp`) and what `opmd`'s commands run, here or in the app.
//! One list, so the window, the terminal and an agent can do the same things,
//! checked the same way (`validate`).
//!
//! A project is named by its id or its name (`ProjectService::find`). Jobs
//! start and answer at once; `wait_for_project` waits for their end. Tokens
//! go in (creating a project, changing its token) and never come out.

use std::sync::Arc;
use std::time::Duration;

use op_media_service::{JobKind, PageQuery};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::projects::ProjectService;
use crate::validate;

/// An operation, as an agent sees it
pub struct Operation {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// Changes nothing (a listing, a check)
    pub read_only: bool,
    /// Deletes files on the disk
    pub destructive: bool,
    /// The JSON schema of the arguments
    pub schema: fn() -> Value,
}

/// The longest wait of `wait_for_project`: an agent asks again for a long download
const MAX_WAIT: Duration = Duration::from_secs(600);

pub const OPERATIONS: &[Operation] = &[
    Operation {
        name: "list_projects",
        title: "List projects",
        description: "All the projects: an On Page project kept in sync with a local or network folder. Each has \
                      its id, name, folder and state (`runtime.phase`: idle, listing, downloading…; `runtime.plan`: \
                      what the last «sync» found to do; `runtime.last_result`: how the last job ended; `issues`).",
        read_only: true,
        destructive: false,
        schema: || object(&[], &[]),
    },
    Operation {
        name: "get_project",
        title: "Get a project",
        description: "One project, by id or name, with its live state (phase, progress while a job runs, plan, last \
                      result, issues, folder info).",
        read_only: true,
        destructive: false,
        schema: || object(&[("project", project_ref())], &["project"]),
    },
    Operation {
        name: "create_project",
        title: "Create a project",
        description: "Adds a project: an On Page API token (read-only token of an On Page project) and the folder \
                      to keep in sync with its media. The folder must exist, not be a system folder nor another \
                      project's. `sync_now` starts «sync» right after.",
        read_only: false,
        destructive: false,
        schema: || {
            object(
                &[
                    ("label", string("The project's name, as shown in the app")),
                    ("token", string("The On Page API token")),
                    ("folder", string("Absolute path of the folder to keep in sync")),
                    ("keep_old_files", boolean("Keep the files On Page no longer has (default false)")),
                    ("sync_now", boolean("Start «sync» right after (default false)")),
                ],
                &["label", "token", "folder"],
            )
        },
    },
    Operation {
        name: "update_project",
        title: "Edit a project",
        description: "Changes a project's name, token, folder or `keep_old_files`. Another token or folder starts \
                      over (the next «sync» plans again). Refused while a job runs (`project_busy`).",
        read_only: false,
        destructive: false,
        schema: || {
            object(
                &[
                    ("project", project_ref()),
                    ("label", string("New name")),
                    ("token", string("New On Page API token")),
                    ("folder", string("New folder (absolute path)")),
                    ("keep_old_files", boolean("Keep the files On Page no longer has")),
                ],
                &["project"],
            )
        },
    },
    Operation {
        name: "remove_project",
        title: "Remove a project",
        description: "Removes a project from the app. With `delete_files` the files it downloaded are deleted too \
                      (only those: the user's own files in the folder stay); without, they stay on the disk.",
        read_only: false,
        destructive: true,
        schema: || {
            object(
                &[
                    ("project", project_ref()),
                    ("delete_files", boolean("Also delete the files the app downloaded (default false)")),
                ],
                &["project"],
            )
        },
    },
    Operation {
        name: "sync_project",
        title: "Sync a project",
        description: "«Sync»: lists the project's files on On Page and compares them with the folder; nothing is \
                      downloaded (that is `download_project`). When nothing needs downloading, the links and the \
                      removals (within the safety limit) are applied at once. Answers at once: follow it with \
                      `wait_for_project`; then `runtime.plan` says what a download would do.",
        read_only: false,
        destructive: false,
        schema: || {
            object(
                &[
                    ("project", project_ref()),
                    ("full_listing", boolean("List everything again, not only what changed (default false)")),
                    (
                        "take_over_folder",
                        boolean(
                            "Use the folder although another On Page project synced it (issue folder_other_project)",
                        ),
                    ),
                ],
                &["project"],
            )
        },
    },
    Operation {
        name: "sync_all",
        title: "Sync all projects",
        description: "«Sync» every project that is not running a job. Answers at once.",
        read_only: false,
        destructive: false,
        schema: || object(&[], &[]),
    },
    Operation {
        name: "download_project",
        title: "Download a project",
        description: "«Download»: lists the files again and downloads what the folder lacks, and removes from the \
                      folder the files On Page no longer has unless the project keeps them. Answers at once: follow \
                      it with `wait_for_project`.",
        read_only: false,
        destructive: false,
        schema: || object(&[("project", project_ref())], &["project"]),
    },
    Operation {
        name: "retry_failed",
        title: "Retry failed files",
        description: "Downloads again only the files that failed in the last job (see `get_failed_files`).",
        read_only: false,
        destructive: false,
        schema: || object(&[("project", project_ref())], &["project"]),
    },
    Operation {
        name: "confirm_cleanup",
        title: "Confirm the removals",
        description: "When a job stopped because it would remove many files (issue cleanup_needs_confirmation), \
                      removes them: the files On Page no longer has are deleted from the folder.",
        read_only: false,
        destructive: true,
        schema: || object(&[("project", project_ref())], &["project"]),
    },
    Operation {
        name: "stop_project",
        title: "Stop a job",
        description: "Stops the project's running job; what is done stays done.",
        read_only: false,
        destructive: false,
        schema: || object(&[("project", project_ref())], &["project"]),
    },
    Operation {
        name: "wait_for_project",
        title: "Wait for a job",
        description: "Waits until the project's job ends (at most `timeout_seconds`, 600 at most) and answers the \
                      project: `runtime.phase` is idle when it ended, `runtime.last_result` says how.",
        read_only: true,
        destructive: false,
        schema: || {
            object(
                &[
                    ("project", project_ref()),
                    ("timeout_seconds", integer("How long to wait at most (default 60, at most 600)")),
                ],
                &["project"],
            )
        },
    },
    Operation {
        name: "get_activity",
        title: "Project activity",
        description: "The last events of a project's jobs (files downloaded, renamed, removed, failed), newest first.",
        read_only: true,
        destructive: false,
        schema: || {
            object(
                &[("project", project_ref()), ("limit", integer("How many (default 100, at most 1000)"))],
                &["project"],
            )
        },
    },
    Operation {
        name: "get_failed_files",
        title: "Failed files",
        description: "The files that could not be downloaded in the last job, a page at a time, with the reason.",
        read_only: true,
        destructive: false,
        schema: || object(&[("project", project_ref()), ("offset", offset()), ("limit", limit())], &["project"]),
    },
    Operation {
        name: "get_duplicates",
        title: "Duplicate names",
        description: "Names that On Page has for different files: only the first is downloaded under the name, the \
                      others are skipped until renamed on On Page. A page of names, searchable; each name shows its \
                      first 10 files (`more_variants`: how many others, see `get_duplicate_files`) and where each \
                      is used on On Page (with a link to edit the item).",
        read_only: true,
        destructive: false,
        schema: || {
            object(
                &[
                    ("project", project_ref()),
                    ("query", string("Part of the name, any case")),
                    ("offset", offset()),
                    ("limit", limit()),
                ],
                &["project"],
            )
        },
    },
    Operation {
        name: "get_duplicate_files",
        title: "Files of a duplicate name",
        description: "More files of one duplicate name, after the first 10 `get_duplicates` gives.",
        read_only: true,
        destructive: false,
        schema: || {
            object(
                &[
                    ("project", project_ref()),
                    ("name", string("The name, as `get_duplicates` gives it")),
                    ("offset", integer("Files already seen (default 0)")),
                    ("limit", limit()),
                ],
                &["project", "name"],
            )
        },
    },
    Operation {
        name: "inspect_folder",
        title: "Check a folder",
        description: "Whether a folder can be a project's: reachable, writable, its kind (local, network, external \
                      drive), free space, and problems (system folder, another project's, inside another project).",
        read_only: true,
        destructive: false,
        schema: || {
            object(
                &[
                    ("folder", string("Absolute path")),
                    ("project", string("The project it would be for, when editing one (id or name)")),
                ],
                &["folder"],
            )
        },
    },
    Operation {
        name: "verify_token",
        title: "Check a token",
        description: "Whether an On Page API token works, and the On Page project it opens.",
        read_only: true,
        destructive: false,
        schema: || object(&[("token", string("The On Page API token"))], &["token"]),
    },
    Operation {
        name: "verify_project_token",
        title: "Check a project's token",
        description: "Whether the token saved with a project still works (the token itself is never shown).",
        read_only: true,
        destructive: false,
        schema: || object(&[("project", project_ref())], &["project"]),
    },
    Operation {
        name: "get_settings",
        title: "Settings",
        description: "The app's settings: language, theme, parallel downloads per project (`concurrency`), retry of \
                      failed files, notifications, notification area, start at login, update checks.",
        read_only: true,
        destructive: false,
        schema: || object(&[], &[]),
    },
    Operation {
        name: "update_settings",
        title: "Change settings",
        description: "Changes some settings; the others stay. Answers all of them.",
        read_only: false,
        destructive: false,
        schema: || {
            object(
                &[
                    ("theme", enumeration(&["system", "light", "dark"])),
                    ("language", enumeration(&["it", "en", "de", "es", "fr", "ru", "sv", "zh"])),
                    ("concurrency", integer("Parallel downloads per project, 1 to 10")),
                    ("auto_retry_failed", boolean("Retry network failures once, a minute after a download")),
                    ("notifications", boolean("System notifications at the end of a job")),
                    ("close_to_tray", boolean("Keep running in the notification area when the window closes")),
                    ("open_at_login", boolean("Start with the system")),
                    ("check_updates", boolean("Look for a new version at start-up")),
                ],
                &[],
            )
        },
    },
    Operation {
        name: "get_status",
        title: "Status",
        description: "Jobs running, total speed, files and bytes of all the projects.",
        read_only: true,
        destructive: false,
        schema: || object(&[], &[]),
    },
];

pub fn operation(name: &str) -> Option<&'static Operation> {
    OPERATIONS.iter().find(|operation| operation.name == name)
}

/// Runs an operation. Errors are codes (`project_not_found`, `invalid_input`,
/// `project_busy`, `folder_protected`…, see `error_message`)
pub async fn call(projects: &Arc<ProjectService>, name: &str, args: &Value) -> Result<Value, String> {
    let empty = Map::new();
    let fields = args.as_object().unwrap_or(&empty);
    let field = |key: &str| fields.get(key).unwrap_or(&Value::Null);
    let flag = |key: &str| field(key) == &Value::Bool(true);
    let project = || -> Result<String, String> {
        let reference = field("project").as_str().ok_or_else(|| "invalid_input".to_string())?;
        Ok(projects.find(reference)?.id)
    };
    let ok = || Ok(json!({ "ok": true }));
    match name {
        "list_projects" => answer(projects.views()),
        "get_project" => answer(projects.find(&project()?)?),
        "create_project" => answer(projects.create(validate::new_project_input(args)?).await?),
        "update_project" => {
            let id = project()?;
            answer(projects.update(&id, validate::project_patch(args)?).await?)
        }
        "remove_project" => {
            projects.remove(&project()?, flag("delete_files")).await?;
            ok()
        }
        "sync_project" => {
            projects.start_job(&project()?, JobKind::Sync, flag("full_listing"), flag("take_over_folder"))?;
            ok()
        }
        "sync_all" => {
            projects.sync_all();
            ok()
        }
        "download_project" => job(projects, &project()?, JobKind::Download),
        "retry_failed" => job(projects, &project()?, JobKind::RetryFailed),
        "confirm_cleanup" => job(projects, &project()?, JobKind::Cleanup),
        "stop_project" => {
            projects.stop(&project()?);
            ok()
        }
        "wait_for_project" => {
            let seconds = field("timeout_seconds").as_u64().unwrap_or(60);
            let timeout = Duration::from_secs(seconds).min(MAX_WAIT);
            answer(projects.wait_job(&project()?, timeout).await?)
        }
        "get_activity" => {
            let limit = validate::activity_limit(fields.get("limit")).unwrap_or(100);
            answer(projects.activity(&project()?, Some(limit))?)
        }
        "get_failed_files" => answer(projects.failed(&project()?, &validate::page_query(args))?),
        "get_duplicates" => {
            let id = project()?;
            let page = PageQuery { labels: true, ..validate::page_query(args) };
            answer(projects.duplicates(&id, page).await?)
        }
        "get_duplicate_files" => {
            let id = project()?;
            let mut query = validate::variants_query(args)?;
            query.labels = true;
            answer(projects.duplicate_variants(&id, query).await?)
        }
        "inspect_folder" => {
            let folder = validate::folder_path(field("folder"))?;
            let id = match field("project").as_str() {
                Some(reference) => Some(projects.find(reference)?.id),
                None => None,
            };
            answer(projects.inspect(&folder, id).await)
        }
        "verify_token" => {
            let token = validate::text(field("token"), validate::limits::TOKEN)?;
            answer(projects.verify_token(&token).await)
        }
        "verify_project_token" => answer(projects.verify_project_token(&project()?).await?),
        "get_settings" => answer(projects.settings()),
        "update_settings" => answer(projects.set_settings(&validate::settings_patch(args)?)),
        "get_status" => {
            let status = projects.status(true);
            Ok(json!({
                "running_jobs": status.running_jobs,
                "deleting": projects.is_deleting(),
                "speed_bps": status.speed_bps,
                "total_files": status.total_files,
                "total_bytes": status.total_bytes,
            }))
        }
        _ => Err("unknown_operation".into()),
    }
}

fn job(projects: &Arc<ProjectService>, id: &str, kind: JobKind) -> Result<Value, String> {
    projects.start_job(id, kind, false, false)?;
    Ok(json!({ "ok": true }))
}

fn answer(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("unexpected: {error}"))
}

/// What an error code means, for a person or an agent: the code itself when there are no words for it
pub fn error_message(code: &str) -> String {
    let (code, detail) = code.split_once(": ").unwrap_or((code, ""));
    let text = match code {
        "invalid_input" => "Invalid arguments.",
        "unknown_operation" => "There is no such operation.",
        "project_not_found" => "No project with that id or name.",
        "project_ambiguous" => "More projects have that name: use the id.",
        "project_busy" => "The project is running a job: stop it or wait for it to end.",
        "open_failed" => "The folder could not be opened.",
        "folder_protected" => "The folder is a system folder or holds one: choose another.",
        "folder_used_by_other_project" => "Another project already uses that folder.",
        "folder_foreign_data" => "The folder's data/ belongs to something else: choose another folder.",
        "folder_unreachable" => "The folder cannot be reached.",
        "folder_not_writable" => "The folder cannot be written.",
        "token_invalid" => "The On Page token is not valid.",
        "unexpected" => "Something unexpected happened: see the log.",
        _ => "",
    };
    match (text, detail) {
        ("", "") => code.to_string(),
        ("", detail) => format!("{code}: {detail}"),
        (text, "") => format!("{text} ({code})"),
        (text, detail) => format!("{text} ({code}: {detail})"),
    }
}

/* ------------------------------------------------------------------ schemas */

fn object(properties: &[(&str, Value)], required: &[&str]) -> Value {
    let properties: Map<String, Value> =
        properties.iter().map(|(name, schema)| (name.to_string(), schema.clone())).collect();
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

fn project_ref() -> Value {
    string("The project's id, or its name (any case)")
}

fn string(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn boolean(description: &str) -> Value {
    json!({ "type": "boolean", "description": description })
}

fn integer(description: &str) -> Value {
    json!({ "type": "integer", "minimum": 0, "description": description })
}

fn enumeration(values: &[&str]) -> Value {
    json!({ "type": "string", "enum": values })
}

fn offset() -> Value {
    integer("Entries to skip (default 0)")
}

fn limit() -> Value {
    integer("How many (default 50, at most 200)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_has_a_schema_and_a_unique_name() {
        let mut names = std::collections::HashSet::new();
        for operation in OPERATIONS {
            assert!(names.insert(operation.name), "{} twice", operation.name);
            let schema = (operation.schema)();
            assert_eq!(schema["type"], "object", "{}", operation.name);
            for required in schema["required"].as_array().unwrap() {
                assert!(schema["properties"].get(required.as_str().unwrap()).is_some(), "{}", operation.name);
            }
            assert!(!(operation.read_only && operation.destructive), "{}", operation.name);
        }
    }

    #[test]
    fn errors_read_as_words() {
        assert_eq!(
            error_message("project_busy"),
            "The project is running a job: stop it or wait for it to end. (project_busy)"
        );
        assert_eq!(error_message("listing_failed: 500"), "listing_failed: 500");
        assert_eq!(error_message("something_new"), "something_new");
    }
}
