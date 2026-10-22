#!/usr/bin/env bash
# Orquestador del build-verify: corre la validación del .deb y luego la del
# .AppImage. Se invoca como ENTRYPOINT del contenedor; /artifacts es un bind
# mount del host (dist/). Fail-fast: si el .deb falla, no sigue al .AppImage.
set -euo pipefail

echo "=== Build-verify de Quorb ==="
echo "Artifacts: /artifacts"
ls -la /artifacts

# Cada verify-*.sh falla (exit 1) si falta SU bundle: los dos formatos son
# obligatorios. Un skip silencioso convertiría un gate vacío en verde.
verify-deb.sh
verify-appimage.sh

echo
echo "✔ Build-verify OK: .deb y .AppImage arrancados en Ubuntu 22.04 limpia."