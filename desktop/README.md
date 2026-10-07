# Agent Wrangler desktop

A thin Tauri window onto the local Wrangler server. On launch it checks `127.0.0.1:$AW_PORT` (default 7878); if nothing is listening it kickstarts the launchd service (`net.portswigger.agent-wrangler`), falling back to `scripts/wrangler-start.sh`, then loads the board. Closing the window leaves the server running. A server the app started itself (the fallback) is supervised while the app is open: the board's Restart button and self-update restarts respawn it, backing off between attempts and giving up (with the last log lines shown in the window) if it keeps crashing. Quitting the app stops the supervision, not the server.

Requires Rust and `cargo install tauri-cli --version "^2" --locked`.

```
scripts/build-desktop.sh          # desktop/target/release/bundle/macos/Agent Wrangler.app
scripts/install-desktop.sh        # build, then copy to ~/Applications (AW_APP_DIR to change; --no-build to skip the build)
cd desktop && cargo tauri dev     # run without bundling
```

Where the server runs from, in order:

1. `AW_REPO` — a checkout you point it at.
2. The checkout the app was built from, if it still exists.
3. A managed clone, made on first launch: `git clone` of `AW_REPO_URL` (default `https://github.com/PortSwigger/agent-wrangler.git`) at `AW_BRANCH` (default `main`) into `~/Library/Application Support/Agent Wrangler/checkout` (`$XDG_DATA_HOME/agent-wrangler/checkout` on Linux). The first start then installs dependencies, which can take a few minutes. `AW_BRANCH` only applies when the clone is made. Board self-update only works on `main`, so a clone of any other branch won't self-update.

It needs `git` for the clone and `tmux` for the server; the window says so if either is missing. Env vars must be visible to the app, so for a Finder/Dock launch use `launchctl setenv`, or run the binary from a shell.

 Server output from app-started launches goes to `~/Library/Logs/wrangler/wrangler-desktop.log`.

Remove it again with `scripts/uninstall.sh` (see `--help`; `--dry-run` previews).
