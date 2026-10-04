//! Talking to the creature: the widget runs the user's own `claude` CLI headless and
//! streams the answer into the page. No API key, no new billing — the same Claude Code,
//! tools included, in a dedicated folder (`~/.claude-pet/chat`) with one continuous
//! conversation.
//!
//! Deliberately **not** an HTTP route on the daemon: a localhost endpoint that starts a
//! full agent is a local code-execution surface for anything that learns the token. Here
//! only this app's own webview can start a run, through Tauri IPC.
//!
//! `--permission-mode auto`: a full agent with nobody there to click "allow", guarded by
//! Claude Code's own safety classifier rather than `bypassPermissions`. The prompt goes
//! on stdin, never argv, so a message starting with "-" cannot become a flag.

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

const PERSONA: &str = "You are speaking through claude-pet, a small creature on the user's \
desktop. Your replies appear in a small speech bubble: keep them short unless asked for \
detail, in the language the user writes in, plain text or light markdown.";

/// One stream-json line → the event the page cares about, or None.
pub fn parse_stream_line(line: &str) -> Option<Value> {
    let o: Value = serde_json::from_str(line).ok()?;
    match o.get("type")?.as_str()? {
        "stream_event" => {
            let e = o.get("event")?;
            match e.get("type")?.as_str()? {
                "content_block_delta" => {
                    let d = e.get("delta")?;
                    if d.get("type")?.as_str()? != "text_delta" {
                        return None;
                    }
                    Some(json!({ "kind": "delta", "text": d.get("text")?.as_str()? }))
                }
                "content_block_start" => {
                    let b = e.get("content_block")?;
                    if b.get("type")?.as_str()? != "tool_use" {
                        return None;
                    }
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                    Some(json!({ "kind": "tool", "name": name }))
                }
                _ => None,
            }
        }
        "result" => Some(json!({
            "kind": "done",
            "text": o.get("result").and_then(Value::as_str).unwrap_or(""),
            "isError": o.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                || o.get("subtype").and_then(Value::as_str) != Some("success"),
            "costUsd": o.get("total_cost_usd").and_then(Value::as_f64),
            "durationMs": o.get("duration_ms").and_then(Value::as_u64),
        })),
        _ => None,
    }
}

pub struct Session {
    pub id: String,
    pub started: bool,
}

pub fn build_args(session: &Session, model: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--permission-mode", "auto", "--append-system-prompt", PERSONA,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(m) = model {
        args.extend(["--model".into(), m.into()]);
    }
    if session.started {
        args.extend(["--resume".into(), session.id.clone()]);
    } else {
        args.extend(["--session-id".into(), session.id.clone()]);
    }
    args
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// launchd gives a bare PATH, so `claude` is looked up in the usual install places.
fn find_claude() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let mut candidates: Vec<PathBuf> = vec![];
    if let Some(p) = std::env::var_os("CLAUDE_PET_CLAUDE") {
        candidates.push(p.into());
    }
    candidates.push(home.join(".local/bin/claude"));
    candidates.push("/opt/homebrew/bin/claude".into());
    candidates.push("/usr/local/bin/claude".into());
    candidates.into_iter().find(|p| p.is_file())
}

pub struct Chat {
    dir: PathBuf,
    child: Arc<Mutex<Option<Child>>>,
}

impl Chat {
    pub fn new(root: &Path) -> Self {
        Self { dir: root.join("chat"), child: Arc::new(Mutex::new(None)) }
    }

    fn session_file(&self) -> PathBuf {
        self.dir.join("session.json")
    }

    fn save(&self, s: &Session) {
        let _ = fs::create_dir_all(&self.dir);
        let _ = fs::write(self.session_file(), json!({ "id": s.id, "started": s.started }).to_string());
    }

