//! The main window as the rest of the app uses it: created when needed
//! (closing it destroys it), shown with the command that asked for it (menus,
//! tray, a second launch, notifications), bounds remembered between launches.
//! A command sent while the page loads waits for the page to ask for it.
//! The title bar is the page's: on Windows and Linux the window has no
//! decorations and the page draws ─ ☐ ✕; on macOS the traffic lights sit on
//! the page's title row.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Theme, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::models::{AppCommand, ThemeSetting};
use crate::shell::Shell;
use crate::store::WindowState;
use crate::warn;

pub const MAIN: &str = "main";
pub const TRAY_PANEL: &str = "tray";

const DEFAULT_SIZE: (f64, f64) = (1100.0, 720.0);
pub const MIN_SIZE: (f64, f64) = (860.0, 560.0);
#[cfg(target_os = "macos")]
pub const TITLE_BAR_HEIGHT: f64 = 32.0;

/// The backdrop of the title row (`src/shared/window-chrome.ts`): the window's colour before the page paints
const LIGHT_BACKGROUND: Color = Color(0xf2, 0xf2, 0xf2, 0xff);
const DARK_BACKGROUND: Color = Color(0x16, 0x1b, 0x19, 0xff);

#[derive(Default)]
pub struct MainWindow {
    /// Commands waiting for the page to listen
    pending: Mutex<Vec<AppCommand>>,
    /// The page asked for its commands since it last loaded
    page_ready: AtomicBool,
    /// The page has loaded: the window can show without a white flash
    loaded: AtomicBool,
    /// Bumped by every move or resize: the last one saves the bounds
    bounds_change: AtomicU64,
}

impl MainWindow {
    pub fn current(app: &AppHandle) -> Option<WebviewWindow> {
        app.get_webview_window(MAIN)
    }

    pub fn focused(app: &AppHandle) -> bool {
        Self::current(app)
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false)
    }

    pub fn show(&self, app: &AppHandle) {
        let window = match Self::current(app) {
            Some(window) => window,
            None => match self.create(app) {
                Ok(window) => window,
                Err(error) => {
                    crate::error!("The main window cannot be created: {error}");
                    return;
                }
            },
        };
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        // A window still loading shows itself when the page is there
        if self.loaded.load(Ordering::Acquire) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    pub fn send_command(&self, app: &AppHandle, command: AppCommand) {
        crate::tray::hide_panel(app);
        self.show(app);
        if self.page_ready.load(Ordering::Acquire) {
            let _ = app.emit_to(MAIN, "app:command", &command);
        } else {
            self.pending.lock().push(command);
        }
    }

    /// The page listens for commands: what waited goes to it now, the next ones as events
    pub fn take_commands(&self) -> Vec<AppCommand> {
        self.page_ready.store(true, Ordering::Release);
        std::mem::take(&mut *self.pending.lock())
    }

    fn create(&self, app: &AppHandle) -> tauri::Result<WebviewWindow> {
        let shell = app.state::<Shell>();
        let state = restored_state(app, shell.store.window_state());
        self.loaded.store(false, Ordering::Release);
        self.page_ready.store(false, Ordering::Release);
        let handle = app.clone();
        let mut builder =
            WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("On Page Media Downloader")
                .inner_size(state.width, state.height)
                .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                .visible(false)
                .background_color(background(theme_of(app, shell.store.settings().theme)))
                .theme(native_theme(shell.store.settings().theme))
                .on_navigation(is_app_url)
                .on_page_load(move |_webview, payload| {
                    let main = &handle.state::<Shell>().main_window;
                    match payload.event() {
                        PageLoadEvent::Started => {
                            main.page_ready.store(false, Ordering::Release);
                            main.loaded.store(false, Ordering::Release);
                        }
                        PageLoadEvent::Finished => {
                            main.loaded.store(true, Ordering::Release);
                            if let Some(window) = MainWindow::current(&handle) {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                });
        if let (Some(x), Some(y)) = (state.x, state.y) {
            builder = builder.position(x, y);
        } else {
            builder = builder.center();
        }
        #[cfg(target_os = "macos")]
        {
            builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(
                    12.0,
                    (TITLE_BAR_HEIGHT - 14.0) / 2.0,
                ));
        }
        #[cfg(not(target_os = "macos"))]
        {
            builder = builder.decorations(false);
        }
        let window = builder.build()?;
        if state.maximized {
            let _ = window.maximize();
        }
        let handle = app.clone();
        window.on_window_event(move |event| on_event(&handle, event));
        Ok(window)
    }

    fn save_bounds_later(&self, app: &AppHandle) {
        let change = self.bounds_change.fetch_add(1, Ordering::AcqRel) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let shell = app.state::<Shell>();
            if shell.main_window.bounds_change.load(Ordering::Acquire) != change {
                return;
            }
            let Some(window) = MainWindow::current(&app) else {
                return;
            };
            let maximized = window.is_maximized().unwrap_or(false);
            if window.is_minimized().unwrap_or(false) {
                return;
            }
            let previous = shell.store.window_state();
            let state = if maximized {
                // The bounds before maximizing are the ones to restore
                match previous {
                    Some(previous) => WindowState {
                        maximized: true,
                        ..previous
                    },
                    None => WindowState {
                        x: None,
                        y: None,
                        width: DEFAULT_SIZE.0,
                        height: DEFAULT_SIZE.1,
                        maximized: true,
                    },
                }
            } else {
                let scale = window.scale_factor().unwrap_or(1.0);
                let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size())
                else {
                    return;
                };
                let position = position.to_logical::<f64>(scale);
                let size = size.to_logical::<f64>(scale);
                WindowState {
                    x: Some(position.x),
                    y: Some(position.y),
                    width: size.width,
                    height: size.height,
                    maximized: false,
                }
            };
            if previous != Some(state) {
                shell.store.set_window_state(&state);
            }
        });
    }
}

