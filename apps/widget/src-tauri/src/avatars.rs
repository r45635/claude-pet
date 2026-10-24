//! Avatars on disk: `~/.claude-pet/avatars/<id>/`, installed from a dropped `.claudepet`.
//!
//! An avatar is untrusted content. The rules (ids, states, fallbacks, file types, limits)
//! come from the same JSON as the creator tooling (packages/collector/src/avatar-format.json)
//! and are enforced here at import AND at load: file names are checked by structure, file
//! types by their bytes, sizes before they are read. The page then gets data: URLs and
//! text only — it never touches the disk — and sanitizes SVG/CSS itself (web/avatar.js).

use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const FORMAT_JSON: &str = include_str!("../../../../packages/collector/src/avatar-format.json");

fn format() -> &'static Value {
    static FORMAT: OnceLock<Value> = OnceLock::new();
    FORMAT.get_or_init(|| serde_json::from_str(FORMAT_JSON).expect("avatar-format.json is valid JSON"))
}
fn limit(key: &str) -> u64 {
    format()["limits"][key].as_u64().unwrap_or(0)
}

/// `^[a-z0-9][a-z0-9-]{0,39}$`, the format's idPattern, without a regex crate.
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 40
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// A flat file name: no directory, no dot-file, a known extension.
fn valid_file(name: &str, exts: &[&str]) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(c))
        && !name.contains("..")
        && exts.contains(&extension(name).as_str())
}

/// The real type of a file, from its first bytes.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") {
        return Some("png");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let head = head.trim_start();
    if head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")) {
        return Some("svg");
    }
    None
}

fn image_exts() -> Vec<&'static str> {
    vec!["png", "gif", "webp", "jpg", "jpeg", "svg"]
}

/// A css file may not reach outside the avatar (the page re-checks when it scopes it).
/// The forbidden tokens come from the format JSON, same list as the tooling and the page.
fn css_ok(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    format()["cssForbidden"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .all(|token| !t.contains(&token.to_ascii_lowercase()))
        && t.match_indices("url(").all(|(i, _)| t[i + 4..].trim_start().trim_start_matches(['\'', '"']).starts_with('#'))
        && css_strings_ok(text)
}

/// Strings may only hold letters, digits, `_`, `-` and spaces, comments aside — the page's
/// rule (web/avatar.js `cssStringsOk`): a brace or quote inside a string would let a rule
/// escape the avatar's scope.
fn css_strings_ok(text: &str) -> bool {
    let mut bare = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("/*") {
        bare.push_str(&rest[..i]);
        match rest[i + 2..].find("*/") {
            Some(j) => rest = &rest[i + 2 + j + 2..],
            None => return false,
        }
    }
    bare.push_str(rest);
    let b = bare.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'"' || b[i] == b'\'' {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b"_ -".contains(&b[j])) {
                j += 1;
            }
            if j >= b.len() || b[j] != b[i] {
                return false;
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    true
}

/// The format's keyframePattern (`^[A-Za-z_][A-Za-z0-9_-]{0,31}$`) without a regex crate.
fn valid_keyframes(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

/// One motion spec of the `animations` section, strictly: unknown keys and out-of-range
/// values refuse the package (the page re-checks and drops; this refuses loudly).
fn check_motion(at: &str, spec: &Value, enter: bool) -> Result<(), String> {
    let rules = &format()["animations"];
    let s = spec.as_object().ok_or(format!("{at}: must be an object"))?;
    let allowed: &[&str] = if enter {
        &["target", "keyframes", "dur", "ease", "amp", "count"]
    } else {
        &["target", "keyframes", "dur", "ease", "amp", "enter", "fallback"]
    };
    for key in s.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("{at}.{key}: unknown key"));
        }
    }
    if let Some(t) = s.get("target") {
        if !rules["targets"].as_array().unwrap().iter().any(|x| x == t) {
            return Err(format!("{at}.target: unknown target"));
        }
    }
    match s.get("keyframes") {
        None => {}
        Some(Value::Null) if !enter => {}
        Some(Value::String(k)) if valid_keyframes(k) => {}
        _ => return Err(format!("{at}.keyframes: a short keyframes name, or null for no loop")),
    }
    let range = |key: &str| (rules[key][0].as_f64().unwrap(), rules[key][1].as_f64().unwrap());
    match s.get("dur") {
        None => {}
        Some(v) if v == "auto" => {}
        Some(Value::Number(n)) => {
            let (lo, hi) = range("durMs");
            let d = n.as_f64().unwrap_or(-1.0);
            if d.fract() != 0.0 || d < lo || d > hi {
                return Err(format!("{at}.dur: \"auto\" or whole milliseconds {lo}-{hi}"));
            }
        }
        _ => return Err(format!("{at}.dur: \"auto\" or whole milliseconds")),
    }
    match s.get("ease") {
        None => {}
        Some(v) if rules["easings"].as_array().unwrap().contains(v) => {}
        Some(Value::Array(nums)) => {
            let (lo, hi) = range("bezierRange");
            if nums.len() != 4 || !nums.iter().all(|n| n.as_f64().is_some_and(|x| x >= lo && x <= hi)) {
                return Err(format!("{at}.ease: a keyword or 4 cubic-bezier numbers in [{lo}, {hi}]"));
            }
        }
        _ => return Err(format!("{at}.ease: unknown easing")),
    }
    if let Some(a) = s.get("amp") {
        let (lo, hi) = range("ampRange");
        if !a.as_f64().is_some_and(|x| x >= lo && x <= hi) {
            return Err(format!("{at}.amp: a number in [{lo}, {hi}]"));
        }
    }
    if let Some(c) = s.get("count") {
        let hi = rules["maxCount"].as_f64().unwrap();
        if !c.as_f64().is_some_and(|x| x.fract() == 0.0 && x >= 1.0 && x <= hi) {
            return Err(format!("{at}.count: a whole number 1-{hi}"));
        }
    }
    Ok(())
}

