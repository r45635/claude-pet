//! The right-click menu, built and handled in Rust. Item ids carry their own action:
//! `pref:<key>:<value>` becomes a POST /config patch, the rest are local actions.

use serde_json::{json, Map, Value};
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
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

    /// A count: `{n}` filled in, the `one`/`other` form picked when the string has both (the
    /// page uses Intl.PluralRules; for the counts the menu bar shows, n ≥ 1, this is the same).
    pub fn plural(&self, key: &str, n: usize) -> String {
        let v = if self.lang[key].is_null() { &self.en[key] } else { &self.lang[key] };
        let form = v.as_str().or(v[if n == 1 { "one" } else { "other" }].as_str()).unwrap_or(key);
        form.replace("{n}", &n.to_string())
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
/// One library entry as the menu needs it: id, display name, and what installing does.
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    pub update: bool,
}

/// The library part of the menu, from the daemon's /avatars/catalog view: avatars not yet
/// installed (to install) and installed ones the catalog ships another version of (to
/// update). `None` = the library is unavailable (not fetched, unsigned, offline…).
pub fn library_items(catalog: &Value, locale: &str) -> Option<Vec<LibraryItem>> {
    if catalog["status"] != "ok" && catalog["avatars"].as_array().map_or(true, Vec::is_empty) {
        return None;
    }
    let avatars = catalog["avatars"].as_array()?;
    let mut out = vec![];
    for a in avatars {
        let Some(id) = a["id"].as_str().filter(|id| crate::avatars::valid_id(id)) else { continue };
        let name = a["names"][locale].as_str().or(a["name"].as_str()).unwrap_or(id);
        let name: String = name.chars().take(60).collect();
        match &a["installed"] {
            Value::Null => out.push(LibraryItem { id: id.to_owned(), name, update: false }),
            inst if inst["updateAvailable"] == true => out.push(LibraryItem { id: id.to_owned(), name, update: true }),
            _ => {}
        }
    }
    Some(out)
}

/// Why the library has nothing to offer right now, as a menu label key.
pub fn library_unavailable_key(catalog: &Value) -> &'static str {
    match catalog["status"].as_str() {
        Some("loading") => "menu.avatar.libraryLoading",
        Some("off") => "menu.avatar.libraryOff",
        _ => "menu.avatar.libraryUnavailable",
    }
}

fn avatar_menu<R: Runtime>(app: &AppHandle<R>, w: &Words, prefs: &Value, avatars: &[(String, String)], library: Option<&[LibraryItem]>, unavailable: &str) -> tauri::Result<tauri::menu::Submenu<R>> {
    let current = prefs["avatar"].as_str().unwrap_or("classic");
    let mut sub = SubmenuBuilder::new(app, w.get("menu.avatar"));
    for (id, name) in avatars {
        let label = if id == "classic" { w.get("menu.avatar.classic") } else { name.clone() };
        let item = CheckMenuItemBuilder::with_id(format!("pref:avatar:{id}"), label).checked(current == id).build(app)?;
        sub = sub.item(&item);
    }
    sub = sub.separator();
    // Updates first: they concern what is already on screen.
    for item in library.unwrap_or(&[]).iter().filter(|i| i.update) {
        let label = w.get("menu.avatar.update").replace("{name}", &item.name);
        sub = sub.item(&MenuItemBuilder::with_id(format!("lib:update:{}", item.id), label).build(app)?);
    }
    let mut lib = SubmenuBuilder::new(app, w.get("menu.avatar.library"));
    match library {
        None => {
            lib = lib.item(&MenuItemBuilder::with_id("lib:none", w.get(unavailable)).enabled(false).build(app)?);
        }
        Some(items) if items.iter().all(|i| i.update) => {
            lib = lib.item(&MenuItemBuilder::with_id("lib:none", w.get("menu.avatar.libraryAllInstalled")).enabled(false).build(app)?);
        }
        Some(items) => {
            for item in items.iter().filter(|i| !i.update) {
                lib = lib.item(&MenuItemBuilder::with_id(format!("lib:install:{}", item.id), item.name.clone()).build(app)?);
            }
        }
    }
    sub = sub.item(&lib.build()?);
    if current != "classic" {
        sub = sub.item(&MenuItemBuilder::with_id("avatar:remove", w.get("menu.avatar.remove")).build(app)?);
    }
    sub.separator()
        .item(&MenuItemBuilder::with_id("avatars:folder", w.get("menu.openAvatarsFolder")).build(app)?)
        .build()
}

