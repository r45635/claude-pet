//! The avatar menu's pictures. Each installed avatar's thumbnail (avatars.rs `thumb_of`) is
//! read, checked, trimmed to what it draws and shrunk to the menu's 18 points (36 px on a
//! Retina screen) once, then kept until its file changes: opening the menu again costs one
//! `stat` per avatar. The menu exists only while it is open, so nothing here runs while the
//! creature sits there; the cache holds ~5 KB per avatar.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;
use tauri::image::Image;

/// A side of a menu picture, in pixels (muda draws menu icons 18 points high).
pub const SIDE: usize = 36;
/// A thumbnail file is a few KB; a picture avatar's IDLE image is at most this.
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_PX: u32 = 1024;
const CLASSIC: &[u8] = include_bytes!("../icons/classic-thumb.png");

type Rgba = Vec<u8>;

/// The built-in avatar's picture (scripts/thumbs.ts draws it).
pub fn classic() -> Image<'static> {
    static PIC: OnceLock<Rgba> = OnceLock::new();
    image(PIC.get_or_init(|| decode(CLASSIC).map(|(w, h, px)| shrink(w, h, &px)).unwrap_or_else(|_| blank())).clone())
}

/// The picture for an avatar's thumbnail file; none, or one that cannot be read, gives a
/// transparent square, so every name in the menu stays aligned.
pub fn icon(file: Option<&Path>) -> Image<'static> {
    image(file.and_then(cached).unwrap_or_else(blank))
}

/// macOS 27 hides menu item pictures unless each item asks to keep it
/// (`NSMenuItem.preferredImageVisibility`, an apps-built-with-the-27-SDK rule). Tauri does not
/// hand out its NSMenuItems, so whenever one of the app's menus opens, every item in it and in
/// its submenus asks. Earlier systems have no such property and are left alone. Call once, at
/// startup, on the main thread.
#[cfg(target_os = "macos")]
pub fn keep_menu_pictures_visible() {
    use objc2::runtime::NSObjectProtocol;
    use objc2_app_kit::{NSMenu, NSMenuDidBeginTrackingNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    fn ask(menu: &NSMenu) {
        let sel = objc2::sel!(setPreferredImageVisibility:);
        for item in menu.itemArray() {
            if item.respondsToSelector(sel) {
                // NSMenuItemImageVisibilityVisible = 1 (AppKit's NSMenuItem.h, macOS 27).
                unsafe { let _: () = objc2::msg_send![&*item, setPreferredImageVisibility: 1isize]; }
            }
            if let Some(sub) = item.submenu() {
                ask(&sub);
            }
        }
    }
    let block = block2::RcBlock::new(|note: std::ptr::NonNull<NSNotification>| {
        let note = unsafe { note.as_ref() };
        if let Some(menu) = note.object().and_then(|o| o.downcast::<NSMenu>().ok()) {
            ask(&menu);
        }
    });
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(Some(NSMenuDidBeginTrackingNotification), None, None, &block)
    };
    std::mem::forget(observer); // for the life of the app
}

fn image(rgba: Rgba) -> Image<'static> {
    Image::new_owned(rgba, SIDE as u32, SIDE as u32)
}

fn blank() -> Rgba {
    vec![0; SIDE * SIDE * 4]
}

/// One entry per file, valid while its modification time and size are the same. A file that
/// fails is remembered too (`None`), so it is reported once, not at every opening.
fn cached(file: &Path) -> Option<Rgba> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, u64, Option<Rgba>)>>> = OnceLock::new();
    let meta = std::fs::metadata(file).ok()?;
    let stamp = (meta.modified().ok()?, meta.len());
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, n, px)) = cache.lock().ok()?.get(file) {
        if (*t, *n) == stamp {
            return px.clone();
        }
    }
    let px = read(file, meta.len()).map_err(|e| eprintln!("avatar thumbnail {}: {e}", file.display())).ok();
    cache.lock().ok()?.insert(file.to_owned(), (stamp.0, stamp.1, px.clone()));
    px
}

fn read(file: &Path, len: u64) -> Result<Rgba, String> {
    if len > MAX_FILE {
        return Err("too large".into());
    }
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let (w, h, px) = decode(&bytes)?;
    Ok(shrink(w, h, &px))
}

/// A PNG to RGBA, refused before decoding past MAX_PX a side.
fn decode(bytes: &[u8]) -> Result<(usize, usize, Rgba), String> {
    if !bytes.starts_with(b"\x89PNG") {
        return Err("not a PNG".into());
    }
    let mut decoder = png::Decoder::new_with_limits(Cursor::new(bytes), png::Limits { bytes: 8 * 1024 * 1024 });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let (w, h) = (reader.info().width, reader.info().height);
    if w == 0 || h == 0 || w > MAX_PX || h > MAX_PX {
        return Err(format!("{w}×{h}: at most {MAX_PX} pixels a side"));
    }
    let mut buf = vec![0; reader.output_buffer_size().ok_or("too large")?];
    let out = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (out.width as usize, out.height as usize);
    let n = w * h;
    let rgba = match out.color_type {
        png::ColorType::Rgba => buf[..n * 4].to_vec(),
        png::ColorType::Rgb => buf[..n * 3].chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf[..n * 2].chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => buf[..n].iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("palette not expanded".into()),
    };
    Ok((w, h, rgba))
}