/// The manifest's optional `animations` section (docs/AVATARS.md).
fn check_animations(m: &Value) -> Result<(), String> {
    let a = match m.get("animations") {
        None | Some(Value::Null) => return Ok(()),
        Some(v) => v.as_object().ok_or("\"animations\" must be an object")?,
    };
    for key in a.keys() {
        if key != "profile" && key != "states" {
            return Err(format!("animations.{key}: unknown key"));
        }
    }
    if let Some(p) = a.get("profile") {
        if !format()["animations"]["profiles"].as_array().unwrap().iter().any(|x| x == p) {
            return Err("animations.profile: unknown profile".into());
        }
    }
    let Some(states_v) = a.get("states") else { return Ok(()) };
    let states = states_v.as_object().ok_or("animations.states: must be an object")?;
    let known: Vec<&str> = format()["states"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    for (state, spec) in states {
        let at = format!("animations.states.{state}");
        if !known.contains(&state.as_str()) {
            return Err(format!("{at}: unknown state"));
        }
        let s = spec.as_object().ok_or(format!("{at}: must be an object"))?;
        if let Some(f) = s.get("fallback") {
            if !f.as_str().is_some_and(|f| states.contains_key(f)) {
                return Err(format!("{at}.fallback: not a state defined in animations.states"));
            }
            if s.len() > 1 {
                return Err(format!("{at}: a fallback entry carries nothing else"));
            }
            continue;
        }
        check_motion(&at, spec, false)?;
        if let Some(e) = s.get("enter") {
            check_motion(&format!("{at}.enter"), e, true)?;
        }
    }
    Ok(())
}

/// Check a manifest; returns the files it references.
pub fn check_manifest(m: &Value) -> Result<Vec<String>, String> {
    let fmt = format();
    if m.get("format") != Some(&fmt["format"]) {
        return Err(format!("\"format\" must be {}", fmt["format"]));
    }
    let id = m["id"].as_str().unwrap_or("");
    if !valid_id(id) {
        return Err("\"id\" must be lowercase letters, digits and dashes (1-40)".into());
    }
    if fmt["builtin"].as_array().is_some_and(|b| b.iter().any(|x| x == id)) {
        return Err(format!("\"id\" \"{id}\" is reserved for a built-in avatar"));
    }
    match m["name"].as_str() {
        Some(n) if !n.is_empty() && n.chars().count() <= 60 => {}
        _ => return Err("\"name\" is required (1-60 characters)".into()),
    }
    if !m["license"].is_null()
        && !m["license"].as_str().is_some_and(|l| !l.is_empty() && l.chars().count() <= 40)
    {
        return Err("\"license\" must be 1-40 characters (an SPDX identifier)".into());
    }
    let mut files: Vec<String> = vec![];
    let mut add = |field: &str, name: &Value, exts: &[&str]| -> Result<(), String> {
        let n = name.as_str().filter(|n| valid_file(n, exts)).ok_or(format!("{field}: not a plain file name with an allowed extension"))?;
        if !files.iter().any(|f| f == n) {
            files.push(n.to_owned());
        }
        Ok(())
    };
    match m["kind"].as_str() {
        Some("images") => {
            let states = m["states"].as_object().ok_or("\"states\" is required for kind \"images\"")?;
            if !states.contains_key("IDLE") {
                return Err("\"states.IDLE\" is required".into());
            }
            let known: Vec<&str> = fmt["states"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            for (state, file) in states {
                if state != "ACTIVE" && !known.contains(&state.as_str()) {
                    return Err(format!("\"states.{state}\": unknown state"));
                }
                add(&format!("states.{state}"), file, &image_exts())?;
            }
        }
        Some("svg") => {
            add("svg", &m["svg"], &["svg"])?;
        }
        _ => return Err("\"kind\" must be \"images\" or \"svg\"".into()),
    }
    // Both kinds may ship a stylesheet: it is how pictures get motion too.
    if !m["css"].is_null() {
        add("css", &m["css"], &["css"])?;
    }
    check_animations(m)?;
    Ok(files)
}

/// Bytes of a referenced file, checked: size, and real type matching the extension.
fn checked(name: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > limit("fileBytes") {
        return Err(format!("{name}: too large"));
    }
    let ext = extension(name);
    if ext == "css" {
        let text = std::str::from_utf8(bytes).map_err(|_| format!("{name}: not UTF-8"))?;
        return if css_ok(text) { Ok(()) } else { Err(format!("{name}: @import, @font-face, escapes and url() to anything but #id are not allowed")) };
    }
    let expected = if ext == "jpeg" { "jpg" } else { ext.as_str() };
    match sniff(bytes) {
        Some(real) if real == expected => Ok(()),
        real => Err(format!("{name}: content is {}, not .{ext}", real.unwrap_or("unknown"))),
    }
}

pub fn dir(root: &Path) -> PathBuf {
    root.join("avatars")
}

fn read_manifest(path: &Path) -> Result<Value, String> {
    let meta = fs::metadata(path).map_err(|_| "no manifest.json".to_string())?;
    if meta.len() > limit("manifestBytes") {
        return Err("manifest.json is too large".into());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("manifest.json: {e}"))
}

/// Installed avatars, valid ones only: `[{id, name, author, kind}]`, sorted by name.
pub fn list(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = fs::read_dir(dir(root))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !valid_id(&name) {
                return None; // skips <id>.bak and temporary import folders
            }
            let m = read_manifest(&entry.path().join("manifest.json")).ok()?;
            check_manifest(&m).ok()?;
            // Optional per-language names, strings only, kept short.
            let names: Map<String, Value> = m["names"].as_object().map(|o| {
                o.iter()
                    .filter(|(k, v)| k.len() <= 8 && v.as_str().is_some_and(|n| !n.is_empty() && n.chars().count() <= 60))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            }).unwrap_or_default();
            (m["id"] == name.as_str()).then(|| json!({ "id": name, "name": m["name"], "names": names, "author": m["author"],
                                                       "kind": m["kind"], "version": m["version"], "license": m["license"] }))
        })
        .collect();
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}