/// Size ▸ the presets, then zoom in / out / actual size (also ⌘+ / ⌘− / ⌘0 on the creature).
fn size_menu<R: Runtime>(app: &AppHandle<R>, w: &Words, prefs: &Value) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut sub = SubmenuBuilder::new(app, w.get("menu.size"));
    for (value, label) in [("small", "menu.size.small"), ("medium", "menu.size.medium"), ("large", "menu.size.large")] {
        let item = CheckMenuItemBuilder::with_id(format!("pref:size:{value}"), w.get(label))
            .checked(prefs["size"] == value)
            .build(app)?;
        sub = sub.item(&item);
    }
    sub.separator()
        .item(&MenuItemBuilder::with_id("zoom:in", w.get("menu.zoomIn")).accelerator("CmdOrCtrl+=").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom:out", w.get("menu.zoomOut")).accelerator("CmdOrCtrl+-").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom:reset", w.get("menu.zoomReset")).accelerator("CmdOrCtrl+0").build(app)?)
        .build()
}

/// The menu. With the chat off (the default), its entries are replaced by one native
/// "Enable chat…", which asks for confirmation — the page cannot turn it on.
pub fn build<R: Runtime>(app: &AppHandle<R>, locale: &str, prefs: &Value, chat_on: bool, busy: bool, avatars: &[(String, String)], update: &Value, library: Option<&[LibraryItem]>, unavailable: &str) -> tauri::Result<Menu<R>> {
    let w = Words::new(locale);
    let item = |id: &str, key: &str| MenuItemBuilder::with_id(id, w.get(key)).build(app);
    let mut menu = MenuBuilder::new(app);
    if let Some(u) = update_item(app, &w, update)? {
        menu = menu.item(&u).separator();
    }
    if chat_on {
        let stop = MenuItemBuilder::with_id("chat:stop", w.get("menu.stopAnswering")).enabled(busy).build(app)?;
        menu = menu
            .item(&item("chat:open", "menu.talk")?)
            .item(&stop)
            .item(&item("chat:new", "menu.newConversation")?)
            .item(&radio(app, &w, prefs, "chatModel", "menu.chatModel",
                &[("default", "menu.model.default"), ("sonnet", "menu.model.sonnet"), ("haiku", "menu.model.haiku")])?)
            .item(&item("chat:folder", "menu.openChatFolder")?)
            .item(&item("chat:disable", "menu.disableChat")?);
    } else {
        menu = menu.item(&item("chat:enable", "menu.enableChat")?);
    }
    menu.separator()
        .item(&item("settings:open", "menu.settings")?)
        .item(&avatar_menu(app, &w, prefs, avatars, library, unavailable)?)
        .item(&radio(app, &w, prefs, "temperament", "menu.temperament",
            &[("zen", "menu.temperament.zen"), ("normal", "menu.temperament.normal"), ("nervous", "menu.temperament.nervous")])?)
        .item(&size_menu(app, &w, prefs)?)
        .item(&radio(app, &w, prefs, "display", "menu.display",
            &[("desktop", "menu.display.desktop"), ("menubar", "menu.display.menubar"), ("both", "menu.display.both")])?)
        .item(&toggle(app, &w, prefs, "showSessions", "menu.sessionPastilles")?)
        .item(&toggle(app, &w, prefs, "paused", "menu.pause")?)
        .separator()
        .item(&item("advanced", "menu.advanced")?)
        .separator()
        .item(&item("quit", "menu.quit")?)
        .build()
}

