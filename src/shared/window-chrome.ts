/**
 * The title bar row: its height, used by the page (`TitleBar.vue`) and, as
 * the traffic lights' position on macOS, by the app (`src-tauri/src/window.rs`).
 * The window's colour before the page paints is the row's backdrop (the
 * `mica` role of the renderer): #f2f2f2 light, #161b19 dark, also in window.rs.
 */
export const TITLE_BAR_HEIGHT = 32