/// What the page needs to draw an avatar: for kind images, every state resolved through
/// the fallbacks to a data: URL; for kind svg, the SVG and CSS text.
pub fn load(root: &Path, id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("bad avatar id".into());
    }
    let base = dir(root).join(id);
    let m = read_manifest(&base.join("manifest.json"))?;
    let files = check_manifest(&m)?;
    if m["id"] != id {
        return Err("manifest id does not match its folder".into());
    }
    let mut total = 0u64;
    let mut contents: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for name in &files {
        let path = base.join(name);
        let size = fs::metadata(&path).map_err(|_| format!("{name}: missing"))?.len();
        total += size;
        if size > limit("fileBytes") || total > limit("totalBytes") {
            return Err(format!("{name}: too large"));
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        checked(name, &bytes)?;
        contents.insert(name.clone(), bytes);
    }

    let mut out = Map::new();
    for key in ["id", "name", "kind", "anchors", "hitbox", "animations"] {
        if !m[key].is_null() {
            out.insert(key.into(), m[key].clone());
        }
    }
    let text = |f: &Value| -> Result<String, String> {
        let n = f.as_str().unwrap_or("");
        String::from_utf8(contents[n].clone()).map_err(|_| format!("{n}: not UTF-8"))
    };
    if !m["css"].is_null() {
        out.insert("css".into(), Value::String(text(&m["css"])?));
    }
    if m["kind"] == "images" {
        let fmt = format();
        let states = m["states"].as_object().unwrap();
        let mut images = Map::new();
        for state in fmt["states"].as_array().unwrap().iter().filter_map(Value::as_str) {
            // Follow the fallbacks (THINKING → ACTIVE → IDLE …) to a declared picture.
            let mut key = state.to_owned();
            let mut hops = 0;
            while !states.contains_key(&key) && hops < 8 {
                match fmt["fallback"][&key].as_str() {
                    Some(next) => key = next.to_owned(),
                    None => break,
                }
                hops += 1;
            }
            let file = states.get(&key).or(states.get("IDLE")).and_then(Value::as_str).unwrap_or("");
            let mime = fmt["imageTypes"][extension(file)].as_str().unwrap_or("application/octet-stream");
            let b64 = base64::engine::general_purpose::STANDARD.encode(&contents[file]);
            images.insert(state.into(), Value::String(format!("data:{mime};base64,{b64}")));
        }
        out.insert("images".into(), Value::Object(images));
    } else {
        out.insert("svg".into(), Value::String(text(&m["svg"])?));
    }
    Ok(Value::Object(out))
}

