#!/usr/bin/env bash
# Quorb devcontainer setup (Linux dev/test).
# Runs once per container create/rebuild (postCreateCommand).
#
# Installs the Tauri 2 system dependencies on Ubuntu 22.04 needed to compile
# and test src-tauri, and prepares the frontend from the lockfile
# (npm ci, same as CI).
set -euo pipefail

echo "▶ [1/3] System dependencies (Tauri 2 / Linux)..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential \
  pkg-config \
  curl \
  wget \
  file \
  patchelf \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libsecret-1-dev \
  libnotify-dev \
  libfuse2 \
  dbus \
  dbus-x11 \
  xvfb

echo "▶ [2/3] Cache volume permissions (cargo/npm)..."
sudo chown -R vscode:vscode /usr/local/cargo /usr/local/rustup /home/vscode/.npm 2>/dev/null || true

echo "▶ [3/3] Frontend dependencies from the lockfile (npm ci)..."
npm ci

echo
echo "✔ Quorb devcontainer environment ready."
echo "  Commands (from the workspace root, which has package.json):"
echo "    Tests:           npm test"
echo "    Rust:            (cd src-tauri && cargo test --locked)"
echo "    Typecheck:       npm run typecheck"
echo "    Build frontend:  npm run build"
echo "    Linux bundle:    npm run app:build   (builds .deb and .AppImage in src-tauri/target)"
echo "  About app:dev (needs a display):"
echo "    With display:    npm run app:dev"
echo "    Without display: bash .devcontainer/smoke-app.sh   (xvfb + dbus-run-session)"