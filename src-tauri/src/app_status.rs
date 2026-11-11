//! What the app shows of its projects besides the page: the projects and the
//! status pushed to the windows (the status throttled), the taskbar or Dock
//! progress, the tray icon and tooltip, and keeping the computer awake while
//! jobs run or the files of a removed project are being deleted.

use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use op_media_service::JobPhase;
use parking_lot::Mutex;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::texts;
use crate::models::{AppStatus, ProjectView};
use crate::shell::Shell;
use crate::status::{Tone, aggregate_tone, progress_of, project_status};
use crate::window::MainWindow;

const STATUS_THROTTLE: Duration = Duration::from_millis(250);
const ONLINE_CHECK: Duration = Duration::from_secs(10);

pub struct StatusController {
    online: AtomicBool,
    /// Red taskbar after an error, until the user looks at the window
    show_errors: AtomicBool,
    status_scheduled: AtomicBool,
    /// On/off to the thread that holds the system's "stay awake" request
    awake: Mutex<Sender<bool>>,
    awake_now: AtomicBool,
}

impl StatusController {
    pub fn new() -> StatusController {
        StatusController {
            online: AtomicBool::new(is_online()),
            show_errors: AtomicBool::new(false),
            status_scheduled: AtomicBool::new(false),
            awake: Mutex::new(keep_awake_thread()),
            awake_now: AtomicBool::new(false),
        }
    }

    /// Watches the network: the page shows «Offline» in its status bar
    pub fn start(&self, app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(ONLINE_CHECK).await;
                let now = tokio::task::spawn_blocking(is_online).await.unwrap_or(true);
                let shell = app.state::<Shell>();
                if shell.status.online.swap(now, Ordering::AcqRel) != now {
                    shell.status.broadcast_status(&app);
                }
            }
        });
    }

    pub fn status(&self, app: &AppHandle) -> AppStatus {
        app.state::<Shell>()
            .projects
            .status(self.online.load(Ordering::Acquire))
    }

    /// The window got the focus: the errors have been seen
    pub fn window_focused(&self, app: &AppHandle) {
        self.show_errors.store(false, Ordering::Release);
        update_taskbar(app, &app.state::<Shell>().projects.views(), false);
    }

    /// A failure turns the taskbar red until the window gets the focus
    pub fn job_ended(&self, failed: bool, window_focused: bool) {
        if failed && !window_focused {
            self.show_errors.store(true, Ordering::Release);
        }
    }

    pub fn update_tray(&self, app: &AppHandle, views: &[ProjectView]) {
        let shell = app.state::<Shell>();
        let t = texts(shell.store.settings().language);
        let running = views
            .iter()
            .filter(|v| v.runtime.phase != JobPhase::Idle)
            .count() as u64;
        let attention = views
            .iter()
            .filter(|v| matches!(project_status(v).tone, Tone::Danger | Tone::Warning))
            .count() as u64;
        let line = if running > 0 {
            t.tray_running(running)
        } else if attention > 0 {
            t.tray_attention(attention)
        } else {
            t.tray_idle.to_string()
        };
        let tone = aggregate_tone(views);
        shell.tray.update(
            app,
            tone.filter(|tone| *tone != Tone::Success),
            format!("{}\n{line}", t.app_name),
        );
    }

    pub fn on_projects(&self, app: &AppHandle, views: &[ProjectView]) {
        let _ = app.emit("projects:changed", views);
        update_taskbar(app, views, self.show_errors.load(Ordering::Acquire));
        self.update_tray(app, views);
        self.update_awake(app);
        self.broadcast_status(app);
    }

    pub fn broadcast_status(&self, app: &AppHandle) {
        if self.status_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(STATUS_THROTTLE).await;
            let shell = app.state::<Shell>();
            shell
                .status
                .status_scheduled
                .store(false, Ordering::Release);
            let _ = app.emit("app:status", shell.status.status(&app));
        });
    }

    fn update_awake(&self, app: &AppHandle) {
        let projects = &app.state::<Shell>().projects;
        let busy = projects.is_running() || projects.is_deleting();
        if self.awake_now.swap(busy, Ordering::AcqRel) != busy {
            let _ = self.awake.lock().send(busy);
        }
    }
}

/// Progress on the taskbar button (Windows, Linux) and on the Dock (macOS):
/// normal while working, paused while stopping, red after an error until the
/// window gets the focus again; the Dock badge counts projects to look at
pub fn update_taskbar(app: &AppHandle, views: &[ProjectView], show_errors: bool) {
    let Some(window) = MainWindow::current(app) else {
        return;
    };
    let running: Vec<&ProjectView> = views
        .iter()
        .filter(|v| v.runtime.phase != JobPhase::Idle)
        .collect();
    let statuses: Vec<_> = views.iter().map(project_status).collect();
    let state = if !running.is_empty() {
        let stopping = running
            .iter()
            .all(|v| v.runtime.phase == JobPhase::Stopping);
        match progress_of(views) {
            Some((done, total)) => ProgressBarState {
                status: Some(if stopping {
                    ProgressBarStatus::Paused
                } else {
                    ProgressBarStatus::Normal
                }),
                progress: Some(((done as f64 / total as f64).min(1.0) * 100.0).round() as u64),
            },
            None => ProgressBarState {
                status: Some(ProgressBarStatus::Indeterminate),
                progress: None,
            },
        }
    } else if show_errors && statuses.iter().any(|s| s.tone == Tone::Danger) {
        ProgressBarState {
            status: Some(ProgressBarStatus::Error),
            progress: Some(100),
        }
    } else {
        ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        }
    };
    let _ = window.set_progress_bar(state);
    #[cfg(target_os = "macos")]
    {
        let attention = statuses
            .iter()
            .filter(|s| s.tone == Tone::Danger || s.todo)
            .count() as i64;
        let _ = window.set_badge_count(if attention > 0 { Some(attention) } else { None });
    }
}

/// A route out of this computer exists (no packet is sent: a UDP "connection" only picks a route)
fn is_online() -> bool {
    let route = |bind: &str, target: &str| {
        UdpSocket::bind(bind)
            .and_then(|socket| socket.connect(target))
            .is_ok()
    };
    route("0.0.0.0:0", "1.1.1.1:53") || route("[::]:0", "[2606:4700:4700::1111]:53")
}

/// The system's "stay awake" request belongs to the thread that made it (Windows): one thread holds it
fn keep_awake_thread() -> Sender<bool> {
    let (sender, receiver) = mpsc::channel::<bool>();
    let _ = std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            let mut guard = None;
            while let Ok(busy) = receiver.recv() {
                if busy && guard.is_none() {
                    guard = keepawake::Builder::default()
                        .idle(true)
                        .reason("Syncing On Page media")
                        .app_name("On Page Media Downloader")
                        .app_reverse_domain("com.onpage.mediadownloader")
                        .create()
                        .map_err(|error| crate::warn!("The computer cannot be kept awake: {error}"))
                        .ok();
                } else if !busy {
                    guard = None;
                }
            }
        });
    sender
}
