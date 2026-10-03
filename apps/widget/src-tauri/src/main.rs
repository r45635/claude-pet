//! claude-pet widget — a transparent, always-on-top window around `web/index.html`.
//!
//! The Rust side does one thing besides opening the window: it hands the page the daemon's
//! URL and the shared token, so the webview needs no fs permission.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_URL: &str = "http://127.0.0.1:8787";

fn root() -> PathBuf {
    std::env::var_os("CLAUDE_PET_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude-pet"))
}

fn valid(token: &str) -> bool {
    token.len() >= 24 && token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Same read-or-create protocol as packages/collector/src/token.ts: write a private temp
/// file, hard-link it into place (fails if the target exists), so whichever of daemon and
/// widget starts first at login creates the token and the other one reads it.
fn read_or_create_token(file: &Path) -> std::io::Result<String> {
    if let Ok(s) = fs::read_to_string(file) {
        let t = s.trim();
        if valid(t) {
            return Ok(t.to_owned());
        }
        fs::remove_file(file)?;
    }
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?
        .write_all(format!("{token}\n").as_bytes())?;
    let linked = fs::hard_link(&tmp, file);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(token),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(fs::read_to_string(file)?.trim().to_owned()),
        Err(e) => Err(e),
    }
}

/// `window.__CLAUDE_PET__ = {url, token}`. The URL comes from the daemon's last
/// `endpoint.json` when there is one (custom port), else the default; the token is the
/// persistent shared one. On failure, `null`: the page shows "no signal", never "asleep".
fn endpoint_script() -> String {
    let root = root();
    let url = fs::read_to_string(root.join("endpoint.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_URL.to_owned());
    // Built with serde_json, so nothing but well-formed JSON reaches the script.
    let json = match read_or_create_token(&root.join("token")) {
        Ok(token) => serde_json::json!({ "url": url, "token": token }).to_string(),
        Err(_) => "null".to_owned(),
    };
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
