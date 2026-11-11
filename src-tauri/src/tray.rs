//! Icon in the notification area (menu bar on macOS) with a dot for the state,
//! a native menu on right click and the panel (`#/tray`) on left click. On
//! Linux the menu is the icon's only way: most desktops report no clicks. On
//! Windows the tile is dark when the taskbar is.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::i18n::texts;
use crate::shell::Shell;
use crate::status::Tone;
use crate::window::{TRAY_PANEL, clamp_to_work_area, is_app_url, native_theme};

const TRAY_ID: &str = "tray";
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 440.0;

/// macOS's menu bar takes a template image: the mark in one colour, which
/// macOS paints as the menu bar's text. The dot is in that colour too, hollow
/// while projects sync.
const TEMPLATE: bool = cfg!(target_os = "macos");

const TRAY_PNG: &[u8] = include_bytes!("../icons/tray.png");
const TRAY_DARK_PNG: &[u8] = include_bytes!("../icons/tray-dark.png");
const TEMPLATE_PNG: &[u8] = include_bytes!("../icons/trayTemplate.png");

/// Dot colours of the state vocabulary; none when up to date
fn dot_color(tone: Tone) -> Option<[u8; 3]> {
    match tone {
        Tone::Accent => Some([31, 138, 91]),
        Tone::Info => Some([47, 111, 214]),
        Tone::Warning => Some([232, 147, 12]),
        Tone::Danger => Some([217, 54, 54]),
        Tone::Neutral => Some([138, 143, 141]),
        Tone::Success => None,
    }
}

#[derive(Default)]
pub struct TrayController {
    inner: Mutex<TrayState>,
}

#[derive(Default)]
struct TrayState {
    enabled: bool,
    tone: Option<Tone>,
    tooltip: String,
    icons: HashMap<(Option<Tone>, bool), Image<'static>>,
    /// The panel hid itself on blur: the click on the icon that caused it must not open it again
    hidden_at: Option<Instant>,
}

impl TrayController {
    pub fn enabled(&self) -> bool {
        self.inner.lock().enabled
    }

    pub fn enable(&self, app: &AppHandle) {
        if self.inner.lock().enabled {
            return;
        }
        let (icon, tooltip) = {
            let mut state = self.inner.lock();
            let tone = state.tone;
            (icon(&mut state, tone), state.tooltip.clone())
        };
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .icon_as_template(TEMPLATE)
            .show_menu_on_left_click(cfg!(target_os = "linux"))
            .on_menu_event(|app, event| match event.id().as_ref() {
                "open" => app.state::<Shell>().main_window.show(app),
                "sync_all" => app.state::<Shell>().projects.sync_all(),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } = event
                {
                    toggle_panel(tray.app_handle(), rect);
                }
            });
        if !tooltip.is_empty() {
            builder = builder.tooltip(&tooltip);
        }
        if let Ok(menu) = menu(app) {
            builder = builder.menu(&menu);
        }
        match builder.build(app) {
            Ok(_) => self.inner.lock().enabled = true,
            Err(error) => crate::error!("The tray icon cannot be created: {error}"),
        }
    }

    pub fn disable(&self, app: &AppHandle) {
        if let Some(panel) = app.get_webview_window(TRAY_PANEL) {
            let _ = panel.destroy();
        }
        let _ = app.remove_tray_by_id(TRAY_ID);
        self.inner.lock().enabled = false;
    }

    /// The labels changed (another language)
    pub fn refresh_menu(&self, app: &AppHandle) {
        if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), menu(app)) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    pub fn update(&self, app: &AppHandle, tone: Option<Tone>, tooltip: String) {
        let mut state = self.inner.lock();
        let Some(tray) = app.tray_by_id(TRAY_ID) else {
            state.tone = tone;
            state.tooltip = tooltip;
            return;
        };
        if tone != state.tone {
            state.tone = tone;
            let _ = tray.set_icon(Some(icon(&mut state, tone)));
            let _ = tray.set_icon_as_template(TEMPLATE);
        }
        if tooltip != state.tooltip {
            let _ = tray.set_tooltip(Some(&tooltip));
            state.tooltip = tooltip;
        }
    }
}

