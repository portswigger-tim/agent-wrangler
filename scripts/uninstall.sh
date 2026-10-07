#!/bin/bash
# Removes what the install steps put on this machine: the desktop app, the
# background service and any running server. By default your data is left alone;
# --purge also deletes it. The repo checkout itself is never touched.
#
#   scripts/uninstall.sh            remove the desktop app, service and running server
#   scripts/uninstall.sh --purge    also delete ~/.agent-wrangler (board state, notes, config),
#                                   the logs, desktop/target, and kill the agent tmux sessions
#   -n | --dry-run                  print what would happen, change nothing
#   -y | --yes                      skip the --purge confirmation
#
# Agent sessions live in tmux and survive a server stop, so without --purge they
# keep running (and are listed at the end) rather than being killed under you.
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
label="net.portswigger.agent-wrangler"
app_name="Agent Wrangler"
data_dir="${AW_DATA_DIR:-$HOME/.agent-wrangler}"
log_dir="${AW_LOG_DIR:-$HOME/Library/Logs/wrangler}"

purge=0 dry=0 yes=0
for a in "$@"; do
  case "$a" in
    --purge) purge=1 ;;
    -n|--dry-run) dry=1 ;;
    -y|--yes) yes=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
act() { # act "description" cmd args... — run, or just print under --dry-run
  local desc="$1"; shift
  if [ "$dry" = 1 ]; then say "would: $desc"; else say "$desc"; "$@" >/dev/null 2>&1 || true; fi
}

if [ "$purge" = 1 ] && [ "$dry" = 0 ] && [ "$yes" = 0 ]; then
  say "--purge will delete $data_dir (board state, notes, config) and $log_dir,"
  say "and kill every agent tmux session the wrangler started."
  read -r -p "Type 'purge' to continue: " ans
  [ "$ans" = "purge" ] || { say "Aborted."; exit 1; }
fi

# --- desktop app -----------------------------------------------------------
if pgrep -x agent-wrangler-desktop >/dev/null 2>&1; then
  act "quitting the desktop app" pkill -x agent-wrangler-desktop
fi
for dir in "$HOME/Applications" /Applications; do
  if [ -d "$dir/$app_name.app" ]; then
    act "removing $dir/$app_name.app" rm -rf "$dir/$app_name.app"
  fi
done

# --- background service ----------------------------------------------------
case "$(uname -s)" in
  Darwin)
    plist="$HOME/Library/LaunchAgents/$label.plist"
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      act "stopping the launchd service" launchctl bootout "gui/$(id -u)/$label"
    fi
    [ -f "$plist" ] && act "removing $plist" rm -f "$plist"
    ;;
  Linux)
    unit="$HOME/.config/systemd/user/agent-wrangler.service"
    if [ -f "$unit" ]; then
      act "disabling the systemd user service" systemctl --user disable --now agent-wrangler.service
      act "removing $unit" rm -f "$unit"
      act "reloading systemd" systemctl --user daemon-reload
    fi
    ;;
esac

# --- a server started by hand or by the desktop app ------------------------
# Only processes whose working directory is this checkout, so another clone's
# (or a dev instance's) server is left alone.
for pid in $(pgrep -f "node server/index.js" 2>/dev/null); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ "$cwd" = "$root" ] && act "stopping the server (pid $pid)" kill "$pid"
done

# --- agent tmux sessions ---------------------------------------------------
sockets=""
if [ -f "$data_dir/config.json" ] && command -v node >/dev/null 2>&1; then
  sockets="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tmuxSocket;if(s)console.log(s)}catch{}' "$data_dir/config.json")"
fi
if [ -n "$sockets" ] && command -v tmux >/dev/null 2>&1; then
  for s in $sockets; do
    n="$(tmux -L "$s" list-sessions 2>/dev/null | wc -l | tr -d ' ')"
    [ "$n" -gt 0 ] || continue
    if [ "$purge" = 1 ]; then
      act "killing $n agent session(s) on tmux socket $s" tmux -L "$s" kill-server
    else
      say "note: $n agent session(s) still running on tmux socket '$s' (tmux -L $s ls). --purge kills them."
    fi
  done
fi

# --- data ------------------------------------------------------------------
if [ "$purge" = 1 ]; then
  [ -d "$data_dir" ] && act "deleting $data_dir" rm -rf "$data_dir"
  [ -d "$log_dir" ] && act "deleting $log_dir" rm -rf "$log_dir"
  [ -d "$root/desktop/target" ] && act "deleting $root/desktop/target" rm -rf "$root/desktop/target"
else
  say "kept: $data_dir and $log_dir (use --purge to delete)"
fi

say "Done. The checkout at $root is untouched; delete it yourself if you want it gone."
