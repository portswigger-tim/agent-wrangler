// Menu-bar indicator. Pure helpers (what the server's graph means for the tray, and
// the tray's icons) live here so they can be tested; main.rs owns the wiring.
//
// Simplicity without urgency: one glyph (the app's hat) in the board's status colours:
// red when any session needs you, green while one is working, grey otherwise. No counts,
// no sounds.
use serde_json::Value;
use tauri::image::Image;

// Menu is a shortcut, not a second board: past this the board is the better tool.
const MAX_SESSIONS: usize = 25;

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub needs_you: bool,
    pub working: bool,
}

// Live sessions from a `{type:'graph'}` payload's `graph`, needs-you first. Dormant
// ones (no live tmux) are the board's business: there is nothing to look at.
pub fn entries(graph: &Value) -> Vec<Entry> {
    let mut all: Vec<Entry> = graph["sessions"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|s| s["managed"].as_bool().unwrap_or(false))
        .filter_map(|s| {
            let id = s["sessionId"].as_str()?.to_string();
            let label = s["label"].as_str().filter(|l| !l.trim().is_empty()).unwrap_or(&id).to_string();
            let status = s["status"].as_str();
            Some(Entry { id, label, needs_you: status == Some("needs-you"), working: status == Some("working") })
        })
        .collect();
    all.sort_by_key(|e| !e.needs_you); // stable: server order within each group
    all.truncate(MAX_SESSIONS);
    all
}

// The tray's colour: the most urgent status among live sessions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Light {
    NeedsYou,
    Working,
    Idle,
}

pub fn light(entries: &[Entry]) -> Light {
    if entries.iter().any(|e| e.needs_you) {
        Light::NeedsYou
    } else if entries.iter().any(|e| e.working) {
        Light::Working
    } else {
        Light::Idle
    }
}

const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");
const TRAY_WIDTH: usize = 48;
// The board's --red / --green (dark theme) and a grey that reads on light and dark bars.
const RED: [u8; 3] = [248, 81, 73];
const GREEN: [u8; 3] = [63, 185, 80];
const GREY: [u8; 3] = [139, 148, 158];

// The hat's silhouette from the app icon (blue on near-black), cropped to its bounds
// and box-downsampled to a menu-bar size. Returns coverage 0..=255 per pixel.
fn hat_mask() -> Option<(Vec<u8>, usize, usize)> {
    let img = Image::from_bytes(ICON_PNG).ok()?;
    let (w, h) = (img.width() as usize, img.height() as usize);
    let px = img.rgba();
    let cover = |x: usize, y: usize| -> u8 {
        let i = (y * w + x) * 4;
        let d = px[i + 2] as i32 - px[i] as i32; // blue over red: hat ≈ 200, background ≈ 10
        (((d - 10) * 255) / 190).clamp(0, 255) as u8
    };
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if cover(x, y) > 40 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
    let (ow, oh) = (TRAY_WIDTH, (bh * TRAY_WIDTH).div_ceil(bw));
    let mut out = vec![0u8; ow * oh];
    for oy in 0..oh {
        for ox in 0..ow {
            let (sx0, sx1) = (x0 + ox * bw / ow, x0 + ((ox + 1) * bw / ow).max(ox * bw / ow + 1));
            let (sy0, sy1) = (y0 + oy * bh / oh, y0 + ((oy + 1) * bh / oh).max(oy * bh / oh + 1));
            let (mut sum, mut n) = (0u32, 0u32);
            for y in sy0..sy1.min(y1 + 1) {
                for x in sx0..sx1.min(x1 + 1) {
                    sum += cover(x, y) as u32;
                    n += 1;
                }
            }
            out[oy * ow + ox] = (sum / n.max(1)) as u8;
        }
    }
    Some((out, ow, oh))
}

// Drawn in colour, never as a template image, so the system leaves the tint alone.
pub fn icon(light: Light) -> Option<Image<'static>> {
    let (mask, w, h) = hat_mask()?;
    let rgb = match light {
        Light::NeedsYou => RED,
        Light::Working => GREEN,
        Light::Idle => GREY,
    };
    let rgba = mask.iter().flat_map(|a| [rgb[0], rgb[1], rgb[2], *a]).collect();
    Some(Image::new_owned(rgba, w as u32, h as u32))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_live_sessions_with_needs_you_first() {
        let g = json!({"sessions": [
            {"sessionId": "a", "label": "Alpha", "status": "idle", "managed": true},
            {"sessionId": "b", "label": "Beta", "status": "needs-you", "managed": true},
            {"sessionId": "c", "label": "Gamma", "status": "working", "managed": true},
            {"sessionId": "d", "label": "Dormant", "status": "idle", "managed": false},
        ]});
        let e = entries(&g);
        assert_eq!(e.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["b", "a", "c"]);
        assert_eq!(light(&e), Light::NeedsYou);
    }

    #[test]
    fn working_is_green_and_otherwise_idle() {
        let g = json!({"sessions": [
            {"sessionId": "a", "status": "idle", "managed": true},
            {"sessionId": "b", "status": "working", "managed": true},
        ]});
        assert_eq!(light(&entries(&g)), Light::Working);
        let g = json!({"sessions": [{"sessionId": "a", "status": "idle", "managed": true}]});
        assert_eq!(light(&entries(&g)), Light::Idle);
        assert_eq!(light(&[]), Light::Idle);
    }

    #[test]
    fn dormant_sessions_do_not_colour_the_tray() {
        let g = json!({"sessions": [
            {"sessionId": "a", "status": "needs-you", "managed": false},
            {"sessionId": "b", "status": "working", "managed": false},
        ]});
        assert_eq!(light(&entries(&g)), Light::Idle);
    }

    #[test]
    fn blank_label_falls_back_to_the_id_and_junk_is_ignored() {
        let g = json!({"sessions": [{"sessionId": "abc", "label": " ", "managed": true}, {"managed": true}]});
        let e = entries(&g);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].label, "abc");
        assert!(entries(&json!({})).is_empty());
    }

    #[test]
    fn menu_is_capped() {
        let sessions: Vec<_> = (0..40).map(|i| json!({"sessionId": i.to_string(), "managed": true})).collect();
        assert_eq!(entries(&json!({ "sessions": sessions })).len(), MAX_SESSIONS);
    }

    #[test]
    fn icons_render_with_a_visible_hat() {
        for (l, rgb) in [(Light::NeedsYou, RED), (Light::Working, GREEN), (Light::Idle, GREY)] {
            let img = icon(l).expect("icon");
            let alpha: Vec<u8> = img.rgba().chunks(4).map(|p| p[3]).collect();
            assert!(alpha.iter().any(|a| *a > 200), "solid pixels");
            assert!(alpha.iter().any(|a| *a == 0), "transparent surround");
            let solid = img.rgba().chunks(4).find(|p| p[3] > 200).unwrap();
            assert_eq!(solid[0..3], rgb);
        }
    }
}
