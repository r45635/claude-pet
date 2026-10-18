//! The native side of the settings: what Rust itself must enforce, whatever the page says.
//!
//! - The chat is a full agent and is **off by default**. `chat_ask` reads the file at every
//!   question; the page can turn it off but never on — `filter_page_patch` refuses that, so
//!   a compromised page (an avatar slipping past the sanitizer) cannot re-enable it. Only
//!   the native menu can, after a native confirmation (main.rs, `chat:enable`).
//! - The window position is written by Rust only (when the creature is dragged).
//!
//! The settings themselves are described in packages/collector/src/settings-schema.json,
//! handed to the page as is (`SCHEMA`).

use serde_json::Value;
use std::fs;
use std::path::Path;

pub const SCHEMA: &str = include_str!("../../../../packages/collector/src/settings-schema.json");

/// ~/.claude-pet/config.json as JSON, or Null when missing or unreadable (then every
/// setting is at its default — the chat off).
pub fn user_config(root: &Path) -> Value {
    fs::read_to_string(root.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

/// Only an explicit `true` turns the chat on.
pub fn chat_enabled(cfg: &Value) -> bool {
    cfg["ui"]["chat"]["enabled"] == Value::Bool(true)
}

pub fn always_on_top(cfg: &Value) -> bool {
    cfg["ui"]["alwaysOnTop"].as_bool().unwrap_or(true)
}

pub fn saved_position(cfg: &Value) -> Option<(f64, f64)> {
    let p = &cfg["ui"]["position"];
    Some((p["x"].as_f64()?, p["y"].as_f64()?))
}

/// A patch from the page, minus what the page may not write. Turning the chat on is an
/// error the page can word (`chat_native_only`); the position is silently dropped.
pub fn filter_page_patch(mut patch: Value) -> Result<Value, String> {
    if let Some(obj) = patch.as_object_mut() {
        if obj.get("chatEnabled") == Some(&Value::Bool(true)) {
            return Err("chat_native_only".into());
        }
        obj.remove("position");
    }
    Ok(patch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_chat_is_off_unless_explicitly_on() {
        assert!(!chat_enabled(&Value::Null), "no file: off");
        assert!(!chat_enabled(&json!({ "ui": {} })));
        assert!(!chat_enabled(&json!({ "ui": { "chat": { "enabled": "true" } } })), "a string is not true");
        assert!(chat_enabled(&json!({ "ui": { "chat": { "enabled": true } } })));
    }

    #[test]
    fn the_page_can_turn_the_chat_off_but_never_on() {
        assert_eq!(filter_page_patch(json!({ "chatEnabled": true })).unwrap_err(), "chat_native_only");
        assert_eq!(filter_page_patch(json!({ "chatEnabled": false })).unwrap(), json!({ "chatEnabled": false }));
        assert_eq!(filter_page_patch(json!({ "zoom": 1.2, "position": { "x": 1, "y": 2 } })).unwrap(), json!({ "zoom": 1.2 }));
    }

    #[test]
    fn window_settings_have_safe_defaults() {
        assert!(always_on_top(&Value::Null));
        assert!(!always_on_top(&json!({ "ui": { "alwaysOnTop": false } })));
        assert_eq!(saved_position(&json!({ "ui": { "position": { "x": 10, "y": 20 } } })), Some((10.0, 20.0)));
        assert_eq!(saved_position(&Value::Null), None);
    }

    #[test]
    fn the_schema_is_bundled_and_valid() {
        let v: Value = serde_json::from_str(SCHEMA).unwrap();
        assert!(v["prefs"].as_array().unwrap().iter().any(|p| p["key"] == "chatEnabled" && p["default"] == false));
    }
}
