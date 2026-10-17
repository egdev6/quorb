#!/usr/bin/env bash
# Smoke headless de la app Tauri de Quorb dentro del devcontainer.
#
# Valida que `npm run app:dev` compila y mantiene la ventana viva bajo un
# display X virtual (xvfb) y un session bus de D-Bus efímero (dbus-run-session).
# NO valida compositores reales (Wayland/Hyprland, click-through, edge-docking,
# transparencia, always-on-top): eso es la matriz física de F0 del PRD.
#
# Uso (dentro del devcontainer):
#   bash .devcontainer/smoke-app.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for bin in xvfb-run dbus-run-session; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: falta '$bin'. Instálalo: sudo apt-get install -y xvfb dbus" >&2
    exit 1
  fi
done

LOG="${TMPDIR:-/tmp}/quorb-smoke.log"
echo "▶ Smoke headless de Quorb (xvfb + dbus-run-session, máx 300s)..."
echo "  Log: $LOG"

set +e
# La primera compilación Rust puede tardar minutos; 300s da margen. `timeout`
# devuelve 124 si la app seguía viva al expirar (=> ventana creada y servida).
timeout -k 10 300 dbus-run-session -- xvfb-run -a npm run app:dev >"$LOG" 2>&1
code=$?
set -e

if [ "$code" -eq 124 ]; then
  echo "✔ Smoke headless OK: la ventana seguía levantada a los 300s bajo X virtual."
  exit 0
fi

echo "✖ El arranque terminó antes de tiempo (código $code). Últimas líneas del log:" >&2
tail -40 "$LOG" >&2
exit 1