/// The taskbar's colours changed (Windows): the tile follows
pub fn refresh_icon(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let mut state = shell.tray.inner.lock();
    let tone = state.tone;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(icon(&mut state, tone)));
    }
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(TRAY_PANEL) {
        let _ = panel.hide();
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let t = texts(app.state::<Shell>().store.settings().language);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", t.open, true, None::<&str>)?,
            &MenuItem::with_id(app, "sync_all", t.sync_all, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?,
        ],
    )
}

fn toggle_panel(app: &AppHandle, rect: Rect) {
    let shell = app.state::<Shell>();
    let Some(panel) = app
        .get_webview_window(TRAY_PANEL)
        .or_else(|| create_panel(app))
    else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    if shell
        .tray
        .inner
        .lock()
        .hidden_at
        .is_some_and(|at| at.elapsed() < Duration::from_millis(300))
    {
        return;
    }
    let scale = panel.scale_factor().unwrap_or(1.0);
    let position = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let panel_size = (PANEL_WIDTH * scale, PANEL_HEIGHT * scale);
    let center = PhysicalPosition::new(
        position.x + size.width / 2.0,
        position.y + size.height / 2.0,
    );
    // Below the icon when the icon is in the top half of the screen (macOS, some Linux panels), above otherwise
    let monitor = app.monitor_from_point(center.x, center.y).ok().flatten();
    let below = monitor
        .map(|m| {
            center.y < m.work_area().position.y as f64 + m.work_area().size.height as f64 / 2.0
        })
        .unwrap_or(false);
    let gap = 6.0 * scale;
    let anchor = if below {
        PhysicalPosition::new(center.x, position.y + size.height + gap)
    } else {
        PhysicalPosition::new(center.x, position.y - gap)
    };
    let target = clamp_to_work_area(app, anchor, panel_size, Some(below));
    let _ = panel.set_position(PhysicalPosition::new(
        target.x.round() as i32,
        target.y.round() as i32,
    ));
    let _ = panel.set_size(PhysicalSize::new(
        panel_size.0.round() as u32,
        panel_size.1.round() as u32,
    ));
    let _ = panel.show();
    let _ = panel.set_focus();
}

fn create_panel(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let theme = app.state::<Shell>().store.settings().theme;
    let panel =
        WebviewWindowBuilder::new(app, TRAY_PANEL, WebviewUrl::App("index.html#/tray".into()))
            .title("On Page Media Downloader")
            .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
            .visible(false)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .theme(native_theme(theme))
            .on_navigation(is_app_url)
            .build();
    match panel {
        Ok(panel) => {
            let handle = app.clone();
            panel.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    handle.state::<Shell>().tray.inner.lock().hidden_at = Some(Instant::now());
                    hide_panel(&handle);
                }
            });
            Some(panel)
        }
        Err(error) => {
            crate::error!("The tray panel cannot be created: {error}");
            None
        }
    }
}

/// The tray picture (32px, drawn for that size by scripts/app-icons.mjs) with a dot for the state
fn icon(state: &mut TrayState, tone: Option<Tone>) -> Image<'static> {
    // Windows' taskbar has a light or dark mode of its own, apart from the apps'
    let dark = cfg!(windows) && taskbar_is_dark();
    if let Some(cached) = state.icons.get(&(tone, dark)) {
        return cached.clone();
    }
    let source = if TEMPLATE {
        TEMPLATE_PNG
    } else if dark {
        TRAY_DARK_PNG
    } else {
        TRAY_PNG
    };
    let base = Image::from_bytes(source).expect("the tray icons are PNG files of the app");
    let (width, height) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    if let Some(color) = tone.and_then(dot_color) {
        if TEMPLATE {
            with_template_dot(&mut rgba, width, tone == Some(Tone::Accent));
        } else {
            with_dot(&mut rgba, width, color);
        }
    }
    let image = Image::new_owned(rgba, width, height);
    state.icons.insert((tone, dark), image.clone());
    image
}

