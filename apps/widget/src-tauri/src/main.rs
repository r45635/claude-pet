//! claude-pet widget — a transparent, always-on-top window around `web/index.html`.
//!
//! The Rust side does one thing besides opening the window: it reads the daemon's
//! `endpoint.json` and hands it to the page, so the webview needs no fs permission.

use std::path::PathBuf;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// `window.__CLAUDE_PET__ = {url, token}`, or `null` when no daemon has run yet — the page
/// then shows its "no signal" look rather than pretending to be asleep.
fn endpoint_script() -> String {
    let root = std::env::var_os("CLAUDE_PET_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude-pet"));
    // Re-serialised from a parsed value, so nothing but well-formed JSON reaches the script.
    let json = std::fs::read_to_string(root.join("endpoint.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".into());
    format!("window.__CLAUDE_PET__ = {json};")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // A desktop creature, not an app: no Dock icon, no menu bar takeover.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("index.html".into()))
                .title("claude-pet")
                .inner_size(180.0, 180.0)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .always_on_top(true)
                .resizable(false)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .initialization_script(&endpoint_script())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("claude-pet widget failed to start");
}
