//! Writes to the daemon (menu preferences) go through Rust, over a plain HTTP/1.1 request
//! on 127.0.0.1 — no webview `fetch`, no CORS, no extra crate. The page only *reads* the
//! daemon (its SSE feed). Every request carries `X-Claude-Pet-Native: 1`, which the daemon
//! requires for native-only writes: a webview cannot send it (daemon.ts, isNative).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub struct Daemon {
    addr: String,
    token: String,
}

impl Daemon {
    /// `url` is like `http://127.0.0.1:8787` (from endpoint.json or the default).
    pub fn new(url: &str, token: String) -> Self {
        let addr = url.trim_start_matches("http://").trim_end_matches('/').to_owned();
        Self { addr, token }
    }

    /// POST `body` (JSON, sent as text/plain like the rest) to `path`; returns the body.
    pub fn post(&self, path: &str, body: &str) -> Result<String, String> {
        self.request("POST", path, body, 5)
    }

    /// The same, for a call that downloads (an avatar package): up to two minutes.
    pub fn post_slow(&self, path: &str, body: &str) -> Result<String, String> {
        self.request("POST", path, body, 120)
    }

    /// GET `path`; returns the body.
    pub fn get(&self, path: &str) -> Result<String, String> {
        self.request("GET", path, "", 5)
    }

    fn request(&self, method: &str, path: &str, body: &str, timeout_s: u64) -> Result<String, String> {
        let mut stream = TcpStream::connect(&self.addr).map_err(|e| format!("daemon unreachable: {e}"))?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(timeout_s)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        // HTTP/1.0: the reply comes as a plain body until the connection closes. Over HTTP/1.1
        // Node answers in chunked encoding, which this client used to read as broken JSON — the
        // library menu said "unavailable" and Sessions ▸ never appeared (v0.5.3).
        let request = format!(
            "{method} {path}?token={} HTTP/1.0\r\nHost: {}\r\nContent-Type: text/plain\r\n\
             X-Claude-Pet-Native: 1\r\nContent-Length: {}\r\n\r\n{body}",
            self.token,
            self.addr,
            body.len()
        );
        stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
        let mut response = String::new();
        stream.read_to_string(&mut response).map_err(|e| e.to_string())?;
        let (head, payload) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
        let status = head.split_whitespace().nth(1).unwrap_or("0");
        let payload = body_of(head, payload);
        if status.starts_with('2') {
            Ok(payload)
        } else {
            Err(format!("daemon answered {status}: {payload}"))
        }
    }
}

/// The body, de-chunked if the server used chunked transfer encoding anyway.
fn body_of(head: &str, payload: &str) -> String {
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if !chunked {
        return payload.to_owned();
    }
    let mut out = String::new();
    let mut rest = payload;
    while let Some((size_line, after)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if size == 0 || after.len() < size {
            break;
        }
        out.push_str(&after[..size]);
        rest = after[size..].strip_prefix("\r\n").unwrap_or(&after[size..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_body_is_kept_as_is() {
        assert_eq!(body_of("HTTP/1.1 200 OK\r\nContent-Length: 2", "{}"), "{}");
    }

    #[test]
    fn a_chunked_body_is_decoded() {
        let head = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nTransfer-Encoding: chunked";
        let payload = "5\r\n{\"a\":\r\n3\r\n12}\r\n0\r\n\r\n";
        assert_eq!(body_of(head, payload), "{\"a\":12}");
        let json: serde_json::Value = serde_json::from_str(&body_of(head, payload)).unwrap();
        assert_eq!(json["a"], 12);
    }

    /// Against the daemon running on this Mac (`cargo test -- --ignored`): every route the
    /// menu reads must come back as JSON.
    #[test]
    #[ignore]
    fn the_live_daemon_answers_json() {
        let root = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".claude-pet");
        let token = std::fs::read_to_string(root.join("token")).unwrap().trim().to_owned();
        let d = Daemon::new("http://127.0.0.1:8787", token);
        for path in ["/avatars/catalog", "/sessions", "/config"] {
            let body = d.get(path).unwrap();
            let json: serde_json::Value = serde_json::from_str(&body).unwrap_or_else(|e| panic!("{path}: {e}: {body:.80}"));
            eprintln!("{path}: {}", &json.to_string()[..json.to_string().len().min(70)]);
        }
    }
}