/// A release tag as the daemon reports it (`v1.2.3`, `v1.2.3-rc.1`); anything else is not shown.
pub fn valid_tag(t: &str) -> bool {
    let Some(rest) = t.strip_prefix('v') else { return false };
    let (core, pre) = rest.split_once('-').unwrap_or((rest, ""));
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
        && pre.len() <= 20
        && pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// What the update item does, from the daemon's update state: install it (standalone, signed
/// or after a warning), say it is installing, or explain how (a clone is never touched).
pub fn update_action(update: &Value) -> Option<(&'static str, &'static str, bool)> {
    if update["available"] != true || !update["latest"].as_str().is_some_and(valid_tag) {
        return None;
    }
    Some(if update["installing"] == true {
        ("update:installing", "menu.update.installing", false)
    } else if update["layout"] != "standalone" {
        ("update:how", "menu.update.how", true)
    } else if update["unsigned"] == true {
        ("update:install-unsigned", "menu.update.installUnsigned", true)
    } else {
        ("update:install", "menu.update.install", true)
    })
}

fn update_item<R: Runtime>(app: &AppHandle<R>, w: &Words, update: &Value) -> tauri::Result<Option<MenuItem<R>>> {
    let Some((id, key, enabled)) = update_action(update) else { return Ok(None) };
    let label = w.get(key).replace("{v}", update["latest"].as_str().unwrap_or(""));
    MenuItemBuilder::with_id(id, label).enabled(enabled).build(app).map(Some)
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
    use super::{library_items, library_unavailable_key, pref_patch, update_action, valid_tag, Words};
    use serde_json::json;

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

    #[test]
    fn the_update_item_says_what_will_happen() {
        let base = json!({"available": true, "latest": "v0.4.0", "layout": "standalone", "installing": false, "unsigned": false});
        assert_eq!(update_action(&base).unwrap().0, "update:install");
        let mut u = base.clone();
        u["unsigned"] = json!(true);
        assert_eq!(update_action(&u).unwrap().0, "update:install-unsigned");
        u["installing"] = json!(true);
        assert_eq!(update_action(&u).unwrap(), ("update:installing", "menu.update.installing", false));
        let mut clone = base.clone();
        clone["layout"] = json!("clone");
        assert_eq!(update_action(&clone).unwrap().0, "update:how", "a clone is told, never touched");
        let mut none = base.clone();
        none["available"] = json!(false);
        assert_eq!(update_action(&none), None);
        let mut odd = base.clone();
        odd["latest"] = json!("v0.4.0<script>");
        assert_eq!(update_action(&odd), None, "only a well-formed tag reaches a label");
    }

    #[test]
    fn tags_are_checked_by_structure() {
        for ok in ["v0.4.0", "v1.20.300", "v1.0.0-rc.1"] {
            assert!(valid_tag(ok), "{ok}");
        }
        for bad in ["0.4.0", "v0.4", "v0.4.0 ", "v0.4.0-<x>", "vx.y.z", ""] {
            assert!(!valid_tag(bad), "{bad}");
        }
    }

    #[test]
    fn the_crate_and_package_json_name_the_same_repository() {
        let pkg: serde_json::Value = serde_json::from_str(include_str!("../../../../package.json")).unwrap();
        let repo = pkg["repository"].as_str().unwrap().trim_start_matches("github:");
        assert_eq!(env!("CARGO_PKG_REPOSITORY"), format!("https://github.com/{repo}"));
    }

    #[test]
    fn the_library_offers_new_avatars_and_updates_only() {
        let catalog = json!({"status": "ok", "error": null, "avatars": [
            {"id": "ghost", "name": "Ghost", "names": {"fr": "Fantôme"}, "installed": {"version": "1.0.0", "updateAvailable": true}},
            {"id": "mint", "name": "Mint", "installed": null},
            {"id": "alien", "name": "Alien", "installed": {"version": "1.0.0", "updateAvailable": false}},
            {"id": "../evil", "name": "Evil", "installed": null}
        ]});
        let items = library_items(&catalog, "fr").unwrap();
        let summary: Vec<(String, String, bool)> = items.into_iter().map(|i| (i.id, i.name, i.update)).collect();
        assert_eq!(summary, vec![("ghost".into(), "Fantôme".into(), true), ("mint".into(), "Mint".into(), false)]);
        assert!(library_items(&json!({"status": "error", "error": "catalog: offline", "avatars": []}), "en").is_none(), "unavailable, said so");
        assert_eq!(library_unavailable_key(&json!({"status": "loading"})), "menu.avatar.libraryLoading");
        assert_eq!(library_unavailable_key(&json!({"status": "off"})), "menu.avatar.libraryOff");
        assert_eq!(library_unavailable_key(&json!({"status": "error"})), "menu.avatar.libraryUnavailable");
    }
}
