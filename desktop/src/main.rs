// Thin desktop shell for Agent Wrangler: a window onto the local server. If
// nothing is listening on the port it starts the server first (via the launchd
// service when installed, otherwise scripts/wrangler-start.sh), then points the
// window at it. If there is no checkout to run it from, it clones one (see
// `resolve_repo`). The server is deliberately left running when the window closes —
// sessions live in tmux and the board keeps watching them.
//
// A menu-bar item lists live sessions, coloured by their status (see `tray`);
// closing the window hides it, so the item stays the way back in.
//
// A server the app starts itself is supervised: the board's Restart button (and a
// self-update restart) make the server exit expecting a supervisor to bring it
// back, so the app respawns it (see `supervise`). The supervisor lives and dies
// with the app; quitting leaves the server running.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod supervise;
mod tray;

use std::fs::OpenOptions;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const LAUNCHD_LABEL: &str = "net.portswigger.agent-wrangler";
const START_TIMEOUT: Duration = Duration::from_secs(60);
// A first start after a fresh clone runs `npm ci` (including a native node-pty build).
const FIRST_START_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const DEFAULT_REPO_URL: &str = "https://github.com/PortSwigger/agent-wrangler.git";
const DEFAULT_BRANCH: &str = "main";

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

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

fn has_server(dir: &std::path::Path) -> bool {
    dir.join("scripts/wrangler-start.sh").is_file()
}

// Where an app-managed clone lives.
fn managed_checkout() -> PathBuf {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Agent Wrangler/checkout")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("agent-wrangler/checkout")
    }
}

// Where the server runs from, in order: AW_REPO; the checkout this app was built
// from, if it still exists; otherwise a managed clone (made on demand by
// `ensure_checkout`). The bool is true when a clone is needed first.
fn resolve_repo() -> (PathBuf, bool) {
    if let Some(dir) = std::env::var_os("AW_REPO").map(PathBuf::from) {
        return (dir, false);
    }
    let built_from = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if has_server(&built_from) {
        return (built_from, false);
    }
    let managed = managed_checkout();
    let needs_clone = !has_server(&managed);
    (managed, needs_clone)
}

// Mirrors the PATH the launchd plist template sets: a GUI-launched app inherits a
// minimal PATH, and the server needs tmux (Homebrew) and claude (~/.local/bin).
fn server_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts = vec![
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    parts.extend(std::env::var("PATH").unwrap_or_default().split(':').map(String::from));
    parts.extend(["/usr/bin".to_string(), "/bin".to_string()]);
    parts.retain(|p| !p.is_empty());
    parts.join(":")
}

fn tool_exists(name: &str) -> bool {
    server_path()
        .split(':')
        .any(|d| std::path::Path::new(d).join(name).is_file())
}