/// Uninstall: the avatar's folder and its `.bak`. The built-in `classic` cannot be removed.
pub fn remove(root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) || format()["builtin"].as_array().is_some_and(|b| b.iter().any(|x| x == id)) {
        return Err(format!("\"{id}\" cannot be removed"));
    }
    let target = dir(root).join(id);
    if !target.join("manifest.json").exists() {
        return Err(format!("\"{id}\" is not installed"));
    }
    fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(dir(root).join(format!("{id}.bak")));
    Ok(())
}

/// Where an installed avatar came from: `.install.json` in its folder, written after a
/// library install (absent = dropped by hand). load() and list() never read it: they only
/// read manifest.json and the files it references.
pub fn write_install_record(root: &Path, id: &str, record: &Value) -> Result<(), String> {
    if !valid_id(id) {
        return Err("bad avatar id".into());
    }
    let folder = dir(root).join(id);
    if !folder.join("manifest.json").exists() {
        return Err(format!("\"{id}\" is not installed"));
    }
    fs::write(folder.join(".install.json"), record.to_string()).map_err(|e| e.to_string())
}

/// Install a `.claudepet`: every entry flat, bounded and checked before anything is
/// written; then an atomic swap, keeping the previous version as `<id>.bak`.
pub fn import(root: &Path, archive: &Path) -> Result<(String, String), String> {
    let file = fs::File::open(archive).map_err(|e| format!("cannot open: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "not a .claudepet (zip) file".to_string())?;
    if zip.len() as u64 > limit("files") + 1 + 8 {
        return Err("too many files".into());
    }
    let mut entries: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let raw = entry.name().to_owned();
        if entry.is_dir() || raw.starts_with("__MACOSX/") {
            continue; // folders and Finder's metadata are ignored, never extracted
        }
        // enclosed_name() refuses absolute paths and `..` (zip-slip); flat files only.
        let name = entry.enclosed_name().and_then(|p| p.to_str().map(str::to_owned)).ok_or(format!("{raw}: unsafe path"))?;
        if name.contains('/') || name.starts_with('.') {
            return Err(format!("{raw}: files must be at the top level"));
        }
        if entry.size() > limit("fileBytes") {
            return Err(format!("{name}: too large"));
        }
        let mut bytes = Vec::new();
        // Never trust the declared size: read at most the limit + 1.
        entry.by_ref().take(limit("fileBytes") + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > limit("fileBytes") {
            return Err(format!("{name}: too large"));
        }
        total += bytes.len() as u64;
        if total > limit("totalBytes") {
            return Err("the avatar is too large".into());
        }
        entries.insert(name, bytes);
    }
    let manifest_bytes = entries.get("manifest.json").ok_or("no manifest.json")?;
    if manifest_bytes.len() as u64 > limit("manifestBytes") {
        return Err("manifest.json is too large".into());
    }
    let m: Value = serde_json::from_slice(manifest_bytes).map_err(|e| format!("manifest.json: {e}"))?;
    let files = check_manifest(&m)?;
    for name in &files {
        checked(name, entries.get(name).ok_or(format!("{name}: referenced but missing"))?)?;
    }
    let id = m["id"].as_str().unwrap().to_owned();
    let name = m["name"].as_str().unwrap().to_owned();

    // Write only what the manifest references, into a temporary folder, then swap.
    let avatars = dir(root);
    fs::create_dir_all(&avatars).map_err(|e| e.to_string())?;
    let tmp = avatars.join(format!(".import-{id}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir(&tmp).map_err(|e| e.to_string())?;
    for f in files.iter().chain(std::iter::once(&"manifest.json".to_string())) {
        fs::write(tmp.join(f), &entries[f]).map_err(|e| e.to_string())?;
    }
    let target = avatars.join(&id);
    let backup = avatars.join(format!("{id}.bak"));
    if target.exists() {
        let _ = fs::remove_dir_all(&backup);
        fs::rename(&target, &backup).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok((id, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\x0d";

    #[test]
    fn css_strings_cannot_hide_a_brace() {
        // What the library writes: attribute values, comments with apostrophes.
        assert!(css_ok(".critter[data-state=\"DONE\"] .hat { fill: red } /* the hat's band */"));
        assert!(css_ok(".critter[data-state='IDLE'] .hat { fill: red }"));
        // A brace or quote inside a string would let a rule escape the avatar's scope.
        assert!(!css_ok("@keyframes k { to { x: \"{\" } } #chat { display: none } }"));
        assert!(!css_ok(".a { content: \"}\" }"));
        assert!(!css_ok(".a[title='a;b'] { fill: red }"));
        assert!(!css_ok(".a { fill: red } /* unterminated"));
        assert!(!css_ok(".a { background: image-set(#x 1x) }"));
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("claude-pet-avatars-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn zip_of(path: &Path, files: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap();
    }
    const MANIFEST: &[u8] = br#"{"format":1,"id":"demo","name":"Demo","kind":"images","states":{"IDLE":"idle.png"}}"#;

    #[test]
    fn remove_deletes_the_avatar_and_its_backup_but_never_classic() {
        let root = tmp_root("rm");
        let pkg = root.join("demo.claudepet");
        zip_of(&pkg, &[("manifest.json", MANIFEST), ("idle.png", PNG)]);
        import(&root, &pkg).unwrap();
        import(&root, &pkg).unwrap(); // leaves demo.bak
        write_install_record(&root, "demo", &json!({"source": "library", "sha256": "ab"})).unwrap();
        assert!(load(&root, "demo").is_ok(), "the record does not disturb load()");
        assert_eq!(list(&root).len(), 1, "nor list()");
        remove(&root, "demo").unwrap();
        assert!(!dir(&root).join("demo").exists() && !dir(&root).join("demo.bak").exists());
        assert!(remove(&root, "classic").is_err());
        assert!(remove(&root, "../etc").is_err());
        assert!(remove(&root, "demo").unwrap_err().contains("not installed"));
        assert!(write_install_record(&root, "demo", &json!({})).is_err());
    }

    #[test]
    fn ids_are_checked_by_structure() {
        assert!(valid_id("ghost") && valid_id("a-1"));
        for bad in ["", "Ghost", "../x", "-a", "a/b", &"x".repeat(41)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn import_then_load_resolves_every_state() {
        let root = tmp_root("ok");
        let pkg = root.join("demo.claudepet");
        zip_of(&pkg, &[("manifest.json", MANIFEST), ("idle.png", PNG), ("README.txt", b"ignored")]);
        assert_eq!(import(&root, &pkg).unwrap(), ("demo".into(), "Demo".into()));
        assert!(!dir(&root).join("demo/README.txt").exists(), "only referenced files are installed");
        let a = load(&root, "demo").unwrap();
        assert!(a["images"]["THINKING"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(list(&root).len(), 1);
        // Re-importing keeps the previous version aside.
        import(&root, &pkg).unwrap();
        assert!(dir(&root).join("demo.bak").exists());
        assert_eq!(list(&root).len(), 1, "the .bak is not listed");
    }

    #[test]
    fn zip_slip_and_nested_paths_are_refused() {
        let root = tmp_root("slip");
        let pkg = root.join("evil.claudepet");
        zip_of(&pkg, &[("manifest.json", MANIFEST), ("../../evil.png", PNG)]);
        assert!(import(&root, &pkg).unwrap_err().contains("unsafe path"));
        zip_of(&pkg, &[("manifest.json", MANIFEST), ("sub/idle.png", PNG)]);
        assert!(import(&root, &pkg).unwrap_err().contains("top level"));
        assert!(!root.join("evil.png").exists() && !dir(&root).join("demo").exists());
    }

    #[test]
    fn content_must_match_its_extension() {
        let root = tmp_root("sniff");
        let pkg = root.join("x.claudepet");
        zip_of(&pkg, &[("manifest.json", MANIFEST), ("idle.png", b"<html><script>alert(1)</script>")]);
        assert!(import(&root, &pkg).unwrap_err().contains("not .png"));
    }

    #[test]
    fn stylesheets_cannot_reach_outside() {
        assert!(css_ok(".a { fill: url(#g) }"));
        assert!(!css_ok(".a { background: url(https://x/y) }"));
        assert!(!css_ok("@import 'x.css';"));
        assert!(!css_ok(".a { color: \\72 ed }"));
        // Every forbidden token of the shared format JSON is refused, not just the
        // historical four: the three checks (TS, Rust, page) share this one list.
        for token in format()["cssForbidden"].as_array().unwrap() {
            let css = format!(".a {{ x: {} }}", token.as_str().unwrap());
            assert!(!css_ok(&css), "{css}");
        }
    }

    fn with_animations(animations: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"format":1,"id":"demo","name":"Demo","kind":"images","states":{{"IDLE":"idle.png"}},"animations":{animations}}}"#
        ))
        .unwrap()
    }

    #[test]
    fn license_is_loosely_checked_and_listed_with_the_version() {
        let root = tmp_root("lic");
        let pkg = root.join("demo.claudepet");
        let manifest = br#"{"format":1,"id":"demo","name":"Demo","license":"MIT","version":"2.0.0","kind":"images","states":{"IDLE":"idle.png"}}"#;
        zip_of(&pkg, &[("manifest.json", manifest), ("idle.png", PNG)]);
        import(&root, &pkg).unwrap();
        let listed = list(&root);
        assert_eq!(listed[0]["version"], "2.0.0");
        assert_eq!(listed[0]["license"], "MIT");
        let bad: Value = serde_json::from_str(
            r#"{"format":1,"id":"demo","name":"Demo","license":42,"kind":"images","states":{"IDLE":"idle.png"}}"#,
        )
        .unwrap();
        assert!(check_manifest(&bad).unwrap_err().contains("license"));
    }

    #[test]
    fn animations_are_checked_strictly() {
        let ok = r#"{"profile":"classic","states":{
            "THINKING":{"target":"body","keyframes":"bob","dur":2600,"ease":"ease-in-out","amp":1.2},
            "IDLE":{"keyframes":null},
            "DONE":{"enter":{"keyframes":"tip","dur":900,"ease":[0.3,0,0.3,1],"count":2}},
            "ERROR":{"fallback":"DONE"}}}"#;
        assert!(check_manifest(&with_animations(ok)).is_ok());

        for (bad, why) in [
            (r#"{"states":{"NAP":{"keyframes":"x"}}}"#, "unknown state"),
            (r#"{"states":{"DONE":{"target":"tentacle","keyframes":"x"}}}"#, "unknown target"),
            (r#"{"states":{"DONE":{"keyframes":"a}body{"}}}"#, "keyframes"),
            (r#"{"states":{"DONE":{"keyframes":"x","dur":999999999}}}"#, "dur"),
            (r#"{"states":{"DONE":{"keyframes":"x","ease":"bouncy"}}}"#, "ease"),
            (r#"{"states":{"DONE":{"keyframes":"x","ease":[9,0,0,1]}}}"#, "ease"),
            (r#"{"states":{"DONE":{"keyframes":"x","amp":99}}}"#, "amp"),
            (r#"{"states":{"DONE":{"enter":{"keyframes":"x","count":0}}}}"#, "count"),
            (r#"{"states":{"DONE":{"enter":{"keyframes":null}}}}"#, "keyframes"),
            (r#"{"states":{"DONE":{"fallback":"NOPE"}}}"#, "fallback"),
            (r#"{"states":{"DONE":{"fallback":"DONE","dur":500}}}"#, "nothing else"),
            (r#"{"states":{"DONE":{"keyframes":"x","onload":"evil"}}}"#, "unknown key"),
            (r#"{"profile":"vivid"}"#, "profile"),
            (r#"[1]"#, "object"),
        ] {
            let err = check_manifest(&with_animations(bad)).unwrap_err();
            assert!(err.contains(why), "{bad} → {err}");
        }
    }

    #[test]
    fn pictures_may_ship_css_and_animations_and_load_keeps_them() {
        let root = tmp_root("anim");
        let pkg = root.join("demo.claudepet");
        let manifest = br#"{"format":1,"id":"demo","name":"Demo","kind":"images",
            "states":{"IDLE":"idle.png"},"css":"skin.css",
            "animations":{"states":{"DONE":{"enter":{"keyframes":"tip","dur":900}}}}}"#;
        zip_of(&pkg, &[("manifest.json", manifest), ("idle.png", PNG),
                       ("skin.css", b"@keyframes tip { to { transform: rotate(-12deg) } }")]);
        import(&root, &pkg).unwrap();
        let a = load(&root, "demo").unwrap();
        assert!(a["css"].as_str().unwrap().contains("@keyframes tip"));
        assert_eq!(a["animations"]["states"]["DONE"]["enter"]["dur"], 900);
    }
}
