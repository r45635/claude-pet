//! claude-pet widget — a transparent, always-on-top window around `web/index.html`.
//!
//! The Rust side opens the window, hands the page the daemon's URL and the shared token,
//! builds the right-click menu, writes menu preferences to the daemon, and runs the
//! creature's own Claude (chat.rs). The page only reads the daemon's SSE feed.

mod chat;
mod daemon;
mod avatars;
mod hit;
mod menu;
mod settings;

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
    // The native gate: off unless config.json says true, read now, whatever the page did.
    if !settings::chat_enabled(&settings::user_config(&root())) {
        return Err("chat_disabled".into());
    }
    if text.trim().is_empty() {
        return Err("empty_message".into());
    }
    pet.chat.ask(app, text, chat_model())
}

/// A settings-panel patch (`{"stormThreshold": 80}`, `{"minStateSeconds": null}`…).
/// The daemon validates every key; the page never writes to it directly.
#[tauri::command]
fn update_prefs(pet: State<'_, Pet>, patch: Value) -> Result<Value, String> {
    let patch = settings::filter_page_patch(patch)?;
    let daemon = pet.daemon.as_ref().ok_or("daemon not configured")?;
    let body = daemon.post("/config", &patch.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

#[tauri::command]
fn chat_cancel(pet: State<'_, Pet>) -> bool {
    pet.chat.cancel()
}

#[tauri::command]
fn show_menu(app: AppHandle, window: Window, pet: State<'_, Pet>, prefs: Value, locale: Option<String>, update: Option<Value>) -> Result<(), String> {
    let locale = locale.unwrap_or_else(|| "en".into());
    if let Ok(mut l) = app.state::<MenuLocale>().0.lock() {
        *l = locale.clone(); // for the native dialogs the menu opens
    }
    let update = update.unwrap_or(Value::Null);
    if let Ok(mut u) = app.state::<MenuUpdate>().0.lock() {
        *u = update.clone(); // the dialogs word themselves from it; the daemon decides
    }
    let mut avatars = vec![("classic".to_owned(), "Classic".to_owned())];
    for a in avatars::list(&root()) {
        // A manifest may name the avatar per language ("names": {"fr": "…"}).
        let name = a["names"][&locale].as_str().or(a["name"].as_str());
        if let (Some(id), Some(name)) = (a["id"].as_str(), name) {
            avatars.push((id.to_owned(), name.to_owned()));
        }
    }
    let chat_on = settings::chat_enabled(&settings::user_config(&root()));
    // The library, from the daemon's cache (localhost, never a network wait here).
    let catalog: Value = pet.daemon.as_ref()
        .and_then(|d| d.get("/avatars/catalog").ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_else(|| serde_json::json!({ "error": "daemon unreachable", "avatars": [] }));
    let library = menu::library_items(&catalog, &locale);
    if let Ok(mut m) = app.state::<MenuLibrary>().0.lock() {
        *m = (catalog, prefs["avatar"].as_str().unwrap_or("classic").to_owned());
    }
    let menu = menu::build(&app, &locale, &prefs, chat_on, pet.chat.busy(), &avatars, &update, library.as_deref()).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// The language the menu was last opened in, for the native dialogs it opens.
struct MenuLocale(std::sync::Mutex<String>);
/// The daemon's update state as the menu last showed it.
struct MenuUpdate(std::sync::Mutex<Value>);
/// The library catalog and the current avatar id, as the menu last showed them.
struct MenuLibrary(std::sync::Mutex<(Value, String)>);

/// The settings' description, for the page to build its panel from.
#[tauri::command]
fn settings_schema() -> String {
    settings::SCHEMA.to_owned()
}

/// Installed avatars for the settings panel: classic first, names in `locale`.
#[tauri::command]
fn list_avatars(locale: Option<String>) -> Vec<Value> {
    let locale = locale.unwrap_or_else(|| "en".into());
    let mut out = vec![serde_json::json!({ "id": "classic", "name": menu::Words::new(&locale).get("menu.avatar.classic") })];
    for a in avatars::list(&root()) {
        let name = a["names"][&locale].as_str().or(a["name"].as_str()).unwrap_or("?").to_owned();
        out.push(serde_json::json!({ "id": a["id"], "name": name }));
    }
    out
}

#[tauri::command]
fn set_always_on_top(window: Window, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// "Advanced settings…" from the panel: the same as the menu item.
#[tauri::command]
fn open_advanced(pet: State<'_, Pet>) -> Result<(), String> {
    let daemon = pet.daemon.as_ref().ok_or("daemon not configured")?;
    daemon.post("/open-config", "").map(|_| ())
}

/// Turning the chat on: only here, after a native confirmation that says what it means.
fn confirm_enable_chat(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<MenuLocale>().0.lock().map(|l| l.clone()).unwrap_or_else(|_| "en".into());
    let w = menu::Words::new(&locale);
    let handle = app.clone();
    app.dialog()
        .message(w.get("dialog.enableChat.body"))
        .title(w.get("dialog.enableChat.title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(w.get("dialog.enableChat.ok"), w.get("dialog.cancel")))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            if let Some(d) = &handle.state::<Pet>().daemon {
                if let Err(e) = d.post("/config", r#"{"chatEnabled":true}"#) {
                    eprintln!("enable chat: {e}");
                }
            }
        });
}

/// "Install vX…": confirm, then ask the daemon, which downloads, verifies and restarts
/// both processes. An unsigned release gets its own, warning-worded confirmation.
fn confirm_update(app: &AppHandle, unsigned: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<MenuLocale>().0.lock().map(|l| l.clone()).unwrap_or_else(|_| "en".into());
    let update = app.state::<MenuUpdate>().0.lock().map(|u| u.clone()).unwrap_or(Value::Null);
    let Some(tag) = update["latest"].as_str().filter(|t| menu::valid_tag(t)).map(str::to_owned) else { return };
    let w = menu::Words::new(&locale);
    let key = if unsigned { "dialog.updateUnsigned" } else { "dialog.update" };
    let handle = app.clone();
    app.dialog()
        .message(w.get(&format!("{key}.body")).replace("{v}", &tag))
        .title(w.get(&format!("{key}.title")).replace("{v}", &tag))
        .kind(if unsigned { MessageDialogKind::Warning } else { MessageDialogKind::Info })
        .buttons(MessageDialogButtons::OkCancelCustom(w.get(&format!("{key}.ok")), w.get("dialog.cancel")))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            if let Some(d) = &handle.state::<Pet>().daemon {
                let body = serde_json::json!({ "allowUnsigned": unsigned }).to_string();
                if let Err(e) = d.post("/update", &body) {
                    eprintln!("update: {e}");
                }
            }
        });
}

/// A clone is never updated behind its owner's back: say how, and offer the release page.
fn explain_update(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<MenuLocale>().0.lock().map(|l| l.clone()).unwrap_or_else(|_| "en".into());
    let update = app.state::<MenuUpdate>().0.lock().map(|u| u.clone()).unwrap_or(Value::Null);
    let Some(tag) = update["latest"].as_str().filter(|t| menu::valid_tag(t)).map(str::to_owned) else { return };
    let w = menu::Words::new(&locale);
    let mut body = w.get("dialog.updateClone.body").replace("{v}", &tag);
    if update["pinnedLocalBuild"] == true {
        body.push_str("\n\n");
        body.push_str(&w.get("dialog.updateClone.pinned"));
    }
    let url = format!("{}/releases/tag/{tag}", env!("CARGO_PKG_REPOSITORY"));
    app.dialog()
        .message(body)
        .title(w.get("dialog.updateClone.title").replace("{v}", &tag))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(w.get("dialog.updateClone.open"), w.get("dialog.close")))
        .show(move |open| {
            if open {
                let _ = std::process::Command::new("open").arg(&url).status();
            }
        });
}

/// "Install"/"Update" from the library: confirm with what the signed catalog says (name,
/// version, author, license, size), then let the daemon download and verify the package,
/// and install it here with the same checks as a drop. Off the menu's thread: a download
/// takes a while. Every outcome reaches the page as an `avatar` event.
fn confirm_library_install(app: &AppHandle, id: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<MenuLocale>().0.lock().map(|l| l.clone()).unwrap_or_else(|_| "en".into());
    let catalog = app.state::<MenuLibrary>().0.lock().map(|m| m.0.clone()).unwrap_or(Value::Null);
    let Some(entry) = catalog["avatars"].as_array().and_then(|a| a.iter().find(|e| e["id"] == id)).cloned() else { return };
    let text = |k: &str, max: usize| -> String { entry[k].as_str().unwrap_or("?").chars().take(max).collect() };
    let name = entry["names"][&locale].as_str().map(|n| n.chars().take(60).collect()).unwrap_or_else(|| text("name", 60));
    let kb = entry["bytes"].as_u64().unwrap_or(0).div_ceil(1024);
    let w = menu::Words::new(&locale);
    let body = w.get("dialog.avatarInstall.body")
        .replace("{name}", &name)
        .replace("{version}", &text("version", 20))
        .replace("{author}", &text("author", 60))
        .replace("{license}", &text("license", 40))
        .replace("{kb}", &kb.to_string());
    let handle = app.clone();
    let id = id.to_owned();
    app.dialog()
        .message(body)
        .title(w.get("dialog.avatarInstall.title").replace("{name}", &name))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(w.get("dialog.avatarInstall.ok"), w.get("dialog.cancel")))
        .show(move |confirmed| {
            if confirmed {
                std::thread::spawn(move || install_from_library(&handle, &id));
            }
        });
}

