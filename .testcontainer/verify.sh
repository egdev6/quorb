#!/usr/bin/env bash
# Orquestador del build-verify: corre la validación del .deb y luego la del
# .AppImage. Se invoca como ENTRYPOINT del contenedor; /artifacts es un bind
# mount del host (dist/). Fail-fast: si el .deb falla, no sigue al .AppImage.
set -euo pipefail

echo "=== Build-verify de Quorb ==="
echo "Artifacts: /artifacts"
ls -la /artifacts

verify-deb.sh
verify-appimage.sh

# Si se esperaba validar bundles y no había ninguno en /artifacts, fallar en
# lugar de declarar «OK»: un skip silencioso convierte un gate vacío en verde.
if [ -z "$(find /artifacts -maxdepth 1 -type f \( -iname '*.deb' -o -iname '*.AppImage' \) -print -quit 2>/dev/null)" ]; then
  echo "✖ No se encontró ningún bundle en /artifacts (.deb ni .AppImage): nada se pudo validar." >&2
  exit 1
fi

echo
echo "✔ Build-verify OK: los bundles presentes en /artifacts han arrancado en Ubuntu 22.04 limpia."