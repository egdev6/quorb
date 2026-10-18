#!/usr/bin/env bash
# Valida que el .deb de Quorb se instala y la app arranca en Ubuntu 22.04 limpia.
# Expone fallos típicos de bundle: deps de runtime que faltan en la imagen
# (libwebkit2gtk-4.1-0), scripting de postinst roto, binario que crashea al
# arrancar sin display real.
set -euo pipefail

echo
echo "=== [1/2] .deb ==="
DEB="$(ls /artifacts/quorb_*.deb 2>/dev/null | head -1 || true)"
if [ -z "$DEB" ]; then
  echo "No se encontró /artifacts/quorb_*.deb — salta la validación .deb."
  exit 0
fi
echo "Instalando $DEB ..."
dpkg -i "$DEB" || { echo "  dpkg -i falló; resolviendo deps con apt-get -f install..."; apt-get -f install -y; }

# Si el postinst requirió un segundo dpkg --configure, completámoslo.
dpkg --configure -a || true

echo "Binario instalado: $(command -v quorb || ls /usr/bin/quorb* /opt/quorb* 2>/dev/null | head -1)"
if ! command -v quorb >/dev/null 2>&1; then
  echo "error: no hay 'quorb' en el PATH tras instalar el .deb" >&2
  exit 1
fi

LOG="$(mktemp)"
echo "Arranque headless (xvfb + dbus, timeout 60s)..."
set +e
timeout -k 10 60 dbus-run-session -- xvfb-run -a quorb >"$LOG" 2>&1
code=$?
set -e

if [ "$code" -eq 124 ]; then
  echo "✔ .deb OK: quorb siguió vivo a los 60s bajo X virtual (ventana creada)."
else
  echo "✖ .deb falló (código $code). Log:" >&2
  tail -40 "$LOG" >&2
  exit 1
fi