fn install_from_library(app: &AppHandle, id: &str) {
    let result = (|| -> Result<(String, String), String> {
        let pet = app.state::<Pet>();
        let daemon = pet.daemon.as_ref().ok_or("daemon not configured")?;
        let reply: Value = serde_json::from_str(&daemon.post_slow("/avatars/install", &serde_json::json!({ "id": id }).to_string())?)
            .map_err(|e| e.to_string())?;
        let path = PathBuf::from(reply["path"].as_str().ok_or("no package path")?);
        // The daemon only ever downloads into ~/.claude-pet/.avatar-dl-*/: anything else is refused.
        let folder = path.parent().filter(|p| {
            p.parent() == Some(root().as_path())
                && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(".avatar-dl-"))
        }).ok_or("unexpected package location")?.to_owned();
        let imported = avatars::import(&root(), &path);
        let _ = fs::remove_dir_all(&folder);
        let (installed_id, name) = imported?;
        if installed_id != id {
            let _ = avatars::remove(&root(), &installed_id);
            return Err(format!("the package installs \"{installed_id}\", not \"{id}\""));
        }
        let record = serde_json::json!({
            "source": "library",
            "sha256": reply["sha256"],
            "installed_at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        });
        avatars::write_install_record(&root(), id, &record)?;
        daemon.post("/config", &serde_json::json!({ "avatar": id }).to_string())?;
        Ok((installed_id, name))
    })();
    match result {
        Ok((id, name)) => {
            let _ = app.emit("avatar", serde_json::json!({ "ok": true, "id": id, "name": name }));
        }
        Err(error) => {
            eprintln!("library install {id}: {error}");
            let _ = app.emit("avatar", serde_json::json!({ "ok": false, "error": error }));
        }
    }
}

/// "Remove current avatar…": confirm, delete it (and its backup), fall back to classic.
fn confirm_remove_avatar(app: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let locale = app.state::<MenuLocale>().0.lock().map(|l| l.clone()).unwrap_or_else(|_| "en".into());
    let current = app.state::<MenuLibrary>().0.lock().map(|m| m.1.clone()).unwrap_or_default();
    if current.is_empty() || current == "classic" {
        return;
    }
    let name = avatars::list(&root()).into_iter()
        .find(|a| a["id"] == current.as_str())
        .and_then(|a| a["names"][&locale].as_str().or(a["name"].as_str()).map(str::to_owned))
        .unwrap_or_else(|| current.clone());
    let w = menu::Words::new(&locale);
    let handle = app.clone();
    app.dialog()
        .message(w.get("dialog.avatarRemove.body").replace("{name}", &name))
        .title(w.get("dialog.avatarRemove.title").replace("{name}", &name))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(w.get("dialog.avatarRemove.ok"), w.get("dialog.cancel")))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            // Switch away first, so the page never asks for an avatar that is gone.
            if let Some(d) = &handle.state::<Pet>().daemon {
                let _ = d.post("/config", r#"{"avatar":"classic"}"#);
            }
            match avatars::remove(&root(), &current) {
                Ok(()) => {
                    let _ = handle.emit("avatar-removed", serde_json::json!({ "name": name }));
                }
                Err(e) => eprintln!("remove avatar {current}: {e}"),
            }
        });
}

