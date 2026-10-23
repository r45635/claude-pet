//! The menu-bar mode (setting `display`: desktop, menubar, both). An icon in the macOS menu
//! bar whose title is the creature's state at a glance and whose menu is the creature's
//! right-click menu — so the pet can live there instead of on the desktop.
//!
//! Rust reads the daemon's feed itself, on a thread of its own. The page cannot drive the
//! icon: hidden, its webview is throttled by WebKit — measured, frames reached it ~17 s late
//! and in a burst. The page only says when its chat or settings panel opens or closes (the
//! window must show for it) and which language it speaks.
//!
//! The window is never hidden while no icon can bring it back; a click on an icon that has
//! no menu yet (daemon not answering) shows the creature.

use crate::menu::Words;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// The template image: black on transparent, recoloured by macOS (scripts/tray-icon.ts).
const ICON: &[u8] = include_bytes!("../icons/tray.png");
const ID: &str = "claude-pet";

/// macOS App Nap: an accessory app with no visible window is throttled, its feed thread and
/// main run loop included. While the window is hidden (and only then), the widget holds an
/// activity that keeps it out of App Nap — idle system sleep stays allowed.
#[cfg(target_os = "macos")]
pub struct NoNap(objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2::runtime::NSObjectProtocol>>);
// Safety: the token is created and ended only on the main thread (setup, and closures run
// with run_on_main_thread or from synchronous commands); it is never touched elsewhere.
#[cfg(target_os = "macos")]
unsafe impl Send for NoNap {}

#[cfg(target_os = "macos")]
fn keep_awake(on: bool, current: &mut Option<NoNap>) {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let info = NSProcessInfo::processInfo();
    match (on, current.take()) {
        (true, None) => {
            let reason = NSString::from_str("claude-pet shows Claude Code's state in the menu bar");
            *current = Some(NoNap(info.beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason)));
        }
        (true, Some(token)) => *current = Some(token),
        (false, Some(token)) => unsafe { info.endActivity(&token.0) },
        (false, None) => {}
    }
}

#[derive(Default)]
pub struct State {
    pub display: String,
    pub icon: Option<TrayIcon>,
    /// What the current menu was built from; empty = no menu yet.
    menu_key: String,
    title: String,
    tooltip: String,
    /// The chat or settings panel is open: it lives in the window, which must show.
    panel_open: bool,
    /// What was last applied to the window; None = never touched.
    window_shown: Option<bool>,
    #[cfg(target_os = "macos")]
    no_nap: Option<NoNap>,
}

pub struct Tray(pub Mutex<State>);

/// Whether a `display` value wants an icon in the menu bar, and the creature on the desktop.
pub fn wants_icon(display: &str) -> bool {
    display == "menubar" || display == "both"
}
pub fn wants_window(display: &str) -> bool {
    display != "menubar"
}

// ---- what the icon says -----------------------------------------------------------------------