/// What the picture draws (its non-transparent box), squared and centred, averaged down to
/// SIDE × SIDE. Colours are weighted by their alpha, so transparent pixels leave no dark fringe.
fn shrink(w: usize, h: usize, px: &[u8]) -> Rgba {
    let alpha = |x: usize, y: usize| px[(y * w + x) * 4 + 3];
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if alpha(x, y) > 8 {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
            }
        }
    }
    if x0 >= x1 {
        return blank();
    }
    let side = (x1 - x0).max(y1 - y0) as f64;
    let (left, top) = ((x0 + x1) as f64 / 2.0 - side / 2.0, (y0 + y1) as f64 / 2.0 - side / 2.0);
    let step = side / SIDE as f64;
    let n = step.ceil().max(1.0) as usize; // samples per output pixel, per axis
    let mut out = blank();
    for oy in 0..SIDE {
        for ox in 0..SIDE {
            let mut sum = [0f64; 4];
            for sy in 0..n {
                for sx in 0..n {
                    let x = (left + (ox as f64 + (sx as f64 + 0.5) / n as f64) * step).floor();
                    let y = (top + (oy as f64 + (sy as f64 + 0.5) / n as f64) * step).floor();
                    if x < 0.0 || y < 0.0 || x >= w as f64 || y >= h as f64 {
                        continue; // outside the picture: transparent
                    }
                    let i = (y as usize * w + x as usize) * 4;
                    let a = px[i + 3] as f64;
                    for c in 0..3 {
                        sum[c] += px[i + c] as f64 * a;
                    }
                    sum[3] += a;
                }
            }
            let o = (oy * SIDE + ox) * 4;
            if sum[3] > 0.0 {
                for c in 0..3 {
                    out[o + c] = (sum[c] / sum[3]).round() as u8;
                }
                out[o + 3] = (sum[3] / (n * n) as f64).round() as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(rgba).unwrap();
        out
    }

    fn at(px: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * SIDE + x) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    #[test]
    fn the_drawing_is_trimmed_squared_and_shrunk() {
        // 160×160, transparent but for a red 80×40 band in the middle: the band fills the
        // icon's width, centred on its height.
        let mut rgba = vec![0u8; 160 * 160 * 4];
        for y in 60..100 {
            for x in 40..120 {
                rgba[(y * 160 + x) * 4..][..4].copy_from_slice(&[255, 0, 0, 255]);
            }
        }
        let (w, h, px) = decode(&png(160, 160, &rgba)).unwrap();
        let icon = shrink(w, h, &px);
        assert_eq!(icon.len(), SIDE * SIDE * 4);
        assert_eq!(at(&icon, 0, SIDE / 2), [255, 0, 0, 255], "left edge of the band");
        assert_eq!(at(&icon, SIDE - 1, SIDE / 2), [255, 0, 0, 255], "right edge");
        assert_eq!(at(&icon, SIDE / 2, 0)[3], 0, "above the band: transparent");
        assert_eq!(at(&icon, SIDE / 2, SIDE - 1)[3], 0, "below it too");
    }

    #[test]
    fn a_half_covered_pixel_keeps_its_colour() {
        // Alternating opaque white and transparent black columns: the average is half
        // transparent white, not grey.
        let rgba: Vec<u8> = (0..72 * 72).flat_map(|i| if i % 2 == 0 { [255, 255, 255, 255] } else { [0, 0, 0, 0] }).collect();
        let icon = shrink(72, 72, &rgba);
        let p = at(&icon, 10, 10);
        assert_eq!(&p[..3], &[255, 255, 255]);
        assert!((120..=136).contains(&p[3]), "about half opaque: {}", p[3]);
    }

    #[test]
    fn what_is_not_a_reasonable_png_is_refused() {
        assert!(decode(b"GIF89a....").is_err());
        assert!(decode(b"\x89PNG\r\n\x1a\n garbage").is_err());
        let wide = png(MAX_PX + 1, 1, &vec![0; (MAX_PX as usize + 1) * 4]);
        assert!(decode(&wide).unwrap_err().contains("at most"));
        assert_eq!(shrink(4, 4, &[0; 64]), blank(), "nothing drawn: a blank square");
    }

    #[test]
    fn classic_ships_its_picture_and_a_missing_file_is_blank() {
        let (w, h, _) = decode(CLASSIC).unwrap();
        assert_eq!((w, h), (128, 128));
        assert_eq!(icon(Some(Path::new("/nonexistent/thumb.png"))).rgba(), blank().as_slice());
    }
}