/// An installed avatar, ready for the page (data: URLs and text, all checked).
#[tauri::command]
fn get_avatar(id: String) -> Result<Value, String> {
    avatars::load(&root(), &id)
}

/// A `.claudepet` dropped on the creature: install it, switch to it, tell the page.
fn install_dropped(app: &AppHandle, path: &Path) {
    match avatars::import(&root(), path) {
        Ok((id, name)) => {
            if let Some(d) = &app.state::<Pet>().daemon {
                let _ = d.post("/config", &serde_json::json!({ "avatar": id }).to_string());
            }
            let _ = app.emit("avatar", serde_json::json!({ "ok": true, "id": id, "name": name }));
        }
        Err(error) => {
            eprintln!("avatar import {}: {error}", path.display());
            let _ = app.emit("avatar", serde_json::json!({ "ok": false, "error": error }));
        }
    }
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
        "chat:enable" => confirm_enable_chat(app),
        "update:install" => confirm_update(app, false),
        "update:install-unsigned" => confirm_update(app, true),
        "update:how" => explain_update(app),
        "avatar:remove" => confirm_remove_avatar(app),
        lib if lib.starts_with("lib:install:") || lib.starts_with("lib:update:") => {
            if let Some(id) = lib.rsplit(':').next().filter(|id| avatars::valid_id(id)) {
                confirm_library_install(app, id);
            }
        }
        "chat:disable" => {
            pet.chat.cancel();
            post("/config", r#"{"chatEnabled":false}"#);
        }
        "settings:open" => {
            let _ = app.emit("panel", serde_json::json!({ "mode": "settings" }));
        }
        "zoom:in" | "zoom:out" | "zoom:reset" => {
            let _ = app.emit("zoom", serde_json::json!({ "dir": &id[5..] }));
        }
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
        "avatars:folder" => {
            let dir = avatars::dir(&root());
            let _ = fs::create_dir_all(&dir);
            let _ = std::process::Command::new("open").arg(dir).status();
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// The page's latest drawn shapes; the tracker in hit.rs lets clicks through elsewhere.
#[tauri::command]
fn set_hit_regions(hit: State<'_, hit::HitRegions>, shapes: Vec<hit::Shape>) {
    if let Ok(mut current) = hit.0.lock() {
        // One log line when the count changes: enough to see the page is reporting.
        if current.as_ref().map(Vec::len) != Some(shapes.len()) {
            eprintln!("hit regions: {} shape(s)", shapes.len());
        }
        *current = Some(shapes);
    }
}

/// Where the creature stood and whether it stays on top, from config.json. A saved spot
/// that is on no screen any more (a monitor unplugged) is ignored.
fn restore_window(window: &tauri::WebviewWindow) {
    let cfg = settings::user_config(&root());
    let _ = window.set_always_on_top(settings::always_on_top(&cfg));
    let Some((x, y)) = settings::saved_position(&cfg) else { return };
    let on_screen = window.available_monitors().unwrap_or_default().iter().any(|m| {
        let scale = m.scale_factor();
        let p = m.position().to_logical::<f64>(scale);
        let s = m.size().to_logical::<f64>(scale);
        x >= p.x && y >= p.y && x < p.x + s.width - 20.0 && y < p.y + s.height - 20.0
    });
    if on_screen {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Save the creature's spot once a drag has settled (1 s without moving), but not while
/// the chat or settings panel has grown the window: that position is not the creature's.
fn spawn_position_saver(app: AppHandle, window: tauri::WebviewWindow) {
    let pending: std::sync::Arc<std::sync::Mutex<Option<std::time::Instant>>> = Default::default();
    let mark = std::sync::Arc::clone(&pending);
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(_) = event {
            if let Ok(mut p) = mark.lock() {
                *p = Some(std::time::Instant::now());
            }
        }
    });
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let due = pending.lock().ok().and_then(|p| *p).is_some_and(|t| t.elapsed().as_millis() >= 1000);
        if !due {
            continue;
        }
        if let Ok(mut p) = pending.lock() {
            *p = None;
        }
        let panel_open = app.state::<PanelState>().0.lock().map(|l| l.is_some()).unwrap_or(true);
        if panel_open {
            continue;
        }
        let (Ok(pos), Ok(scale)) = (window.outer_position(), window.scale_factor()) else { continue };
        let p = pos.to_logical::<f64>(scale);
        let body = serde_json::json!({ "position": { "x": p.x.round() as i64, "y": p.y.round() as i64 } }).to_string();
        if let Some(d) = &app.state::<Pet>().daemon {
            let _ = d.post("/config", &body);
        }
    });
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
            app.manage(hit::HitRegions::default());
            app.manage(MenuLocale(std::sync::Mutex::new("en".into())));
            app.manage(MenuUpdate(std::sync::Mutex::new(Value::Null)));
            app.manage(MenuLibrary(std::sync::Mutex::new((Value::Null, "classic".into()))));
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
            if let Some(window) = app.get_webview_window("pet") {
                hit::spawn_tracker(app.handle().clone(), window.clone());
                restore_window(&window);
                spawn_position_saver(app.handle().clone(), window.clone());
                // Drop a .claudepet on the creature to install it (no plugin: a window event).
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        for path in paths.iter().filter(|p| p.extension().is_some_and(|e| e == "claudepet")) {
                            install_dropped(&handle, path);
                        }
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![chat_ask, chat_cancel, update_prefs, show_menu, resize, layout_panel,
            set_hit_regions, get_avatar, settings_schema, list_avatars, set_always_on_top, open_advanced])
        .run(tauri::generate_context!())
        .expect("claude-pet widget failed to start");
}
