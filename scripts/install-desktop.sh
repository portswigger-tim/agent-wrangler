#!/bin/bash
# Builds the desktop app and installs it to ~/Applications (override with
# AW_APP_DIR, e.g. AW_APP_DIR=/Applications). Quits a running copy first and
# relaunches it afterwards if it was running. Pass --no-build to install the
# existing bundle.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
name="Agent Wrangler"
src="$root/desktop/target/release/bundle/macos/$name.app"
dest_dir="${AW_APP_DIR:-$HOME/Applications}"

[ "$(uname -s)" = "Darwin" ] || { echo "install-desktop.sh only supports macOS" >&2; exit 1; }

[ "${1:-}" = "--no-build" ] || bash "$root/scripts/build-desktop.sh"
[ -d "$src" ] || { echo "No bundle at $src — run without --no-build" >&2; exit 1; }

was_running=0
if pgrep -x agent-wrangler-desktop >/dev/null 2>&1; then
  was_running=1
  osascript -e "tell application \"$name\" to quit" >/dev/null 2>&1 || pkill -x agent-wrangler-desktop || true
  for _ in $(seq 20); do pgrep -x agent-wrangler-desktop >/dev/null 2>&1 || break; sleep 0.25; done
fi

mkdir -p "$dest_dir"
rm -rf "$dest_dir/$name.app"
cp -R "$src" "$dest_dir/$name.app"
echo "Installed $dest_dir/$name.app"

[ "$was_running" = 0 ] || open "$dest_dir/$name.app"
