//! Writes to the daemon (menu preferences) go through Rust, over a plain HTTP/1.1 request
//! on 127.0.0.1 — no webview `fetch`, no CORS, no extra crate. The page only *reads* the
//! daemon (its SSE feed).

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
        let mut stream = TcpStream::connect(&self.addr).map_err(|e| format!("daemon unreachable: {e}"))?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let request = format!(
            "POST {path}?token={} HTTP/1.1\r\nHost: {}\r\nContent-Type: text/plain\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.token,
            self.addr,
            body.len()
        );
        stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
        let mut response = String::new();
        stream.read_to_string(&mut response).map_err(|e| e.to_string())?;
        let (head, payload) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
        let status = head.split_whitespace().nth(1).unwrap_or("0");
        if status.starts_with('2') {
            Ok(payload.to_owned())
        } else {
            Err(format!("daemon answered {status}: {payload}"))
        }
    }
}
