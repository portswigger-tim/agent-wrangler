#!/bin/bash
# Builds the desktop window (desktop/, Tauri) into
# desktop/target/release/bundle/macos/Agent Wrangler.app. Needs Rust and the Tauri CLI.
set -euo pipefail

cd "$(dirname "$0")/../desktop"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found — install Rust first: https://rustup.rs" >&2
  exit 1
fi
if ! cargo tauri --version >/dev/null 2>&1; then
  echo "Tauri CLI not found — install it with: cargo install tauri-cli --version '^2' --locked" >&2
  exit 1
fi

cargo tauri build --bundles app
