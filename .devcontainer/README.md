# Quorb Devcontainer (Linux)

Reproducible **Ubuntu 22.04** container to develop, compile and test Quorb on
Linux without setting up a real machine. Opens in VS Code (Dev Containers)
from any host: Windows (Docker Desktop / WSL2) or Linux directly.

## How to open it

- **VS Code**: *Dev Containers* extension → **Reopen in Container**.
- **CLI**: `devcontainer up --workspace-folder .` (requires the devcontainer CLI).
- **Makefile** (one-command shortcuts from the repo root):
  - `make up` — build + up (installs Node 22, Rust stable and the Tauri Linux deps).
  - `make shell` — bash inside the container.
  - `make test` — `cargo test --locked` + `npm test`.
  - `make exec CMD="..."` — runs a command inside (e.g. `make exec CMD="cargo clippy -- -D warnings"`).
  - `make lint` — clippy + `npm run typecheck`.
  - `make fmt` — rustfmt + prettier.
  - `make stop` / `make down` — stops the container (keeps volumes).
  - `make nuke` — stops + removes images, volumes and cache (DESTRUCTIVE; the next `make up` re-downloads everything).
  - `make help` — lists the targets.

### From nvim

- **CLI straight from nvim**: `:!make test`, `:!make exec CMD="cargo clippy -- -D warnings"`.
- **`j-hagedorn/devcontainer.nvim` plugin**: commands `:DevcontainerBuild`, `:DevcontainerExec`, `:DevcontainerOpenTerminal` — keeps nvim outside and runs processes inside.
- **`devcontainer exec` + nvim inside**: after `make up`, run `devcontainer exec --workspace-folder . -- zsh` and open nvim inside (container-native LSP, rust-analyzer, prettier).

## What it includes

- Ubuntu 22.04 (image `mcr.microsoft.com/devcontainers/base:ubuntu-22.04`)
- Node 22 + Rust stable (official devcontainer features, no remote scripts)
- Tauri 2 Linux system dependencies (`libwebkit2gtk-4.1-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `libsecret-1-dev`,
  `patchelf`, `build-essential`, …)
- `xvfb` + `dbus-run-session` for the headless smoke
- cargo/npm caches in named volumes (`quorb-cargo-home`, `quorb-npm-cache`),
  persistent across rebuilds

## What it validates

All commands run in the **workspace root** (the one with `package.json`). The
scripts are the ones from `package.json`:

```bash
npm test                          # vitest (src) + node --test (scripts/) — root
cd src-tauri && cargo test --locked   # Rust tests
npm run typecheck                  # tsc --noEmit — root
npm run build                      # tsc --noEmit && vite build — root
npm run app:build                  # tauri build (builds .deb/.AppImage in src-tauri/target)
```

With the Makefile (each command runs inside the container):

```bash
make test                          # cargo test --locked + npm test
make exec CMD="npm run typecheck"
make exec CMD="npm run build"
make exec CMD="bash .devcontainer/smoke-app.sh"   # app:dev under virtual X + ephemeral D-Bus
```

### From the host (outside the container)

If you do not use the Makefile, `devcontainer exec` runs a command inside the
container from your host shell. One command per concern (each runs in the
workspace root, the one with `package.json`):

```bash
devcontainer exec --workspace-folder . bash -c "npm test"                           # vitest + node:test (root)
devcontainer exec --workspace-folder . bash -c "cd src-tauri && cargo test --locked" # Rust tests
devcontainer exec --workspace-folder . bash -c "npm run typecheck"                   # tsc --noEmit (root)
devcontainer exec --workspace-folder . bash -c "npm run build"                       # tsc + vite build (root)
devcontainer exec --workspace-folder . bash -c "npm run app:build"                   # .deb/.AppImage in src-tauri/target
```

To run the full suite in one shot, keep `npm test` at the root and `cargo test`
inside `src-tauri` (do not chain them after a single `cd src-tauri`, or `npm test`
would look for `package.json` in the wrong place):

```bash
devcontainer exec --workspace-folder . bash -c "npm test && cd src-tauri && cargo test --locked"
```

## What it does NOT validate

Real compositors and desktops: Wayland (Mutter), Hyprland, click-through,
edge-docking, transparency, real `always-on-top`, or libsecret with a system
keyring (system D-Bus).

Without a physical display there are also no real desktop notifications or
system tray.

## Notes

- `npm ci` runs in `postCreateCommand` (strict lockfile, same as CI); `npm test`
  runs from the root (vitest for `src/`, node:test for `scripts/`), and
  `cargo test` from `src-tauri/`.
- `npm run app:dev` (tauri dev) **needs a display**. In the container without
  one, use `bash .devcontainer/smoke-app.sh`, which runs it under `xvfb` +
  `dbus-run-session`.
- If `cargo test` fails on webkit/gtk/glib versions, use the dedicated
  Dockerfile (PRD plan B) or bump to another LTS such as `ubuntu-24.04`.
- `make nuke` removes the cargo/npm cache — the next build re-downloads
  dependencies (can take minutes).