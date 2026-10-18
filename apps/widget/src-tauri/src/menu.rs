//! The right-click menu, built and handled in Rust. Item ids carry their own action:
//! `pref:<key>:<value>` becomes a POST /config patch, the rest are local actions.

use serde_json::{json, Map, Value};
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// The menu's words, from the same files as the page (web/i18n), bundled in the binary.
/// English is the fallback for a missing key or an unknown language.
const EN: &str = include_str!("../../web/i18n/en.json");
const FR: &str = include_str!("../../web/i18n/fr.json");

pub struct Words {
    lang: Value,
    en: Value,
}

impl Words {
    pub fn new(locale: &str) -> Self {
        let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
        let lang = match locale {
            "fr" => parse(FR),
            _ => Value::Null,
        };
        Self { lang, en: parse(EN) }
    }

    pub fn get(&self, key: &str) -> String {
        self.lang[key].as_str().or(self.en[key].as_str()).unwrap_or(key).to_owned()
    }
}

fn radio<R: Runtime>(
    app: &AppHandle<R>,
    w: &Words,
    prefs: &Value,
    key: &str,
    title: &str,
    options: &[(&str, &str)],
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut sub = SubmenuBuilder::new(app, w.get(title));
    for (value, label) in options {
        let item = CheckMenuItemBuilder::with_id(format!("pref:{key}:{value}"), w.get(label))
            .checked(prefs[key] == *value)
            .build(app)?;
        sub = sub.item(&item);
    }
    sub.build()
}

fn toggle<R: Runtime>(app: &AppHandle<R>, w: &Words, prefs: &Value, key: &str, label: &str) -> tauri::Result<tauri::menu::CheckMenuItem<R>> {
    let on = prefs[key].as_bool().unwrap_or(false);
    CheckMenuItemBuilder::with_id(format!("pref:{key}:{}", !on), w.get(label)).checked(on).build(app)
}

/// Avatar ▸ Classic and every installed one (`avatars`: id, name in the menu's language),
/// plus the folder.
fn avatar_menu<R: Runtime>(app: &AppHandle<R>, w: &Words, prefs: &Value, avatars: &[(String, String)]) -> tauri::Result<tauri::menu::Submenu<R>> {
    let current = prefs["avatar"].as_str().unwrap_or("classic");
    let mut sub = SubmenuBuilder::new(app, w.get("menu.avatar"));
    for (id, name) in avatars {
        let label = if id == "classic" { w.get("menu.avatar.classic") } else { name.clone() };
        let item = CheckMenuItemBuilder::with_id(format!("pref:avatar:{id}"), label).checked(current == id).build(app)?;
        sub = sub.item(&item);
    }
    sub.separator()
        .item(&MenuItemBuilder::with_id("avatars:folder", w.get("menu.openAvatarsFolder")).build(app)?)
        .build()
}

pub fn build<R: Runtime>(app: &AppHandle<R>, locale: &str, prefs: &Value, busy: bool, avatars: &[(String, String)]) -> tauri::Result<Menu<R>> {
    let w = Words::new(locale);
    let item = |id: &str, key: &str| MenuItemBuilder::with_id(id, w.get(key)).build(app);
    let stop = MenuItemBuilder::with_id("chat:stop", w.get("menu.stopAnswering")).enabled(busy).build(app)?;
    MenuBuilder::new(app)
        .item(&item("chat:open", "menu.talk")?)
        .item(&stop)
        .item(&item("chat:new", "menu.newConversation")?)
        .item(&radio(app, &w, prefs, "chatModel", "menu.chatModel",
            &[("default", "menu.model.default"), ("sonnet", "menu.model.sonnet"), ("haiku", "menu.model.haiku")])?)
        .item(&item("chat:folder", "menu.openChatFolder")?)
        .separator()
        .item(&avatar_menu(app, &w, prefs, avatars)?)
        .item(&radio(app, &w, prefs, "temperament", "menu.temperament",
            &[("zen", "menu.temperament.zen"), ("normal", "menu.temperament.normal"), ("nervous", "menu.temperament.nervous")])?)
        .item(&radio(app, &w, prefs, "size", "menu.size",
            &[("small", "menu.size.small"), ("medium", "menu.size.medium"), ("large", "menu.size.large")])?)
        .item(&toggle(app, &w, prefs, "showSessions", "menu.sessionPastilles")?)
        .item(&toggle(app, &w, prefs, "paused", "menu.pause")?)
        .separator()
        .item(&item("advanced", "menu.advanced")?)
        .separator()
        .item(&item("quit", "menu.quit")?)
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
    use super::{pref_patch, Words};

    #[test]
    fn ids_become_config_patches() {
        assert_eq!(pref_patch("pref:size:small").unwrap(), r#"{"size":"small"}"#);
        assert_eq!(pref_patch("pref:paused:true").unwrap(), r#"{"paused":true}"#);
        assert_eq!(pref_patch("quit"), None);
        assert_eq!(pref_patch("pref:avatar:ghost").unwrap(), r#"{"avatar":"ghost"}"#);
    }

    #[test]
    fn the_menu_speaks_the_page_s_language_and_falls_back_to_english() {
        assert_eq!(Words::new("fr").get("menu.quit"), "Quitter claude-pet");
        assert_eq!(Words::new("en").get("menu.quit"), "Quit claude-pet");
        assert_eq!(Words::new("xx").get("menu.size"), "Size", "unknown language: English");
        assert_eq!(Words::new("fr").get("menu.nope"), "menu.nope", "unknown key: the key itself");
    }
}
