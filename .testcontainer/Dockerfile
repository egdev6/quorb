# Build-verify container de Quorb
#
# Imagen de runtime de Ubuntu 22.04 LIMPIA (sin toolchain: sin Node, sin Rust,
# sin build-essential) que replica una máquina de usuario final. Se usa para
# validar que los artefactos de `npm run app:build` (el `.deb` y el `.AppImage`)
# se instalan/extraen y la app arranca sin el toolchain de desarrollo.
#
# Uso:
#   docker build -t quorb-build-verify .testcontainer
#   docker run --rm \
#     -v "$PWD/dist:/artifacts" \
#     --platform linux/amd64 \
#     quorb-build-verify
#   # el entrypoint corre .testcontainer/verify-deb.sh y verify-appimage.sh

FROM ubuntu:22.04

# Solo deps de RUNTIME de Tauri 2 (no -dev). Esta es la trampa típica:
# la app compila y el bundle se genera, pero en una máquina limpia falta
# libwebkit2gtk-4.1-0 (no -dev) y el arranque falla con
# "cannot open shared object file". Este contenedor lo pilla.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-0 \
    libayatana-appindicator3-1 \
    librsvg2-2 \
    libsecret-1-0 \
    libnotify4 \
    libgtk-3-0 \
    dbus \
    dbus-x11 \
    xvfb \
    dpkg \
    wget \
    file \
  && rm -rf /var/lib/apt/lists/*

# /artifacts los monta el host (dist/); el entrypoint los valida.
RUN mkdir -p /artifacts /opt
WORKDIR /opt
COPY --chmod=755 verify-deb.sh verify-appimage.sh verify.sh /usr/local/bin/

ENTRYPOINT ["/usr/local/bin/verify.sh"]