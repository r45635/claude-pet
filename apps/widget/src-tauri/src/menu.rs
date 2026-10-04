//! The right-click menu, built and handled in Rust. Item ids carry their own action:
//! `pref:<key>:<value>` becomes a POST /config patch, the rest are local actions.

use serde_json::{json, Map, Value};
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

fn radio<R: Runtime>(
    app: &AppHandle<R>,
    prefs: &Value,
    key: &str,
    title: &str,
    options: &[(&str, &str)],
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut sub = SubmenuBuilder::new(app, title);
    for (value, text) in options {
        let item = CheckMenuItemBuilder::with_id(format!("pref:{key}:{value}"), *text)
            .checked(prefs[key] == *value)
            .build(app)?;
        sub = sub.item(&item);
    }
    sub.build()
}

fn toggle<R: Runtime>(app: &AppHandle<R>, prefs: &Value, key: &str, text: &str) -> tauri::Result<tauri::menu::CheckMenuItem<R>> {
    let on = prefs[key].as_bool().unwrap_or(false);
    CheckMenuItemBuilder::with_id(format!("pref:{key}:{}", !on), text).checked(on).build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>, prefs: &Value, busy: bool) -> tauri::Result<Menu<R>> {
    let stop = MenuItemBuilder::with_id("chat:stop", "Stop answering").enabled(busy).build(app)?;
    MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("chat:open", "Talk…").build(app)?)
        .item(&stop)
        .item(&MenuItemBuilder::with_id("chat:new", "New conversation").build(app)?)
        .item(&radio(app, prefs, "chatModel", "Chat model",
            &[("default", "Default"), ("sonnet", "Sonnet"), ("haiku", "Haiku")])?)
        .item(&MenuItemBuilder::with_id("chat:folder", "Open chat folder").build(app)?)
        .separator()
        .item(&radio(app, prefs, "temperament", "Temperament",
            &[("zen", "Zen"), ("normal", "Normal"), ("nervous", "Nervous")])?)
        .item(&radio(app, prefs, "size", "Size",
            &[("small", "Small"), ("medium", "Medium"), ("large", "Large")])?)
        .item(&toggle(app, prefs, "showSessions", "Session pastilles")?)
        .item(&toggle(app, prefs, "paused", "Pause (sleep)")?)
        .separator()
        .item(&MenuItemBuilder::with_id("advanced", "Advanced settings…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit claude-pet").build(app)?)
        .build()
}

/// `pref:size:small` → `{"size":"small"}`; `pref:paused:true` → `{"paused":true}`.
pub fn pref_patch(id: &str) -> Option<String> {
    let rest = id.strip_prefix("pref:")?;
    let (key, value) = rest.split_once(':')?;
    let value = match value {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        v => Value::String(v.to_owned()),
    };
    let mut patch = Map::new();
    patch.insert(key.to_owned(), value);
    Some(json!(patch).to_string())
}

#[cfg(test)]
mod tests {
    use super::pref_patch;

    #[test]
    fn ids_become_config_patches() {
        assert_eq!(pref_patch("pref:size:small").unwrap(), r#"{"size":"small"}"#);
        assert_eq!(pref_patch("pref:paused:true").unwrap(), r#"{"paused":true}"#);
        assert_eq!(pref_patch("quit"), None);
    }
}