/// The state at a glance, as the icon's title.
fn glyph(state: &str) -> &'static str {
    match state {
        "THINKING" => "💭",
        "READING" => "📖",
        "CODING" => "⌨️",
        "TOOL_CALL" => "🔧",
        "HIGH_LOAD" => "⚡",
        "WAITING" => "✋",
        "DONE" => "✅",
        "ERROR" => "❗",
        _ => "",
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct Look {
    pub title: String,
    pub tooltip: String,
}

/// Title and tooltip from one frame (None = no signal from the daemon). `busy`: the creature's
/// own Claude is answering, which shows as thinking (the page does the same).
pub fn look(frame: Option<&Value>, locale: &str, busy: bool) -> Look {
    let w = Words::new(locale);
    let Some(s) = frame.filter(|s| s["sources"]["hooks"] == true || s["sources"]["statusline"] == true) else {
        return Look { title: "⚠︎".into(), tooltip: format!("claude-pet · {}", w.get("tray.noSignal")) };
    };
    if s["prefs"]["paused"] == true {
        return Look { title: String::new(), tooltip: format!("claude-pet · {}", w.get("tray.paused")) };
    }
    let state = match s["state"].as_str().unwrap_or("IDLE") {
        st if busy && st != "HIGH_LOAD" => "THINKING",
        st => st,
    };
    let sessions = s["sessions"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let waiting = sessions.iter().filter(|x| x["status"] == "waiting").count();
    let mut title = glyph(state).to_owned();
    if waiting > 1 {
        title.push_str(&format!(" {waiting}"));
    }
    let mut parts = vec!["claude-pet".to_owned(), w.get(&format!("tray.state.{state}"))];
    if sessions.len() > 1 {
        parts.push(w.plural("tray.sessions", sessions.len()));
    }
    if waiting > 0 {
        parts.push(w.plural("tray.waiting", waiting));
    }
    if let Some(pct) = s["context_load"].as_u64() {
        let pct = if locale == "fr" { format!("{pct}\u{202f}%") } else { format!("{pct}%") };
        parts.push(w.get("tray.context").replace("{pct}", &pct));
    }
    Look { title, tooltip: parts.join(" · ") }
}

// ---- the icon and the window ------------------------------------------------------------------

/// The icon, without a menu until the first frame.
fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(true)
        .tooltip("claude-pet")
        .show_menu_on_left_click(true)
        .on_tray_icon_event(|icon, event| {
            let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event else { return };
            let app = icon.app_handle();
            let tray = app.state::<Tray>();
            let Ok(mut st) = tray.0.lock() else { return };
            if st.menu_key.is_empty() {
                st.panel_open = true; // no menu to offer: show the creature instead
                apply_window(app, &mut st);
            }
        })
        .build(app)
}

/// The window shows when the display wants it, a panel is open, or no icon could bring it back.
fn apply_window(app: &AppHandle, st: &mut State) {
    let show = wants_window(&st.display) || st.panel_open || st.icon.is_none();
    if st.window_shown == Some(show) {
        return;
    }
    if let Some(w) = app.get_webview_window("pet") {
        let _ = if show { w.show() } else { w.hide() };
    }
    eprintln!("menu bar: creature window {}", if show { "shown" } else { "hidden" });
    st.window_shown = Some(show);
    #[cfg(target_os = "macos")]
    keep_awake(!show, &mut st.no_nap);
}

/// Switch to `display`: create or remove the icon, then show or hide the window.
fn set_display(app: &AppHandle, st: &mut State, display: &str) {
    if st.display == display && st.window_shown.is_some() {
        return;
    }
    st.display = display.to_owned();
    if wants_icon(display) && st.icon.is_none() {
        match build(app) {
            Ok(icon) => {
                st.icon = Some(icon);
                eprintln!("menu bar: icon on ({display})");
            }
            Err(e) => eprintln!("menu bar: no icon: {e}"),
        }
    } else if !wants_icon(display) && st.icon.take().is_some() {
        let _ = app.remove_tray_by_id(ID); // dropping the handle is not enough
        st.menu_key.clear();
        st.title.clear();
        st.tooltip.clear();
        eprintln!("menu bar: icon off ({display})");
    }
    apply_window(app, st);
}

/// At startup, from config.json, before the window is built: no flash of the creature in
/// menu-bar mode. Returns whether the window starts visible.
pub fn init(app: &AppHandle, display: &str) -> bool {
    let mut st = State { display: display.to_owned(), ..State::default() };
    if wants_icon(display) {
        st.icon = build(app).ok();
    }
    let visible = wants_window(display) || st.icon.is_none();
    st.window_shown = Some(visible);
    #[cfg(target_os = "macos")]
    keep_awake(!visible, &mut st.no_nap);
    app.manage(Tray(Mutex::new(st)));
    visible
}

/// The page opened or closed its chat/settings panel; the menu shows the window first, before
/// asking the page to open it (a hidden page would get the request late).
pub fn set_panel_open(app: &AppHandle, open: bool) {
    let tray = app.state::<Tray>();
    let Ok(mut st) = tray.0.lock() else { return };
    st.panel_open = open;
    apply_window(app, &mut st);
}

/// One frame, on the main thread: the display, then (with an icon) its title, tooltip and menu.
fn apply_frame(app: &AppHandle, frame: Option<Value>, look: Look, locale: String) {
    let tray = app.state::<Tray>();
    let Ok(mut st) = tray.0.lock() else { return };
    if let Some(display) = frame.as_ref().and_then(|f| f["prefs"]["display"].as_str()) {
        set_display(app, &mut st, display);
    }
    let Some(icon) = st.icon.clone() else { return };
    if st.title != look.title {
        #[cfg(debug_assertions)]
        eprintln!("menu bar: title {:?} at {}", look.title, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        let _ = icon.set_title(Some(&look.title));
        st.title = look.title;
    }
    if st.tooltip != look.tooltip {
        let _ = icon.set_tooltip(Some(&look.tooltip));
        st.tooltip = look.tooltip;
    }
    let Some(frame) = frame else { return };
    let pet = app.state::<crate::Pet>();
    // The library's state is part of it: a menu built before the catalog arrived must not keep
    // saying "unavailable" (it did, after a restart, until a setting changed).
    let key = serde_json::to_string(&(&frame["prefs"], &locale, &frame["update"], pet.chat.busy(), session_statuses(&frame),
                                      &frame["library"], &frame["avatarsRev"])).unwrap_or_default();
    if st.menu_key != key {
        match crate::main_menu(app, &pet, &frame["prefs"], &locale, frame["update"].clone()) {
            Ok(menu) => {
                let _ = icon.set_menu(Some(menu));
                eprintln!("menu bar: menu rebuilt (library {})", frame["library"]["status"].as_str().unwrap_or("?"));
                st.menu_key = key;
            }
            Err(e) => eprintln!("menu bar: menu: {e}"),
        }
    }
}

/// The sessions and their status: the menu lists them ("go to the session").
fn session_statuses(frame: &Value) -> Vec<(String, String)> {
    frame["sessions"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter()
        .map(|s| (s["id"].as_str().unwrap_or("").to_owned(), s["status"].as_str().unwrap_or("").to_owned()))
        .collect()
}

// ---- the feed ---------------------------------------------------------------------------------

/// Reads the daemon's SSE feed for as long as the widget runs, reconnecting every 2 s. In
/// desktop mode a frame costs a substring search; only with the menu bar on is it parsed,
/// and the main thread is woken only when something it shows changed.
pub fn spawn_feed(app: AppHandle, url: String, token: String) {
    std::thread::spawn(move || {
        let addr = url.trim_start_matches("http://").trim_end_matches('/').to_owned();
        let mut last: Option<(Look, String, String)> = None;
        loop {
            let _ = read_feed(&addr, &token, &mut |frame| {
                let on = frame.contains(r#""display":"menubar""#) || frame.contains(r#""display":"both""#);
                let shown = app.state::<Tray>().0.lock().map(|s| s.icon.is_some()).unwrap_or(false);
                if !on && !shown {
                    return; // desktop mode, and nothing to take down
                }
                let Ok(v) = serde_json::from_str::<Value>(frame) else { return };
                let locale = app.state::<crate::MenuLocale>().0.lock().map(|l| l.clone()).unwrap_or_else(|_| "en".into());
                let busy = app.state::<crate::Pet>().chat.busy();
                let l = look(Some(&v), &locale, busy);
                // Everything the main thread would act on: skip the frame when none of it moved.
                let digest = serde_json::to_string(&(&v["prefs"], &v["update"], busy, session_statuses(&v), &v["library"], &v["avatarsRev"]))
                    .unwrap_or_default();
                let now = (l.clone(), digest, locale.clone());
                if last.as_ref() == Some(&now) {
                    return;
                }
                last = Some(now);
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || apply_frame(&handle, Some(v), l, locale));
            });
            // The daemon is gone (restarting, stopped): say so on the icon, then retry.
            last = None;
            let locale = app.state::<crate::MenuLocale>().0.lock().map(|l| l.clone()).unwrap_or_else(|_| "en".into());
            let handle = app.clone();
            let l = look(None, &locale, false);
            let _ = app.run_on_main_thread(move || apply_frame(&handle, None, l, locale));
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

/// One connection: HTTP/1.0, so the body is the raw event stream (no chunked encoding).
fn read_feed(addr: &str, token: &str, on_frame: &mut dyn FnMut(&str)) -> std::io::Result<()> {
    let mut stream = TcpStream::connect(addr)?;
    // The daemon sends a frame at least every second: 30 s of silence is a dead connection.
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    write!(stream, "GET /events?token={token} HTTP/1.0\r\nHost: {addr}\r\nX-Claude-Pet-Native: 1\r\n\r\n")?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut in_body = false;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let text = line.trim_end_matches(['\r', '\n']);
        if !in_body {
            if text.is_empty() {
                in_body = true;
            } else if text.starts_with("HTTP/") && !text.contains(" 200") {
                return Ok(()); // refused (bad token): retry later
            }
            continue;
        }
        if let Some(frame) = text.strip_prefix("data: ") {
            on_frame(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn display_modes() {
        assert!(!wants_icon("desktop") && wants_window("desktop"));
        assert!(wants_icon("menubar") && !wants_window("menubar"));
        assert!(wants_icon("both") && wants_window("both"));
        assert!(!wants_icon("anything else") && wants_window("anything else"), "unknown: the safe default");
    }

    #[test]
    fn the_icon_is_a_decodable_png() {
        assert!(Image::from_bytes(ICON).is_ok());
    }

    fn frame(state: &str) -> Value {
        json!({ "state": state, "sources": { "hooks": true, "statusline": false }, "prefs": { "paused": false },
                "context_load": 63, "sessions": [ { "status": "waiting" }, { "status": "working" }, { "status": "waiting" } ] })
    }

    #[test]
    fn the_icon_says_the_state_the_sessions_and_the_context() {
        let l = look(Some(&frame("CODING")), "en", false);
        assert_eq!(l.title, "⌨️ 2", "the glyph, and how many sessions wait for you");
        assert_eq!(l.tooltip, "claude-pet · coding · 3 sessions · 2 waiting for you · context 63%");
        let fr = look(Some(&frame("WAITING")), "fr", false);
        assert_eq!(fr.tooltip, "claude-pet · vous attend · 3 sessions · 2 vous attendent · contexte 63\u{202f}%");
    }

    #[test]
    fn no_signal_paused_and_the_creature_s_own_chat() {
        assert_eq!(look(None, "en", false).title, "⚠︎");
        let mut dead = frame("IDLE");
        dead["sources"] = json!({ "hooks": false, "statusline": false });
        assert_eq!(look(Some(&dead), "en", false).title, "⚠︎", "no source live: no signal, not asleep");
        let mut paused = frame("CODING");
        paused["prefs"]["paused"] = json!(true);
        assert_eq!(look(Some(&paused), "en", false).title, "");
        let idle = json!({ "state": "IDLE", "sources": { "hooks": true }, "prefs": {}, "sessions": [] });
        assert_eq!(look(Some(&idle), "en", true).title, "💭", "its own Claude answering shows as thinking");
        assert_eq!(look(Some(&idle), "en", false).tooltip, "claude-pet · asleep");
    }
}
