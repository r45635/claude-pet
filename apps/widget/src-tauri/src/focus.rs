//! "Go to the session": bring the app a Claude Code session runs in (VS Code, Terminal,
//! iTerm…) to the front, from the menu.
//!
//! The hooks give each session's `claude` pid (the daemon's GET /sessions, native only).
//! Its app is the first ancestor macOS knows as a regular application — measured: `claude`
//! → `Code Helper (Plugin)` → `Code`; in a terminal, `claude` → `zsh` → `login` → Terminal.
//! Activating an *application* needs no permission. Its exact window or tab would need
//! Accessibility: out of scope, so with several VS Code windows the last one used comes up.

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

/// One session as the menu shows it: its app's name, and its status.
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub sid: String,
    pub app_pid: i32,
    pub app_name: String,
    pub status: String,
}

/// claude pid → its app (pid, name), or None when no app hosts it. Pids are stable while alive.
#[derive(Default)]
pub struct Hosts(pub Mutex<HashMap<i32, Option<(i32, String)>>>);

/// The parent and command of a pid, from `ps` (None when gone).
fn parent(pid: i32) -> Option<i32> {
    let out = Command::new("ps").args(["-o", "ppid=", "-p", &pid.to_string()]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Walk up from `pid` to the first process that is a regular macOS application.
pub fn host_app(pid: i32, is_app: &dyn Fn(i32) -> Option<String>, parent_of: &dyn Fn(i32) -> Option<i32>) -> Option<(i32, String)> {
    let mut p = pid;
    for _ in 0..12 {
        if let Some(name) = is_app(p) {
            return Some((p, name));
        }
        p = parent_of(p)?;
        if p <= 1 {
            return None;
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn regular_app(pid: i32) -> Option<String> {
    use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication};
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
    if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
        return None;
    }
    Some(app.localizedName().map(|n| n.to_string()).unwrap_or_else(|| "?".into()))
}
#[cfg(not(target_os = "macos"))]
fn regular_app(_pid: i32) -> Option<String> {
    None
}

/// The sessions with their app, from the daemon's GET /sessions body. Unknown hosts are skipped.
pub fn sessions(body: &str, hosts: &Hosts) -> Vec<Session> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return vec![] };
    let mut out = vec![];
    for s in v["sessions"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let (Some(sid), Some(pid)) = (s["id"].as_str(), s["pid"].as_i64()) else { continue };
        let pid = pid as i32;
        let host = {
            let mut cache = hosts.0.lock().unwrap_or_else(|e| e.into_inner());
            cache.entry(pid).or_insert_with(|| host_app(pid, &regular_app, &parent)).clone()
        };
        if let Some((app_pid, app_name)) = host {
            out.push(Session { sid: sid.to_owned(), app_pid, app_name, status: s["status"].as_str().unwrap_or("idle").to_owned() });
        }
    }
    out
}

/// Bring the app to the front (all its windows' app, not a given window).
#[cfg(target_os = "macos")]
pub fn activate(app_pid: i32) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    NSRunningApplication::runningApplicationWithProcessIdentifier(app_pid)
        .is_some_and(|app| app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows))
}
#[cfg(not(target_os = "macos"))]
pub fn activate(_app_pid: i32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_is_the_first_regular_app_above_claude() {
        // claude 300 → Code Helper 200 → Code 100 (an app) → launchd
        let parents = |p: i32| match p { 300 => Some(200), 200 => Some(100), 100 => Some(1), _ => None };
        let apps = |p: i32| (p == 100).then(|| "Code".to_owned());
        assert_eq!(host_app(300, &apps, &parents), Some((100, "Code".into())));
        let none = |_: i32| None;
        assert_eq!(host_app(300, &none, &parents), None, "no app above: nothing to bring forward");
        assert_eq!(host_app(999, &apps, &parents), None, "a gone pid");
    }

    /// Machine-dependent: run by hand (`cargo test -- --ignored`) from a terminal or VS Code;
    /// the test's own process tree must lead to that app.
    #[test]
    #[ignore]
    fn this_process_is_hosted_by_a_real_app() {
        let host = host_app(std::process::id() as i32, &regular_app, &parent);
        eprintln!("host app: {host:?}");
        assert!(host.is_some());
    }

    #[test]
    fn sessions_without_a_pid_or_a_host_are_left_out() {
        let hosts = Hosts::default();
        hosts.0.lock().unwrap().insert(42, Some((7, "Terminal".into())));
        hosts.0.lock().unwrap().insert(43, None);
        let body = r#"{"sessions":[{"id":"aaaa1111","pid":42,"status":"waiting"},{"id":"bbbb2222","pid":43},{"id":"cccc3333"}]}"#;
        assert_eq!(sessions(body, &hosts), vec![Session { sid: "aaaa1111".into(), app_pid: 7, app_name: "Terminal".into(), status: "waiting".into() }]);
        assert_eq!(sessions("not json", &hosts), vec![]);
    }
}
