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
                let x = (cursor.x - pos.x as f64) / scale;
                let y = (cursor.y - pos.y as f64) / scale;
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
    fn shapes_parse_from_the_page_json() {
        let v: Vec<Shape> = serde_json::from_str(
            r#"[{"kind":"ellipse","cx":1,"cy":2,"rx":3,"ry":4},{"kind":"rect","x":0,"y":0,"w":5,"h":6}]"#,
        )
        .unwrap();
        assert_eq!(v[0], Shape::Ellipse { cx: 1.0, cy: 2.0, rx: 3.0, ry: 4.0 });
        assert_eq!(v[1], Shape::Rect { x: 0.0, y: 0.0, w: 5.0, h: 6.0 });
    }
}
