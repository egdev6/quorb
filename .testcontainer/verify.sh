#!/usr/bin/env bash
# Orquestador del build-verify: corre la validación del .deb y luego la del
# .AppImage. Se invoca como ENTRYPOINT del contenedor; /artifacts es un bind
# mount del host (dist/). Fail-fast: si el .deb falla, no sigue al .AppImage.
# ARTIFACTS_DIR permite a los tests apuntar a un directorio temporal (default:
# /artifacts, inalterado para el contenedor).
set -euo pipefail
ARTIFACTS_DIR="${ARTIFACTS_DIR:-/artifacts}"

echo "=== Build-verify de Quorb ==="
echo "Artifacts: $ARTIFACTS_DIR"
ls -la "$ARTIFACTS_DIR"

# Cada verify-*.sh falla (exit 1) si falta SU bundle: los dos formatos son
# obligatorios. Un skip silencioso convertiría un gate vacío en verde.
verify-deb.sh
verify-appimage.sh

echo
echo "✔ Build-verify OK: .deb y .AppImage arrancados en Ubuntu 22.04 limpia."