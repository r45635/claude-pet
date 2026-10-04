//! claude-pet widget — a transparent, always-on-top window around `web/index.html`.
//!
//! The Rust side opens the window, hands the page the daemon's URL and the shared token,
//! builds the right-click menu, writes menu preferences to the daemon, and runs the
//! creature's own Claude (chat.rs). The page only reads the daemon's SSE feed.

mod chat;
mod daemon;
mod menu;

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use serde_json::Value;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};

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

/// The daemon's URL (from its last `endpoint.json`, for a custom port) and the shared token.
fn endpoint() -> (String, Option<String>) {
    let root = root();
    let url = fs::read_to_string(root.join("endpoint.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_URL.to_owned());
    (url, read_or_create_token(&root.join("token")).ok())
}

/// `window.__CLAUDE_PET__ = {url, token}`, or `null` on failure: the page then shows
/// "no signal", never "asleep". Built with serde_json, so only well-formed JSON gets in.
fn endpoint_script(url: &str, token: &Option<String>) -> String {
    let json = match token {
        Some(token) => serde_json::json!({ "url": url, "token": token }).to_string(),
        None => "null".to_owned(),
    };
    format!("window.__CLAUDE_PET__ = {json};")
}

struct Pet {
    chat: chat::Chat,
    daemon: Option<daemon::Daemon>,
}

/// The chat model chosen in the menu, read from config.json at each question.
fn chat_model() -> Option<String> {
    let text = fs::read_to_string(root().join("config.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    match v["ui"]["chatModel"].as_str()? {
        "default" => None,
        m => Some(m.to_owned()),
    }
}

#[tauri::command]
fn chat_ask(app: AppHandle, pet: State<'_, Pet>, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".into());
    }
    pet.chat.ask(app, text, chat_model())
}

#[tauri::command]
fn chat_cancel(pet: State<'_, Pet>) -> bool {
    pet.chat.cancel()
}

#[tauri::command]
fn show_menu(app: AppHandle, window: Window, pet: State<'_, Pet>, prefs: Value) -> Result<(), String> {
    let menu = menu::build(&app, &prefs, pet.chat.busy()).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// Resize from the page (size preference), keeping the window's top-left corner.
#[tauri::command]
fn resize(window: Window, width: f64, height: f64) -> Result<(), String> {
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

/// Open or close the chat panel **without moving the creature on screen**. The window grows
/// toward whichever side has room on the current monitor — bubble above or below, panel
/// extending right or left — and is shifted so the creature's square stays exactly where
/// it was. Returns the layout the page must draw.
#[tauri::command]
fn layout_panel(window: Window, open: bool, pet: f64, panel_w: f64, panel_h: f64) -> Result<Value, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let (mx, my, mw, mh) = match window.current_monitor().map_err(|e| e.to_string())? {
        Some(m) => {
            let a = m.work_area();
            let p = a.position.to_logical::<f64>(scale);
            let s = a.size.to_logical::<f64>(scale);
            (p.x, p.y, s.width, s.height)
        }
        None => (0.0, 0.0, 1e6, 1e6),
    };
    let state: tauri::State<'_, PanelState> = window.state();
    let mut layout = state.0.lock().map_err(|_| "lock")?;

    // Where the creature's square is on screen right now. With the panel open it is
    // derived from the *current* window position, so a drag while chatting is kept.
    let (pet_x, pet_y) = match *layout {
        Some(l) => (
            if l.right { pos.x } else { pos.x + l.width - pet },
            if l.above { pos.y + l.panel_h } else { pos.y },
        ),
        None => (pos.x, pos.y),
    };
    if !open {
        *layout = None;
        window.set_size(LogicalSize::new(pet, pet)).map_err(|e| e.to_string())?;
        window.set_position(tauri::LogicalPosition::new(pet_x, pet_y)).map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({ "open": false }));
    }
    let w = panel_w.max(pet);
    let h = pet + panel_h;
    let above = pet_y - panel_h >= my || pet_y + h > my + mh;
    let right = pet_x + w <= mx + mw || pet_x + pet - w < mx;
    let x = if right { pet_x } else { pet_x + pet - w };
    let y = if above { pet_y - panel_h } else { pet_y };
    window.set_size(LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    *layout = Some(Layout { above, right, width: w, panel_h });
    Ok(serde_json::json!({ "open": true, "above": above, "right": right }))
}

/// The open panel's geometry, to find the creature's square again when it closes.
#[derive(Clone, Copy)]
struct Layout {
    above: bool,
    right: bool,
    width: f64,
    panel_h: f64,
}
struct PanelState(std::sync::Mutex<Option<Layout>>);

fn on_menu(app: &AppHandle, id: &str) {
    let pet = app.state::<Pet>();
    let post = |path: &str, body: &str| {
        if let Some(d) = &pet.daemon {
            if let Err(e) = d.post(path, body) {
                eprintln!("menu {id}: {e}");
            }
        }
    };
    if let Some(patch) = menu::pref_patch(id) {
        post("/config", &patch);
        return;
    }
    match id {
        "chat:open" => {
            let _ = app.emit("chat", serde_json::json!({ "kind": "open" }));
        }
        "chat:stop" => {
            pet.chat.cancel();
        }
        "chat:new" => {
            pet.chat.new_conversation();
            let _ = app.emit("chat", serde_json::json!({ "kind": "reset" }));
        }
        "chat:folder" => {
            let _ = pet.chat.session(); // creates the folder on first use
            let _ = std::process::Command::new("open").arg(pet.chat.dir()).status();
        }
        "advanced" => post("/open-config", ""),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // A desktop creature, not an app: no Dock icon, no menu bar takeover.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let (url, token) = endpoint();
            let script = endpoint_script(&url, &token);
            app.manage(Pet {
                chat: chat::Chat::new(&root()),
                daemon: token.map(|t| daemon::Daemon::new(&url, t)),
            });
            app.manage(PanelState(std::sync::Mutex::new(None)));
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));

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
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![chat_ask, chat_cancel, show_menu, resize, layout_panel])
        .run(tauri::generate_context!())
        .expect("claude-pet widget failed to start");
}