fn clone_checkout(dir: &std::path::Path) -> Result<(), String> {
    let url = env_or("AW_REPO_URL", DEFAULT_REPO_URL);
    let branch = env_or("AW_BRANCH", DEFAULT_BRANCH);
    if !tool_exists("git") {
        return Err("git isn't installed, so I can't fetch the Wrangler server.\nInstall the Xcode command line tools (xcode-select --install) and reopen the app.".into());
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    }
    // A half-finished earlier clone would make `git clone` refuse the directory.
    let _ = std::fs::remove_dir_all(dir);
    let out = Command::new("git")
        .env("PATH", server_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["clone", "--branch", &branch, "--", &url])
        .arg(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run git: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(dir);
        return Err(format!(
            "Couldn't clone {url} (branch {branch}):\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
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

fn spawn_server(repo: &std::path::Path) -> std::io::Result<Child> {
    let mut cmd = Command::new("bash");
    cmd.arg(repo.join("scripts/wrangler-start.sh"))
        .current_dir(repo)
        .env("PATH", server_path())
        .stdin(Stdio::null());
    match log_file() {
        Some(f) => {
            cmd.stdout(f.try_clone()?).stderr(f);
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    // Own process group so the server outlives this app.
    cmd.process_group(0).spawn()
}

fn ensure_server(win: &WebviewWindow, port: u16, gave_up: &Arc<AtomicBool>) -> Result<(), String> {
    if server_up(port) {
        return Ok(());
    }
    let (repo, needs_clone) = resolve_repo();
    let mut timeout = START_TIMEOUT;
    if needs_clone {
        show_status(win, &format!(
            "Fetching Agent Wrangler (branch {})…",
            env_or("AW_BRANCH", DEFAULT_BRANCH)
        ));
        clone_checkout(&repo)?;
        timeout = FIRST_START_TIMEOUT;
    }
    if !has_server(&repo) {
        return Err(format!("No Wrangler checkout at {}.\nUnset AW_REPO or point it at a checkout.", repo.display()));
    }
    if !tool_exists("tmux") {
        return Err("tmux isn't installed, and the Wrangler server needs it.\nInstall it with: brew install tmux".into());
    }
    show_status(win, if needs_clone {
        "Starting Agent Wrangler. The first start installs dependencies and can take a few minutes…"
    } else {
        "Starting Agent Wrangler…"
    });
    if !kickstart_service() {
        let child = spawn_server(&repo).map_err(|e| format!("Couldn't start the Wrangler server: {e}"))?;
        // launchd supervises the service itself; only a server we spawned needs us.
        supervise_server(win.clone(), repo.clone(), child, port, Arc::clone(gave_up));
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if server_up(port) {
            return Ok(());
        }
        if gave_up.load(Ordering::SeqCst) {
            return Err(String::new()); // the supervisor has already shown why
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "The Wrangler server didn't come up on port {port} within {}s.\nSee ~/Library/Logs/wrangler/.",
        timeout.as_secs()
    ))
}

fn log_path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Logs/wrangler/wrangler-desktop.log"))
}

fn tail_log(lines: usize) -> String {
    let text = log_path().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

// Percent-encode for a URL fragment.
fn encode_fragment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// Back to the local page with an error to show. The window may be sitting on the
// board, where there is no page of ours to eval into, so the message travels in
// the URL fragment and ui/index.html renders it.
fn show_failure(win: &WebviewWindow, msg: &str) {
    if let Ok(url) = format!("tauri://localhost/index.html#error={}", encode_fragment(msg)).parse() {
        let _ = win.navigate(url);
    }
}

// Keeps a server the app spawned running: waits on it and respawns it when it
// exits, backing off and eventually giving up if it can't stay up.
fn supervise_server(win: WebviewWindow, repo: PathBuf, mut child: Child, port: u16, gave_up: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut history = supervise::History::default();
        loop {
            let started = Instant::now();
            let status = child.wait();
            // Something else is serving the port now (e.g. started by hand), so
            // there is nothing for us to keep alive.
            if server_up(port) {
                return;
            }
            let ran_for = started.elapsed();
            let why = status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string());
            match history.on_exit(Instant::now(), ran_for) {
                supervise::Decision::Respawn(delay) => {
                    eprintln!("[agent-wrangler-desktop] server exited ({why}) after {ran_for:?}; respawning in {delay:?}");
                    std::thread::sleep(delay);
                    match spawn_server(&repo) {
                        Ok(c) => child = c,
                        Err(e) => {
                            gave_up.store(true, Ordering::SeqCst);
                            show_failure(&win, &format!("Couldn't restart the Wrangler server: {e}"));
                            return;
                        }
                    }
                }
                supervise::Decision::GiveUp => {
                    eprintln!("[agent-wrangler-desktop] server exited ({why}) after {ran_for:?}; too many recent exits, giving up");
                    gave_up.store(true, Ordering::SeqCst);
                    show_failure(&win, &format!(
                        "The Wrangler server keeps exiting ({why}), so I've stopped restarting it.\n\nLast log lines:\n{}",
                        tail_log(15)
                    ));
                    return;
                }
            }
        }
    });
}

fn show_status(win: &WebviewWindow, msg: &str) {
    let json = serde_json_escape(msg);
    let _ = win.eval(format!("document.getElementById('msg').textContent = {json};"));
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

// Brings the board window forward, optionally on a session.
fn show_board(app: &AppHandle, origin: &str, session: Option<&str>) {
    let Some(win) = app.get_webview_window("main") else { return };
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    let Some(id) = session else { return };
    let frag = format!("#session={}", encode_fragment(id));
    let on_board = win.url().map(|u| u.as_str().starts_with(origin)).unwrap_or(false);
    if on_board {
        // Same page: the board listens for hashchange, no reload needed.
        let _ = win.eval(format!("location.hash = '{frag}';"));
    } else if let Ok(url) = format!("{origin}/{frag}").parse() {
        let _ = win.navigate(url);
    }
}

fn build_menu(app: &AppHandle, entries: &[tray::Entry]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "Show board", true, None::<&str>)?)?;
    if !entries.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    for e in entries {
        let text = if e.needs_you { format!("\u{25CF} {}", e.label) } else { format!("   {}", e.label) };
        menu.append(&MenuItem::with_id(app, format!("session:{}", e.id), text, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Agent Wrangler", true, None::<&str>)?)?;
    Ok(menu)
}

// Reflects the server's session list in the tray. `None` entries = server not
// reachable: grey icon, bare menu.
fn update_tray(app: &AppHandle, tray: &TrayIcon, entries: Vec<tray::Entry>) {
    let app2 = app.clone();
    let tray = tray.clone();
    let _ = app.run_on_main_thread(move || {
        let light = tray::light(&entries);
        if let Ok(menu) = build_menu(&app2, &entries) {
            let _ = tray.set_menu(Some(menu));
        }
        if let Some(icon) = tray::icon(light) {
            let _ = tray.set_icon(Some(icon));
        }
    });
}

// Follows the server's control socket for as long as the app runs, reconnecting
// across server restarts. Only the board's own `graph` pushes are read.
fn watch_sessions(app: AppHandle, tray: TrayIcon, port: u16) {
    std::thread::spawn(move || {
        let url = format!("ws://127.0.0.1:{port}/ws");
        let mut last: Option<Vec<tray::Entry>> = None;
        loop {
            if let Ok((mut socket, _)) = tungstenite::connect(url.as_str()) {
                while let Ok(msg) = socket.read() {
                    let Ok(text) = msg.to_text() else { continue };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { continue };
                    if v["type"] != "graph" {
                        continue;
                    }
                    let entries = tray::entries(&v["graph"]);
                    // The server re-pushes the graph every couple of seconds; rebuilding
                    // an open menu for a no-op would make it flicker.
                    if last.as_ref() != Some(&entries) {
                        last = Some(entries.clone());
                        update_tray(&app, &tray, entries);
                    }
                }
            }
            if last.take().is_some() {
                update_tray(&app, &tray, Vec::new());
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

fn main() {
    let port = port();
    let origin = format!("http://127.0.0.1:{port}");
    let reopen_origin = origin.clone();

    tauri::Builder::default()
        // The window hides rather than closes: the tray is the way back in, and the
        // app (like the server) keeps running until you quit it.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let nav_origin = origin.clone();
            let handle = app.handle().clone();
            let tray_origin = origin.clone();
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Agent Wrangler")
                .menu(&build_menu(&handle, &[])?)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_board(app, &tray_origin, None),
                    "quit" => app.exit(0),
                    id => {
                        if let Some(session) = id.strip_prefix("session:") {
                            show_board(app, &tray_origin, Some(session));
                        }
                    }
                });
            if let Some(icon) = tray::icon(tray::Light::Idle) {
                tray = tray.icon(icon);
            }
            watch_sessions(handle, tray.build(app)?, port);
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
            let gave_up = Arc::new(AtomicBool::new(false));
            std::thread::spawn(move || match ensure_server(&win, port, &gave_up) {
                Ok(()) => {
                    if let Ok(url) = origin.parse() {
                        let _ = win.navigate(url);
                    }
                }
                Err(msg) if msg.is_empty() => {}
                Err(msg) => show_error(&win, &msg),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agent Wrangler desktop")
        .run(move |app, event| {
            // Dock click with the window hidden.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                show_board(app, &reopen_origin, None);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
