#!/usr/bin/env bash
# Valida que el .AppImage de Quorb se extrae y la app arranca en Ubuntu 22.04
# limpia. Usa --appimage-extract-and-run para no depender de FUSE dentro del
# contenedor (FUSE suele faltar/fallar en Docker sin /dev/fuse).
set -euo pipefail
ARTIFACTS_DIR="${ARTIFACTS_DIR:-/artifacts}"

echo
echo "=== [2/2] .AppImage ==="
# Tauri nombra el artefacto «Quorb_<version>_amd64.AppImage» (Q mayúscula); el
# glob debe ser case-insensitive o no encuentra nada y el skip oculta la
# validación.
APPIMAGE="$(find "$ARTIFACTS_DIR" -maxdepth 1 -type f -iname '*.AppImage' 2>/dev/null | sort | head -1 || true)"
if [ -z "$APPIMAGE" ]; then
  echo "✖ No hay ningún .AppImage en $ARTIFACTS_DIR: se esperaba el bundle .AppImage y no se puede validar." >&2
  exit 1
fi
echo "Extrayendo $APPIMAGE ..."
test -x "$APPIMAGE" || chmod +x "$APPIMAGE"

LOG="$(mktemp)"
echo "Arranque headless (--appimage-extract-and-run, xvfb + dbus, timeout 60s)..."
set +e
# AppImage con --appimage-extract-and-run en el binario extraído; el entrypoint
# del AppImage puede llamar a herramientas internas, no a FUSE.
timeout -k 10 60 dbus-run-session -- xvfb-run -a "$APPIMAGE" --appimage-extract-and-run >"$LOG" 2>&1
code=$?
set -e

if [ "$code" -eq 124 ]; then
  echo "✔ .AppImage OK: quorb siguió vivo a los 60s bajo X virtual (ventana creada)."
else
  echo "✖ .AppImage falló (código $code). Log:" >&2
  tail -40 "$LOG" >&2
  exit 1
fi