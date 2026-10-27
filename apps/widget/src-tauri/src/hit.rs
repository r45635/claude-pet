//! Click-through outside the creature.
//!
//! The window is a transparent square, and macOS gives it every click inside that square —
//! the empty corners around the creature included, which then block whatever app is
//! underneath. A WKWebView cannot pass a click through by itself, so:
//!
//! - the page reports what is actually drawn — each creature's body as an ellipse, the
//!   "why" bubble, the session tray, the open chat panel as rectangles (`set_hit_regions`);
//! - a Rust thread follows the cursor and switches `set_ignore_cursor_events`: over a
//!   shape the window takes the click, anywhere else it lets it through.
//!
//! Until the page has reported anything, the whole window stays clickable: a creature that
//! cannot be grabbed is worse than one whose corners are sticky.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

/// A shape in window coordinates (CSS px = logical px: the webview fills the window).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Shape {
    Rect { x: f64, y: f64, w: f64, h: f64 },
    Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
}

impl Shape {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        match *self {
            Shape::Rect { x, y, w, h } => px >= x && px <= x + w && py >= y && py <= y + h,
            Shape::Ellipse { cx, cy, rx, ry } => {
                if rx <= 0.0 || ry <= 0.0 {
                    return false;
                }
                let (dx, dy) = ((px - cx) / rx, (py - cy) / ry);
                dx * dx + dy * dy <= 1.0
            }
        }
    }
}

/// Whether the window should take a click at (x, y), in window coordinates.
/// `None` = the page has not reported yet: everything inside the window is clickable.
pub fn takes_click(shapes: Option<&[Shape]>, x: f64, y: f64, width: f64, height: f64) -> bool {
    let inside = x >= 0.0 && y >= 0.0 && x < width && y < height;
    match shapes {
        None => inside,
        Some(shapes) => inside && shapes.iter().any(|s| s.contains(x, y)),
    }
}

#[derive(Default)]
pub struct HitRegions(pub Mutex<Option<Vec<Shape>>>);

/// The cursor relative to the window, in logical points. On macOS, tao gives the cursor in
/// pixels of the **primary** display's scale and the window's position in pixels of **its
/// own** display's scale: each is divided by its own factor before they are compared. With a
/// Retina laptop and a 1x external screen, mixing them put the cursor far outside the window,
/// and the creature ignored every click on the external screen (v0.5.5).
pub fn local_point(cursor: (f64, f64), primary_scale: f64, window_pos: (f64, f64), window_scale: f64) -> (f64, f64) {
    (cursor.0 / primary_scale - window_pos.0 / window_scale, cursor.1 / primary_scale - window_pos.1 / window_scale)
}

/// Follow the cursor and toggle click-through. Polls fast only near the window: ~30 Hz
/// when the cursor is on it, ~10 Hz within 80 px, ~4 Hz farther away.
pub fn spawn_tracker(app: AppHandle, window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut ignoring = false;
        loop {
            let mut delay = 250;
            if let (Ok(cursor), Ok(pos), Ok(size), Ok(scale)) = (
                app.cursor_position(),
                window.outer_position(),
                window.outer_size(),
                window.scale_factor(),
            ) {
                let primary = app.primary_monitor().ok().flatten().map_or(scale, |m| m.scale_factor());
                let (x, y) = local_point((cursor.x, cursor.y), primary, (pos.x as f64, pos.y as f64), scale);
                let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
                let take = {
                    let state = app.state::<HitRegions>();
                    let shapes = state.0.lock().ok();
                    let shapes = shapes.as_ref().and_then(|g| g.as_deref());
                    takes_click(shapes, x, y, w, h)
                };
                if take == ignoring && window.set_ignore_cursor_events(!take).is_ok() {
                    ignoring = !take;
                }
                let margin = 80.0;
                let near = x > -margin && y > -margin && x < w + margin && y < h + margin;
                let inside = x >= 0.0 && y >= 0.0 && x < w && y < h;
                delay = if inside { 33 } else if near { 100 } else { 250 };
            }
            std::thread::sleep(Duration::from_millis(delay));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ellipse_takes_its_body_not_the_square_around_it() {
        let body = Shape::Ellipse { cx: 90.0, cy: 90.0, rx: 50.0, ry: 50.0 };
        assert!(body.contains(90.0, 90.0));
        assert!(body.contains(130.0, 90.0));
        assert!(!body.contains(5.0, 5.0), "a transparent corner must not be clickable");
        assert!(!body.contains(130.0, 130.0));
    }

    #[test]
    fn nothing_reported_yet_keeps_the_whole_window_clickable() {
        assert!(takes_click(None, 2.0, 2.0, 180.0, 180.0));
        assert!(!takes_click(None, -1.0, 2.0, 180.0, 180.0));
        let shapes = [Shape::Rect { x: 10.0, y: 10.0, w: 20.0, h: 20.0 }];
        assert!(takes_click(Some(&shapes), 15.0, 15.0, 180.0, 180.0));
        assert!(!takes_click(Some(&shapes), 100.0, 100.0, 180.0, 180.0));
        assert!(!takes_click(Some(&[]), 15.0, 15.0, 180.0, 180.0));
    }

    #[test]
    fn the_cursor_and_the_window_are_compared_in_logical_points() {
        // One screen, Retina: both in 2x pixels, as before.
        assert_eq!(local_point((2020.0, 1020.0), 2.0, (2000.0, 1000.0), 2.0), (10.0, 10.0));
        // Creature on a 1x screen placed above a 2x primary: window at (100, -1080) logical is
        // (100, -1080) in its own pixels; the cursor 10 points inside is (220, -2140) in 2x pixels.
        assert_eq!(local_point((220.0, -2140.0), 2.0, (100.0, -1080.0), 1.0), (10.0, 10.0));
        // The old formula, (cursor - pos) / scale, put that same cursor far outside: (120, -1060).
        assert!(takes_click(None, 10.0, 10.0, 180.0, 180.0));
    }

    #[test]
    fn shapes_parse_from_the_page_json() {
        let v: Vec<Shape> = serde_json::from_str(
            r#"[{"kind":"ellipse","cx":1,"cy":2,"rx":3,"ry":4},{"kind":"rect","x":0,"y":0,"w":5,"h":6}]"#,
        )
        .unwrap();
        assert_eq!(v[0], Shape::Ellipse { cx: 1.0, cy: 2.0, rx: 3.0, ry: 4.0 });
        assert_eq!(v[1], Shape::Rect { x: 0.0, y: 0.0, w: 5.0, h: 6.0 });
    }
}
