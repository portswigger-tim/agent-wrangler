// Thin desktop shell for Agent Wrangler: a window onto the local server. If
// nothing is listening on the port it starts the server first (via the launchd
// service when installed, otherwise scripts/wrangler-start.sh), then points the
// window at it. The server is deliberately left running when the window closes —
// sessions live in tmux and the board keeps watching them.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LAUNCHD_LABEL: &str = "net.portswigger.agent-wrangler";
const START_TIMEOUT: Duration = Duration::from_secs(60);

fn port() -> u16 {
    ["AW_PORT", "PORT"]
        .iter()
        .find_map(|k| std::env::var(k).ok()?.parse().ok())
        .unwrap_or(7878)
}

fn server_up(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

// The repo checkout the server runs from. Baked in at build time (desktop/ lives
// inside the repo); AW_REPO overrides it for a moved checkout.
fn repo_dir() -> PathBuf {
    std::env::var_os("AW_REPO")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
}

fn log_file() -> Option<std::fs::File> {
    let dir = PathBuf::from(std::env::var_os("HOME")?).join("Library/Logs/wrangler");
    std::fs::create_dir_all(&dir).ok()?;
    OpenOptions::new().create(true).append(true).open(dir.join("wrangler-desktop.log")).ok()
}

fn kickstart_service() -> bool {
    let Ok(uid) = Command::new("id").arg("-u").output() else { return false };
    let target = format!("gui/{}/{}", String::from_utf8_lossy(&uid.stdout).trim(), LAUNCHD_LABEL);
    Command::new("launchctl")
        .args(["kickstart", &target])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn spawn_server() -> std::io::Result<()> {
    let repo = repo_dir();
    let mut cmd = Command::new("bash");
    cmd.arg(repo.join("scripts/wrangler-start.sh")).current_dir(&repo).stdin(Stdio::null());
    match log_file() {
        Some(f) => {
            cmd.stdout(f.try_clone()?).stderr(f);
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    // Own process group so the server outlives this app.
    cmd.process_group(0).spawn().map(|_| ())
}

fn ensure_server(port: u16) -> Result<(), String> {
    if server_up(port) {
        return Ok(());
    }
    if !kickstart_service() {
        spawn_server().map_err(|e| format!("Couldn't start the Wrangler server: {e}"))?;
    }
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if server_up(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "The Wrangler server didn't come up on port {port} within {}s.\nSee ~/Library/Logs/wrangler/.",
        START_TIMEOUT.as_secs()
    ))
}

fn show_error(win: &WebviewWindow, msg: &str) {
    let json = serde_json_escape(msg);
    let _ = win.eval(format!(
        "document.getElementById('msg').innerHTML = '<pre></pre>'; \
         document.querySelector('pre').textContent = {json};"
    ));
}

// Minimal JS string literal escaping, to avoid pulling in serde_json for one call.
fn serde_json_escape(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn open_externally(url: &str) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = Command::new(opener).arg(url).spawn();
}

fn main() {
    let port = port();
    let origin = format!("http://127.0.0.1:{port}");

    tauri::Builder::default()
        .setup(move |app| {
            let nav_origin = origin.clone();
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Agent Wrangler")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // Stay inside the app for our own pages and the server; hand anything
                // else (PR links, docs) to the default browser.
                .on_navigation(move |url| {
                    let local = matches!(url.scheme(), "tauri" | "about" | "data")
                        || url.host_str() == Some("tauri.localhost")
                        || url.as_str().starts_with(&nav_origin);
                    if !local {
                        open_externally(url.as_str());
                    }
                    local
                })
                .build()?;

            let origin = origin.clone();
            std::thread::spawn(move || match ensure_server(port) {
                Ok(()) => {
                    if let Ok(url) = origin.parse() {
                        let _ = win.navigate(url);
                    }
                }
                Err(msg) => show_error(&win, &msg),
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Agent Wrangler desktop");
}