const DOT_OFFSET: f64 = 8.0;
const DOT_RADIUS: f64 = 6.5;
const RING: f64 = 8.0;

/// An anti-aliased dot with a light ring, on an RGBA bitmap
fn with_dot(rgba: &mut [u8], size: u32, [r, g, b]: [u8; 3]) {
    let center = size as f64 - DOT_OFFSET;
    for y in 0..size {
        for x in 0..size {
            let distance =
                ((x as f64 + 0.5 - center).powi(2) + (y as f64 + 0.5 - center).powi(2)).sqrt();
            let i = ((y * size + x) * 4) as usize;
            if distance <= DOT_RADIUS + 0.5 {
                blend(rgba, i, [r, g, b], (DOT_RADIUS + 0.5 - distance).min(1.0));
            } else if distance <= RING + 0.5 {
                blend(rgba, i, [255, 255, 255], (RING + 0.5 - distance).min(1.0));
            }
        }
    }
}

/// The template's dot, where the coloured one would be: the mark cleared
/// around it as the white ring does, then the dot in black, the only colour of
/// a template
fn with_template_dot(rgba: &mut [u8], size: u32, hollow: bool) {
    let center = size as f64 - DOT_OFFSET;
    let hole = 3.0;
    let coverage = |value: f64| value.clamp(0.0, 1.0);
    for y in 0..size {
        for x in 0..size {
            let distance =
                ((x as f64 + 0.5 - center).powi(2) + (y as f64 + 0.5 - center).powi(2)).sqrt();
            if distance > RING + 0.5 {
                continue;
            }
            let i = ((y * size + x) * 4) as usize;
            let kept = 1.0 - coverage(RING + 0.5 - distance);
            let dot = coverage(DOT_RADIUS + 0.5 - distance)
                * if hollow {
                    coverage(distance - hole + 0.5)
                } else {
                    1.0
                };
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            rgba[i + 3] = (255.0 * dot + rgba[i + 3] as f64 * kept * (1.0 - dot)).round() as u8;
        }
    }
}

fn blend(rgba: &mut [u8], i: usize, color: [u8; 3], alpha: f64) {
    let keep = 1.0 - alpha;
    for c in 0..3 {
        rgba[i + c] = (color[c] as f64 * alpha + rgba[i + c] as f64 * keep).round() as u8;
    }
    rgba[i + 3] = (255.0 * alpha + rgba[i + 3] as f64 * keep).round() as u8;
}

/// Windows: `SystemUsesLightTheme` is 0 when the taskbar is dark
#[cfg(windows)]
fn taskbar_is_dark() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    let key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "SystemUsesLightTheme\0".encode_utf16().collect();
    let mut data: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: the names are NUL-terminated UTF-16, data and size point to a u32 of this frame
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut _,
            &mut size,
        )
    };
    status == 0 && data == 0
}

#[cfg(not(windows))]
fn taskbar_is_dark() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dot_sits_in_the_corner() {
        let size = 32u32;
        let mut rgba = vec![0u8; (size * size * 4) as usize];
        with_dot(&mut rgba, size, [217, 54, 54]);
        let at = |x: u32, y: u32| {
            &rgba[((y * size + x) * 4) as usize..((y * size + x) * 4 + 4) as usize]
        };
        assert_eq!(at(24, 24), &[217, 54, 54, 255]);
        assert_eq!(at(2, 2), &[0, 0, 0, 0]);
        let mut template = vec![255u8; (size * size * 4) as usize];
        with_template_dot(&mut template, size, true);
        assert_eq!(at_of(&template, size, 24, 24)[3], 0, "hollow centre");
        assert_eq!(at_of(&template, size, 2, 2), &[255, 255, 255, 255]);
    }

    fn at_of(rgba: &[u8], size: u32, x: u32, y: u32) -> &[u8] {
        &rgba[((y * size + x) * 4) as usize..((y * size + x) * 4 + 4) as usize]
    }
}