fn on_event(app: &AppHandle, event: &WindowEvent) {
    let shell = app.state::<Shell>();
    match event {
        WindowEvent::Focused(focused) => {
            let _ = app.emit_to(MAIN, "window:focus", focused);
            if *focused {
                shell.status.window_focused(app);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => shell.main_window.save_bounds_later(app),
        WindowEvent::CloseRequested { api, .. } => {
            if shell.lifecycle.on_window_close(app) {
                api.prevent_close();
            }
        }
        WindowEvent::ThemeChanged(theme) => {
            if let Some(window) = MainWindow::current(app) {
                let _ = window.set_background_color(Some(background(*theme == Theme::Dark)));
            }
            crate::tray::refresh_icon(app);
        }
        WindowEvent::Destroyed => {
            shell.main_window.loaded.store(false, Ordering::Release);
            shell.main_window.page_ready.store(false, Ordering::Release);
        }
        _ => {}
    }
}

/// The page of the app only: its own files, or the development server
pub fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            host == "tauri.localhost"
                || (cfg!(debug_assertions) && (host == "localhost" || host == "127.0.0.1"))
        }
        _ => false,
    }
}

pub fn native_theme(setting: ThemeSetting) -> Option<Theme> {
    match setting {
        ThemeSetting::System => None,
        ThemeSetting::Light => Some(Theme::Light),
        ThemeSetting::Dark => Some(Theme::Dark),
    }
}

fn theme_of(app: &AppHandle, setting: ThemeSetting) -> bool {
    match setting {
        ThemeSetting::Dark => true,
        ThemeSetting::Light => false,
        ThemeSetting::System => app
            .webview_windows()
            .values()
            .next()
            .and_then(|w| w.theme().ok())
            .map(|t| t == Theme::Dark)
            .unwrap_or(false),
    }
}

fn background(dark: bool) -> Color {
    if dark {
        DARK_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    }
}

/// The theme of the settings on every window of the app
pub fn apply_theme(app: &AppHandle, setting: ThemeSetting) {
    for window in app.webview_windows().values() {
        let _ = window.set_theme(native_theme(setting));
    }
    if let Some(window) = MainWindow::current(app) {
        let dark = window.theme().map(|t| t == Theme::Dark).unwrap_or(false);
        let _ = window.set_background_color(Some(background(dark)));
    }
}

/// Saved bounds only when they are still on a connected display
fn restored_state(app: &AppHandle, saved: Option<WindowState>) -> WindowState {
    let fallback = WindowState {
        x: None,
        y: None,
        width: DEFAULT_SIZE.0,
        height: DEFAULT_SIZE.1,
        maximized: false,
    };
    let Some(saved) = saved else { return fallback };
    let width = saved.width.max(MIN_SIZE.0);
    let height = saved.height.max(MIN_SIZE.1);
    let (Some(x), Some(y)) = (saved.x, saved.y) else {
        return WindowState {
            x: None,
            y: None,
            width,
            height,
            maximized: saved.maximized,
        };
    };
    let monitors = app.available_monitors().unwrap_or_default();
    let visible = monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let position = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);
        let overlap_x = (x + width).min(position.x + size.width) - x.max(position.x);
        let overlap_y = (y + height).min(position.y + size.height) - y.max(position.y);
        overlap_x > 100.0 && overlap_y > 50.0
    });
    if visible {
        WindowState {
            x: Some(x),
            y: Some(y),
            width,
            height,
            maximized: saved.maximized,
        }
    } else {
        warn!("The saved window position is off screen: centred");
        WindowState {
            x: None,
            y: None,
            width,
            height,
            maximized: saved.maximized,
        }
    }
}

/// Where a point of the screen is, for the tray panel
pub fn clamp_to_work_area(
    app: &AppHandle,
    point: PhysicalPosition<f64>,
    size: (f64, f64),
    below: Option<bool>,
) -> PhysicalPosition<f64> {
    let Ok(Some(monitor)) = app.monitor_from_point(point.x, point.y) else {
        return point;
    };
    let area = monitor.work_area();
    let (ax, ay) = (area.position.x as f64, area.position.y as f64);
    let (aw, ah) = (area.size.width as f64, area.size.height as f64);
    let margin = 8.0 * monitor.scale_factor();
    let below = below.unwrap_or(point.y < ay + ah / 2.0);
    let x =
        (point.x - size.0 / 2.0).clamp(ax + margin, (ax + aw - size.0 - margin).max(ax + margin));
    let y = if below { point.y } else { point.y - size.1 };
    let y = y.clamp(ay + margin, (ay + ah - size.1 - margin).max(ay + margin));
    PhysicalPosition::new(x, y)
}