    pub fn session(&self) -> Session {
        let parsed = fs::read_to_string(self.session_file())
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
        if let Some(v) = parsed {
            if let (Some(id), Some(started)) = (v["id"].as_str(), v["started"].as_bool()) {
                return Session { id: id.to_owned(), started };
            }
        }
        let s = Session { id: uuid_v4(), started: false };
        self.save(&s);
        s
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn busy(&self) -> bool {
        self.child.lock().map(|c| c.is_some()).unwrap_or(false)
    }

    /// Start a run; events go to the page as `chat` events. One run at a time.
    pub fn ask(&self, app: AppHandle, text: String, model: Option<String>) -> Result<(), String> {
        if self.busy() {
            return Err("already answering".into());
        }
        let claude = find_claude().ok_or("claude CLI not found (set CLAUDE_PET_CLAUDE)")?;
        let session = self.session();
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!(
            "{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
        );
        let mut child = Command::new(claude)
            .args(build_args(&session, model.as_deref()))
            .current_dir(&self.dir)
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot start claude: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes()); // dropped => closed
        }
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;
        *self.child.lock().map_err(|_| "lock")? = Some(child);
        let _ = app.emit("chat", json!({ "kind": "start" }));

        let slot = Arc::clone(&self.child);
        let dir = self.dir.clone();
        std::thread::spawn(move || {
            let mut finished = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(event) = parse_stream_line(&line) {
                    if event["kind"] == "done" {
                        finished = true;
                        if event["isError"] == false && !session.started {
                            let _ = fs::write(
                                dir.join("session.json"),
                                json!({ "id": session.id, "started": true }).to_string(),
                            );
                        }
                    }
                    let _ = app.emit("chat", event);
                }
            }
            let mut err = String::new();
            let _ = stderr.read_to_string(&mut err);
            let status = slot.lock().ok().and_then(|mut c| c.take()).and_then(|mut c| c.wait().ok());
            if !finished {
                if session.started {
                    // The conversation may be gone (e.g. cleaned up): start fresh next time.
                    let _ = fs::write(dir.join("session.json"), json!({ "id": uuid_v4(), "started": false }).to_string());
                }
                let last = err.trim().lines().last().unwrap_or("").to_owned();
                let why = status.map(|s| s.to_string()).unwrap_or_else(|| "stopped".into());
                let _ = app.emit("chat", json!({ "kind": "error", "message": format!("{why} {last}").trim() }));
            }
        });
        Ok(())
    }

    pub fn cancel(&self) -> bool {
        let pid = self.child.lock().ok().and_then(|c| c.as_ref().map(Child::id));
        match pid {
            // SIGINT first, as a terminal Ctrl-C would: claude stops cleanly.
            Some(pid) => Command::new("kill").args(["-INT", &pid.to_string()]).status().is_ok(),
            None => false,
        }
    }

    pub fn new_conversation(&self) {
        self.cancel();
        self.save(&Session { id: uuid_v4(), started: false });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape copied from a real `claude -p --output-format stream-json
    // --include-partial-messages` run (CLI 2.1.289), paths and ids replaced.
    const FIXTURE: &str = include_str!("../chat-stream.fixture.jsonl");

    #[test]
    fn a_real_stream_reduces_to_tool_deltas_done() {
        let events: Vec<Value> = FIXTURE.lines().filter_map(parse_stream_line).collect();
        let kinds: Vec<&str> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["tool", "delta", "delta", "done"]);
        assert_eq!(events[0]["name"], "Bash");
        let text: String = events.iter().filter(|e| e["kind"] == "delta").map(|e| e["text"].as_str().unwrap()).collect();
        assert_eq!(text, "Il est 15 h 46.");
        assert_eq!(events[3]["isError"], false);
        assert_eq!(events[3]["costUsd"], 0.1357208);
    }

    #[test]
    fn first_message_creates_the_session_then_resumes_it() {
        let first = build_args(&Session { id: "abc".into(), started: false }, None);
        assert_eq!(&first[first.len() - 2..], ["--session-id", "abc"]);
        let next = build_args(&Session { id: "abc".into(), started: true }, Some("sonnet"));
        assert_eq!(&next[next.len() - 2..], ["--resume", "abc"]);
        assert!(next.contains(&"sonnet".to_string()));
        let i = first.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(first[i + 1], "auto");
    }

    #[test]
    fn uuid_is_v4_shaped() {
        let u = uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }
}
