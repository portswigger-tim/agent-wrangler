# Agent Wrangler desktop

A thin Tauri window onto the local Wrangler server. On launch it checks `127.0.0.1:$AW_PORT` (default 7878); if nothing is listening it kickstarts the launchd service (`net.portswigger.agent-wrangler`), falling back to `scripts/wrangler-start.sh`, then loads the board. Closing the window leaves the server running.

Requires Rust and `cargo install tauri-cli --version "^2" --locked`.

```
scripts/build-desktop.sh          # desktop/target/release/bundle/macos/Agent Wrangler.app
scripts/install-desktop.sh        # build, then copy to ~/Applications (AW_APP_DIR to change; --no-build to skip the build)
cd desktop && cargo tauri dev     # run without bundling
```

The repo path is baked in at build time; set `AW_REPO` to override. Server output from app-started launches goes to `~/Library/Logs/wrangler/wrangler-desktop.log`.

Remove it again with `scripts/uninstall.sh` (see `--help`; `--dry-run` previews).
