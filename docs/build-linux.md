# Quorb en Linux — baseline, contrato y soporte

> Documento vivo de la issue **#105** (milestone Linux portability). Congela
> el baseline medido en una máquina Linux real (Ubuntu 26.04 LTS, GNOME
> Wayland) y el contrato de soporte inicial **antes** de L1/L2/L3.
> **Cero código en esta unidad**: solo mediciones, decisiones y docs.
> Compilación ≠ experiencia funcional.
>
> **Backend actual de secretos (#302):** Secret Service es el almacén
> persistente y keyutils del kernel actúa como caché. Se necesita un Secret
> Service en ejecución, por ejemplo GNOME Keyring o KWallet. Las credenciales
> anteriores que solo estén en keyutils se copian a Secret Service la primera
> vez que Quorb las lee, siempre que sea antes de un reinicio. Las mediciones
> del baseline de 0.8.0 citadas abajo son históricas.

## 1. Resumen ejecutivo

- **Estado del port**: el binario compila, se empaqueta (`.deb` + `.AppImage`)
  y arranca en Ubuntu 26.04/GNOME Wayland, con warnings benignos de GTK y
  libayatana. El panic de arranque en Wayland (tao#1204) está resuelto e
  **integrado en `main`** ([commit
  `53058fa4`](https://github.com/sosan/quorb/commit/53058fa46ccd64c65b1ddfee320d562d6e445ca5),
  vía #107 y PRs posteriores).
- **Qué queda fuera del MVP**: distros no-Debian/Arch (Fedora, openSUSE,
  NixOS), arquitectura aarch64, macOS, firma digital (F5), paquete AUR,
  CI matrix para Arch rolling.
- **Gate de CI**: `ci.yml` (Windows) y `linux-ci.yml` (manual, por ref,
  `with_bundle: bundle` para empaquetar) + `linux-pr-ci.yml` (tests y build
  en cada PR) — cierre #108: la cobertura Linux vive en `main` (ver §4 y §8).
- **Contrato**: Ubuntu 22.04 LTS y Arch rolling (x86_64) como target; sesión
  gráfica Wayland-first; `.deb` para Debian/Ubuntu y `.AppImage` para Arch y
  resto. Sin afirmar soporte de lo no verificado (§5).

## 2. Entornos de medición (L0a)

### 2.1 Máquina real medida (host donde se redacta este doc)

| Campo | Valor |
|---|---|
| Distribución | Ubuntu 26.04 LTS (Resolute Raccoon) |
| Kernel | 6.17.0-14-generic |
| Sesión | GNOME Wayland (`XDG_SESSION_TYPE=wayland`, `WAYLAND_DISPLAY=wayland-0`) |
| Arch | x86_64 |
| node / npm | v24.15.0 / 12.0.1 |
| rustc / cargo | 1.99.0 |
| Paquete instalado | `quorb` 0.6.0 (`.deb`, instalado en el host); la versión actual de `main` es **0.8.0**. Evidencia del cierre de #108: el binario 0.8.0 del `.deb` (run `44138625351` del fork `sosan/quorb`, artefacto `quorb-linux-manual-main`) **arrancó en este compositor real**, exit 124 = vivo 30 s (§4.2). La instalación `sudo dpkg -i` del 0.8.0 se ejecutó el 19/11/2026 sobre la 0.6.0 (§4.4) |

### 2.2 Entornos complementarios con evidencia

| Entorno | Rol | Evidencia |
|---|---|---|
| Devcontainer `mcr.microsoft.com/devcontainers/base:ubuntu-22.04` (`.devcontainer/`) | Build/tests locales sin distro física | `cargo test --locked` verde (histórico) — **en `main` desde #108** (`.devcontainer/`, `Makefile`) |
| CI runner `ubuntu-22.04` (`linux-ci.yml` + `linux-pr-ci.yml`) | Bundles + verify y gate de PR | En `main` desde #108; `with_bundle: bundle` construye AppImage/deb y los verifica |
| CI runner `windows-latest` (`ci.yml`) | Regresión Windows | Verde por PR (ver §8) |
| `.deb` 0.8.0 (artefacto de un run del fork `sosan/quorb`, `44138625351`) instalado y ejecutado en host | Arranque en compositor real con la versión actual | §4.2: binario 0.8.0, exit 124 (vivo 30 s), 4 warnings benignos del baseline; instalación con `dpkg -i` ejecutada en el host |

## 3. Inventario de dependencias (L0a)

### 3.1 Toolchain de build

node 24.15, npm 12.0.1, rustc/cargo 1.99, TypeScript 5.9, Vite 7, vitest 4.1.11.

### 3.2 Dependencias Rust (`src-tauri/Cargo.toml`, main)

tauri 2 (`tray-icon`, `protocol-asset`) + 9 plugins (opener, autostart,
single-instance, notification, dialog, global-shortcut, updater, process);
reqwest (`rustls-tls`, sin openssl), rusqlite `bundled`, keyring con features
`linux-native-sync-persistent` y `crypto-rust`, serde/serde_json, chrono, dirs,
base64, futures, libc (unix). El backend usa libdbus del sistema, sin `vendored`.

### 3.3 Dependencias de sistema (runtime, las que declara el `.deb`)

Declaradas por el `.deb` (`dpkg -s quorb`): `libayatana-appindicator3-1`,
`libwebkit2gtk-4.1-0`, `libgtk-3-0`. Versiones instaladas en el host
(Ubuntu 26.04, `apt list --installed`):

| Paquete | Versión host |
|---|---|
| libwebkit2gtk-4.1-0 | 2.52.6-0ubuntu0.26.04.1 |
| libayatana-appindicator3-1 | 0.5.94-1build1 |
| libsecret-1-0 | 0.21.7-2build1 |
| libnotify4 | 0.8.8-1 |
| librsvg2-2 | 2.61.3+dfsg-3ubuntu0.1 |
| libgtk-3-0 | (dependencia del .deb, presente; ver dpkg) |

### 3.4 Dependencias de sistema (build/dev) — instaladas en devcontainer 22.04

Del `setup.sh` / workflow `apt-get install` (versiones medidas en devcontainer
22.04):

| Paquete | Versión devcontainer 22.04 |
|---|---|
| libwebkit2gtk-4.1-dev | 2.50.4-0ubuntu0.22.04.1 |
| libayatana-appindicator3-dev | 0.5.90-7ubuntu2 |
| libxdo-dev | 1:3.20160805.1-4 |
| libgtk-3-dev, libsecret-1-dev, librsvg2-dev, libnotify-dev, libssl-dev, build-essential, pkg-config | instalados vía `setup.sh` (no listados en la sesión) |
| libdbus-1-dev | requerido desde #302; no medido en el baseline histórico |

**Nota**: el host (26.04) **no tiene las dev libs** (`webkit2gtk-4.1`,
`gtk+-3.0`, `libsecret-1`, `ayatana-appindicator3-0.1`, `librsvg-2.0`,
`libnotify`, `xdo` — todos MISSING en `pkg-config`). Por eso `cargo test`
se ejecuta en el devcontainer. Es un hallazgo del baseline: **build-time
deps no instaladas por defecto en el host** → para contribuir hay que usar
el devcontainer o instalarlas a mano (§10).

## 4. Baseline medido (L0a) — comandos, exit codes, fallos preexistentes

La evidencia se cita desde **fuentes reproducibles** (GitHub Actions,
ramas del repo, releases), no desde logs de sesión ad-hoc.

### 4.1 Fuentes de evidencia reproducibles

Dos niveles de evidencia, separados explícitamente:

- **Estado integrado en upstream** (`egdev6/quorb`): `ci.yml` cubre Windows;
  `linux-pr-ci.yml` (introducido en #150) cubre tests/build por PR y
  `linux-ci.yml` (infra de #127/#108) cubre el bundle Linux de forma manual.
- **Evidencia histórica** (fork `sosan/quorb`, ramas de trabajo previas):
  las ramas `feat_native_linux` y `chore-linux-build-local-108` sirvieron como
  evidencia antes de que #107/#108 integraran su contenido en `main`; se citan
  aquí solo como contexto histórico, no como estado del upstream.

| Fuente | Ámbito | Cubre | Referencia |
|---|---|---|---|
| `ci.yml` (runner `windows-latest`; PR/push a `main`, `workflow_dispatch`) | upstream | `npm ci`, `npm test`, `npm run build`, `cargo test --locked` en Windows | https://github.com/egdev6/quorb/actions/workflows/ci.yml |
| `linux-ci.yml` (runner `ubuntu-22.04`; manual por ref, `with_bundle: bundle`) | `main` (desde #108) | `npm test`, `npm run build`, `cargo test --locked`, `npm run app:build`, `verify-deb.sh`, `verify-appimage.sh`, `Launch AppImage directly` | `.github/workflows/linux-ci.yml` |
| Rama `feat_native_linux` | externa (fork) | Commits concretos: [`7627c448`](https://github.com/sosan/quorb/commit/7627c448f49376b3379dbaf688a9e5d64a252134) (wm_compat), [`53058fa4`](https://github.com/sosan/quorb/commit/53058fa46ccd64c65b1ddfee320d562d6e445ca5) (fix tao#1204), [`74b8be72`](https://github.com/sosan/quorb/commit/74b8be72e8a3a57c0b0b1873aa13a08a784b8a14)–[`b491ae32`](https://github.com/sosan/quorb/commit/b491ae32fe81c4d4d99e93b99fb5a6d22e9ad4be) (CI AppImage) | https://github.com/sosan/quorb/commits/feat_native_linux |
| Tags `v0.6.6` / `v0.6.8` (sobre `feat_native_linux`) | externa (fork) | Build verde con plugin `continuous` (sin pin): run [`38822295271`](https://github.com/sosan/quorb/actions/runs/38822295271) (v0.6.6, 6m50s); `Launch AppImage directly` exit 124 = app viva: run [`38826266889`](https://github.com/sosan/quorb/actions/runs/38826266889) (v0.6.8, 8m20s) | runs del workflow anterior |
| Devcontainer `.devcontainer/` (Ubuntu 22.04) + Makefile | `main` (desde #108) | `npm ci`, `npm test`, `cargo test --locked` reproducibles localmente (`make up` + `make test`) | `.devcontainer/`, `Makefile` en `main` |

### 4.2 Tabla del baseline

| Comando del issue | Fuente de evidencia | Exit | Tiempo | Observaciones |
|---|---|---|---|---|
| `npm ci` | host Ubuntu 26.04 + devcontainer + CI | 0 | 12.2s (host) | 0 vulns; esbuild postinstall bloqueado por `allowScripts` (no afecta al build) |
| `npm test` | host Ubuntu 26.04 + devcontainer + CI | 0 | 11.4s (host) | 147 passed, 0 failed, 0 skipped (vitest) |
| `npm run typecheck` | host + `linux-ci.yml` / `linux-pr-ci.yml` | 0 | 17.5s (host) | `tsc --noEmit` limpio |
| `npm run build` | host + `ci.yml` + `linux-ci.yml` / `linux-pr-ci.yml` | 0 | 19.4s (host) | Vite 7.3.7, 87 modules, dist 376KB JS + 182KB CSS |
| `cargo test --locked` en `src-tauri/` | devcontainer 22.04 + CI (Windows y Linux tag) | 0 | 7m24s (devcontainer, primer build) | 98 passed, 0 failed, 0 ignored |
| `npm run app:dev` | devcontainer (`smoke-app.sh`, `xvfb-run` + `dbus-run-session`) | 124 (timeout = app viva) | — | Headless: valida "compila y arranca el main loop"; **no valida compositor** |
| `npm run app:build` (deb + AppImage) | `linux-ci.yml` (`with_bundle: bundle`, `main`) + `.testcontainer/verify-*.sh` | 0 | — | Produce `.deb` y `.AppImage`; verify con `--appimage-extract-and-run` |
| Arranque/primer uso (compositor real) | **Binario del `.deb` 0.8.0** extraído del artefacto del run `44138625351`, ejecutado en host Ubuntu 26.04/GNOME Wayland; **AppImage 0.8.0 lanzado directo en el mismo host** (FUSE real) y **`Launch AppImage directly` en runners CI** | `.deb` 0.8.0 en host: **124 = vivo 30 s**. AppImage directo en host: **127 — `Can't open squashfs image: Bad address`** (reproducido, ver §4.3 fallo 3); AppImage extraído + `AppRun`: **124 = vivo 30 s** | 30 s timeout | `.deb`: 4 warnings benignos del baseline (2× `gdk_wayland_window_set_dbus_properties_libgtk_only`, `libayatana-appindicator is deprecated`, `gtk_widget_get_scale_factor`); sin crash. AppImage extraído: mismos warnings base (más `appmenu-gtk-module` y `atk-bridge`, cosméticos). Panic tao#1204 integrado en `main` vía #107. Comandos y detalle en §4.4 |

### 4.3 Fallos preexistentes conocidos

1. **Gate Linux de PR** — **resuelto en #150**: `linux-pr-ci.yml` corre
   `npm ci`, `npm test`, `npm run build` y `cargo test --locked` en
   `ubuntu-22.04`. `linux-ci.yml` (infra de #127/#108) es el workflow manual
   por ref, con `with_bundle: bundle` para empaquetar y verificar.
2. **AppImage: FUSE y librerías de runtime son una sola cadena de montaje/arranque**.
   En el host del baseline, `lsmod | grep fuse` vacío no prueba que FUSE falte:
   `/dev/fuse` puede estar disponible con soporte del kernel, y el AppImage
   puede montar el squashfs. La evidencia de #108 confirma montaje FUSE y
   60 s de vida en kernels 6.8 y 7.0 con `libegl1`, `libgl1`, `libgles2` y
   `libfuse2`/`libfuse2t64`. Sin las librerías gráficas, WebKit aborta después
   del montaje (`Couldn't open libGLESv2.so.2`, exit 134); no es un fallo de
   squashfs ni del kernel. Si el runtime FUSE o sus librerías no están
   disponibles, el workaround es `--appimage-extract-and-run`. **Sin impacto
   en el `.deb`**.
3. **Reporte «Can't open squashfs» en kernel ≥ 6.12 — reproducido en el
   escritorio real, delimitado al runtime de montaje, no al empaquetado**.
   El diagnóstico original procede del comentario de `sosan` del 17/10 en #108,
   sobre el host del baseline (Ubuntu 26.04/kernel 6.17), no de una medición
   del mantenedor. Los runs `44186723327` y `44191439689` probaron el
   lanzamiento directo en Ubuntu 22.04/kernel 6.8 y Ubuntu 26.04/kernel 7.0:
   ambos montaron FUSE y, con `libgles2`, terminaron con exit 124 (vivos 60 s).
   Al lanzar el AppImage 0.8.0 **directo en el escritorio real del host**
   (Ubuntu 26.04/kernel 6.17.0-14-generic/GNOME Wayland) el fallo se
   **reproduce**: exit 127, `fuse: memory allocation failed` seguido de
   `Can't open squashfs image: Bad address` (§4.4 paso 2b). El payload es
   íntegro (`unsquashfs -s` lee el superbloque SQUASHFS en el offset
   `944632`; extracción completa exit 0) y la app arranca desde el payload
   extraído (exit 124 = vivo 30 s), así que el fallo está en la cadena de
   montaje FUSE del AppImage en este host, no en el empaquetado ni en la app.
   Factor de host: `appimagelauncher` está instalado aquí (binfmt_misc
   `appimage-type2` → `/usr/bin/AppImageLauncher`, build 22.04) e intercepta
   la ejecución; el montaje falla igual con `APPIMAGELAUNCHER_DISABLE=1`
   (runtime propio) y con `--appimage-extract-and-run` (interceptado). En CI
   no hay AppImageLauncher y el mismo artefacto monta (6.8/7.0), así que **no
   se afirma un límite general de kernels ≥ 6.12**; queda como límite el
   arranque directo del AppImage en este escritorio real con
   `AppImageLauncher` presente, con workaround probado (unsquashfs + AppRun)
   y el `.deb` como vía recomendada en Debian/Ubuntu.
4. **Backend de secretos del baseline 0.8.0** — entonces `keyring` usaba
   `linux-native`, solo keyutils del kernel. Desde #302 se configura el backend
   combinado: Secret Service persiste y keyutils sirve de caché. Las mediciones
   históricas de #106 no prueban el backend persistente actual.
5. **Hallazgos de contribuidores** (del comentario de Rafael en #105):
   `connect_map` GTK crash y `startDragging()` nativo vs layer-shell pertenecen
   al ajuste de escritorio de #107/#290, no al empaquetado de #108.

### 4.4 Evidencia del cierre de #108 (versión 0.8.0, host real)

Comandos ejecutados en el host del baseline (Ubuntu 26.04/GNOME Wayland) con la
versión actual, sin exponer credenciales. Los artefactos provienen de runs del
fork `sosan/quorb` (`44138625351`, `44186723327` y `44191439689`); no son runs
del upstream `egdev6/quorb`. El resultado con kernel 7.0 procede de una matriz
de ese fork que no está definida en `linux-ci.yml`.

```bash
# 1) Verificar el .deb 0.8.0 (artefacto del run 44138625351 del fork, ya descargado)
unzip -o artifact.zip          # Quorb_0.8.0_amd64.deb (5.0 MiB), Quorb_0.8.0_amd64.AppImage
dpkg-deb --info Quorb_0.8.0_amd64.deb
#   Depends: libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0  (ya presentes)

# 2) Instalación real (EJECUTADA el 19/11/2026: 0.8.0 sobre la 0.6.0 del host)
sudo dpkg -i Quorb_0.8.0_amd64.deb   # requiere autenticación interactiva
dpkg -l quorb                  # -> ii quorb 0.8.0 amd64 (instalación formal)

# 2b) AppImage lanzado DIRECTO en el escritorio real (montaje FUSE real)
APPIMAGELAUNCHER_DISABLE=1 timeout -k 5 30 ./Quorb_0.8.0_amd64.AppImage
#   -> exit 127: "fuse: memory allocation failed" + "Can't open squashfs
#      image: Bad address"  (reproduce el reporte original del 17/10)
# Separar payload (sano) de la cadena de montaje (la que falla):
#   APPIMAGELAUNCHER_DISABLE=1 ./Quorb_0.8.0_amd64.AppImage --appimage-offset
#     -> 944632
#   dd if=Quorb_0.8.0_amd64.AppImage of=payload.squashfs bs=1 skip=944632
#   unsquashfs -s payload.squashfs      # superbloque SQUASHFS válido (zstd)
#   unsquashfs -d squashfs-root payload.squashfs && ./squashfs-root/AppRun
#     -> exit 124 (vivo 30 s); warnings base + appmenu-gtk-module (cosmético)
# Nota: este host tiene `appimagelauncher` (binfmt appimage-type2) que
# intercepta la ejecución; con APPIMAGELAUNCHER_DISABLE=1 el runtime propio
# tampoco monta; `--appimage-extract-and-run` también queda interceptado.
# El `.deb` no se ve afectado (montaje no aplica). Detalle en §4.3 fallo 3.

# 3) Arranque del binario INSTALADO en el compositor real
#    (medido 19/11: exit 124 = vivo 30 s)
timeout -k 5 30 /usr/bin/quorb > launch.log 2>&1; echo $?   # -> 124
# Warnings benignos (idénticos al baseline): 2x Gdk-CRITICAL
#   gdk_wayland_window_set_dbus_properties_libgtk_only, libayatana-appindicator
#   is deprecated, gtk_widget_get_scale_factor.

# 4) Backend de secretos del baseline 0.8.0 (keyutils, antes de #302)
keyctl show
#   Session Keyring con los keyrings de sesión, usuario y persistente (keyutils)

# 5) CLI auxiliares a las que Quorb delega (según instalación del host)
command -v claude cursor        # presentes en este host; codex/gemini/copilot no
```

Resultado end-to-end medido: config ya presente en el directorio de configuración de Quorb
(claves normales, sin leer valores), backend keyutils accesible, bandeja montada
(`libayatana` sin crash) y widget vivo en el compositor. La instalación formal
se ejecutó el 19/11/2026 sobre la 0.6.0: `dpkg -l quorb` devuelve `ii quorb
0.8.0 amd64`, y `/usr/bin/quorb` queda vivo 30 s (exit 124), con los cuatro
warnings benignos del baseline. El AppImage se lanzó directo en este mismo
escritorio y reproduce el síntoma original (`Can't open squashfs image: Bad
address`, exit 127); el payload es íntegro y la app extraída queda viva 30 s
(exit 124), así que el fallo se delimita a la cadena de montaje FUSE del host
(§4.3 fallo 3), no al empaquetado ni a la app. Codex/gemini/copilot no están
instalados en el host, por lo que su delegación CLI no se mide en esta sesión.

## 5. Contrato de soporte inicial (L0b)

Decisiones aceptadas en este baseline (revisables solo con evidencia nueva):

| Tema | Decisión |
|---|---|
| Distribuciones target | Ubuntu 22.04 LTS y Arch rolling, ambas x86_64. El resto (Fedora, openSUSE, NixOS) queda fuera del MVP |
| Arquitectura | x86_64. `aarch64` diferido |
| Sesión gráfica | GNOME Wayland y KDE Plasma Wayland soportados; Hyprland con degradaciones documentadas; X11 best-effort |
| Política X11/Wayland | **Wayland-first**: la app arranca y funciona bajo Wayland; en X11 funciona pero sin garantías de always-on-top/click-through estrictos. Degradaciones documentadas en el bloque "Compatibilidad" de Ajustes (integrado con #107; ajuste diagnóstico residual en #290) |
| Bandeja | `libayatana-appindicator3` (recomendado); `libappindicator3` legacy como fallback si la distro no provee ayatana |
| Paquete local | `.deb` (Debian/Ubuntu) y `.AppImage` (Arch y resto). AUR fuera del MVP. Firma digital fuera (F5) |
| Compilación ≠ experiencia | El binario puede compilar y no ser usable en un compositor/distro dado; esto no se considera "soportado" sin la matriz §6 y el smoke real |

## 6. Matriz de 8 entornos (L0b) — qué funciona y qué degrada

Celdas: `medido` (con evidencia de esta sesión/CI), `pendiente contribuidor`
(no verificado aquí; CachyOS/Omarchy/Arch por Rafael y la comunidad),
`n/a` (no aplicable en ese entorno).

| Entorno | Install | app:dev/arranque | Widget | Click-through | Always-on-top | Bandeja | Arranque automático | Secretos |
|---|---|---|---|---|---|---|---|---|
| Ubuntu 22.04 X11 (GNOME) | medido (devcontainer) | n/a (sin compositor en container) | n/a | n/a | n/a | n/a | n/a (sin sesión gráfica) | pendiente F2 |
| Ubuntu 22.04 Wayland (GNOME) | medido (CI runner) | medido indirecto (xvfb) | n/a | degradación Mutter (esperado, no verificado) | degradación Mutter (esperado) | libayatana | n/a (sin inicio de sesión) | pendiente F2 |
| Ubuntu 26.04 Wayland (GNOME) | medido (host) | medido (.deb) | sí | degradación Mutter (esperado) | degradación Mutter (esperado) | libayatana | pendiente | pendiente F2 |
| Arch rolling GNOME (Wayland) | pendiente contribuidor | – | – | – | – | – | – | – |
| Arch rolling KDE Plasma (Wayland) | pendiente contribuidor | – | – | – | – | – | – | – |
| CachyOS KDE Plasma | pendiente contribuidor | – | – | – | – | – | medido por emulación en Wayland (#290): arranca en Wayland nativo | – |
| CachyOS Hyprland (0.57.0) | medido (contribuidor, #250) | medido (Wayland nativo y XWayland) | sí con #250 (61×181 ajustada a la tira; sin el fix, caja de 1270×1026 en nativo y mosaico en XWayland) | pendiente | pendiente | pendiente | pendiente | pendiente |
| Omarchy Hyprland | pendiente contribuidor | – | – | – | – | – | – | – |

> Arranque automático (#290): en ningún entorno consta como `ok`; el diagnóstico
> lo marca `limited`. Medición con la emulación de un inicio de sesión
> (`systemctl --user start app-Quorb@autostart.service`, KDE Plasma 6.7.5 en
> Wayland, AppImage 0.8.0): el plugin escribe `~/.config/autostart/Quorb.desktop`
> con `Exec=<ruta>` sin argumentos ni variables, y Quorb arranca con
> `WAYLAND_DISPLAY` y sin `GDK_BACKEND`, es decir, en **Wayland nativo** (sin
> posicionamiento de la tira) aunque se use normalmente con
> `GDK_BACKEND=x11`. Hyprland y sway no ejecutan las entradas XDG autostart
> por sí solos (requieren uwsm, dex o el generador de systemd), así que ahí
> puede no arrancar. Sin verificar: un inicio de sesión real, la tira a simple
> vista, GNOME, Hyprland y Plasma X11. Con una ruta con espacios el generador
> de systemd no crea la unidad y nada lo avisa. Aparte, el consejo de
> «Auto-hide» solo se ofrece donde el posicionamiento es `ok` (X11/XWayland).
>
> Nota: la matriz cubre solo lo **medido o asignado**. Las celdas sin evidencia
> no se marcan como soportadas; la política de soporte (§5) es el único
> compromiso aceptado.

### 6.1 Posicionamiento de la tira: Wayland nativo y alternativa XWayland (#180)

- **Wayland nativo**: ni `gtk_window_move` ni `xdg-shell` exponen posición
  absoluta al cliente. El arrastre de la tira usa el gesto del compositor
  (`startDragging`), sin imán al borde ni persistencia de `dockEdge`/`dockOffset`
  al soltar: no se escribe `config.json` con coordenadas que el cliente no
  puede verificar. La fila «Posicionamiento de la ventana» del bloque
  «Sesión de escritorio» reporta `limited` aquí.
- **Alternativa XWayland**: arrancar con `GDK_BACKEND=x11` fuerza el pipeline
  X11 completo (imán al borde + persistencia de la posición; la fila reporta
  `ok`). GTK acepta la variable como lista separada por comas y decide el
  backend efectivo en runtime, así que bajo XWayland la app ve X11
  (clase `GdkX11Display`) aunque la sesión del escritorio sea Wayland.
  **El valor tiene que llegar al proceso de la app**: lanzalo en la misma
  línea (`GDK_BACKEND=x11 npm run app:dev` o `GDK_BACKEND=x11 quorb`) o
  expórtalo antes (`export GDK_BACKEND=x11`). Un comando separado con `&`
  (por ejemplo `GDK_BACKEND=x11 &` en su propia línea) aplica la variable solo
  a la subshell y la app no la hereda.
- **Hyprland (medido, #250)**: la instalación medida es **CachyOS con Hyprland
  0.57.0** (Wayland nativo y XWayland). En Wayland nativo el compositor conserva el
  tamaño con el que mapea la ventana (caja decorada de 1270×1026 cuando se
  pide 61×181) porque la ruta sin ciclo no manda la petición de tamaño ni las
  pistas `min == max`; en XWayland la coloca en mosaico y el layout fija el
  tamaño (`SizeRefused`). El fix (#250) manda las pistas en la ruta sin
  ciclo y declara el tipo de ventana `Utility` antes del primer `show`, en
  ambos casos solo para el perfil Hyprland: el resto de escritorios conserva
  el comportamiento de siempre.
- **Omarchy con Hyprland no está medido**: la fila de Omarchy queda
  `pendiente contribuidor`. Lo medido en CachyOS no se extiende a Omarchy
  (distribución y compositor distintos) hasta que alguien lo mida.

### 6.2 Todos los escritorios en KDE Plasma (Wayland) con XWayland: regla de KWin optativa (#227)

Quorb pide que la tira, el detalle y el overlay estén en todos los escritorios
virtuales (`gtk_window_stick`, #232). KWin en sesión Wayland ignora esa petición
cuando viene de un cliente XWayland: le informa un solo escritorio y descarta
sus cambios de escritorio (commit de KWin `55fd1912`; la variable que permitía
desactivarlo se eliminó en `672c3c74`, incluido en 6.7.5). En ese entorno la
tira se queda en el escritorio donde se abrió.

**Apaño manual, optativo y creado por el usuario**: una regla de KWin. Quorb no
la instala ni carga scripts en el compositor, y no es un arreglo general (#227
sigue abierta).

En *Preferencias del sistema → Gestión de ventanas → Reglas de ventanas*, una
regla nueva con:

- **Clase de ventana**: `[Qq]uorb`, como expresión regular. La comparación
  distingue mayúsculas y KWin ve la clase como `Quorb`, así que `quorb` a secas
  no coincide.
- **Título de ventana**: `^Quorb( · .+)?$`, como expresión regular.
- **Escritorio virtual**: *Forzar* → *Todos los escritorios*.

Equivale a esta entrada de `~/.config/kwinrulesrc` (`<id>` es cualquier
identificador único; si ya hay reglas, se añade a la lista `rules` y se
incrementa `count`). KWin la aplica tras `qdbus6 org.kde.KWin /KWin reconfigure`:

```ini
[General]
count=1
rules=<id>

[<id>]
Description=Quorb en todos los escritorios
wmclass=[Qq]uorb
wmclassmatch=3
wmclasscomplete=false
title=^Quorb( · .+)?$
titlematch=3
desktops=\\0
desktopsrule=2
```

**Qué ventanas alcanza.** La regla coincide con la tira (`Quorb`), el detalle
(`Quorb · detalle` / `Quorb · details`) y el overlay (`Quorb · efectos` /
`Quorb · effects`). No coincide con Ajustes (`Ajustes · Quorb` /
`Settings · Quorb`) ni con el selector de idioma del primer arranque
(`Idioma / Language · Quorb`). La expresión es la misma de siempre: coincide con
`Quorb` o con `Quorb · …`. Ajustes y el selector quedan fuera porque su título
no empieza por `Quorb`. Se filtra por título porque las ventanas no exponen
`WM_WINDOW_ROLE`.
El test `documented_kwin_rule_matches_only_strip_detail_and_overlay`
(`src-tauri/src/lib.rs`) lee la línea `title=` de este bloque y la comprueba
contra los títulos reales: si cambia la regla o un título, falla.

**Entorno probado y limitaciones medidas**: CachyOS, KDE Plasma / KWin 6.7.5 en
sesión Wayland, Quorb por XWayland (`GDK_BACKEND=x11`), tres escritorios.

- La tira y el detalle transitorio acompañan al cambiar de escritorio; Ajustes
  se queda en el suyo (3 de 3 pruebas).
- El detalle anclado acompañó en 2 de 3 pruebas; en la otra desapareció al
  cambiar de escritorio, sin causa identificada.
- El overlay solo se pudo medir en 1 de 3 pruebas, porque el efecto dura unos
  4 s; en esa quedó en todos los escritorios.
- Plasma X11 y GNOME no están verificados. En Wayland nativo no aplica: no hay
  protocolo para pedir «todos los escritorios».

## 7. Riesgos priorizados (L0a→L0d)

| Riesgo | Prob. | Impacto | Mitigación | Evidencia / entrada de código |
|---|---|---|---|---|
| tao 0.37.1 panicea en `CursorIgnoreEvents` si la ventana está oculta (GdkWindow None) | Alta (reproducido) | Alto (crash al arrancar en Wayland) | Fix `53058fa`: `set_ignore_cursor_events` tras `show()`, no en setup; integrado en `main` por #107/#275 | `src-tauri/src/lib.rs` `run()`/`play_effect`; tao `event_loop.rs:457`; upstream tao#1204 |
| AppImage: cadena FUSE + librerías gráficas de runtime | Media: monta en CI (kernel 6.8 y 7.0, runs del fork) pero falla en el escritorio real del host (§4.3 fallo 3) | Bajo (el `.deb` no lo sufre) | Requiere `/dev/fuse` (cargar el módulo con `sudo modprobe fuse` solo si no está cargado, §10) y, en los runs del fork, `libegl1/libgl1/libgles2` + `libfuse2`/`libfuse2t64`; workaround `--appimage-extract-and-run` | Runs de §4.3: montaje FUSE + vivo 60 s en CI |
| WebKit2GTK ≥ 2.40 / GTK ≥ 3.22 (distros antiguas) | Media | Alto (excluye usuarios) | Documentar versión mínima; diferir distros no-Debian/Arch | PRD línea 110; `linux-ci.yml` apt |
| libayatana deprecation warning en runtime | Alta (cosmético) | Bajo | Nada (no impide) | Log de arranque del `.deb` (host) |
| `keyring` requiere keyutils y un Secret Service en ejecución (GNOME Keyring o KWallet) | Media | Medio | Fallo explícito al guardar si no hay Secret Service, sin fallback a texto plano; keyutils es solo la caché | `src-tauri/src/secrets.rs` (`keyring::Entry::new`) |
| `connect_map` GTK crash (Rafael) | Desconocida | Medio | Ajuste de escritorio #107/#290, fuera del empaquetado | Comentario de Rafael en #105 |
| `startDragging()` nativo vs layer-shell (Rafael) | Desconocida | Medio | Ajuste de escritorio #107/#290, fuera del empaquetado | Comentario de Rafael en #105 |
| ~~No hay gate de CI Linux para PRs~~ (resuelto en #150; infra de bundles en #127/#108) | — | — | `linux-pr-ci.yml` (tests+build por PR, desde #150) y `linux-ci.yml` (manual, `with_bundle`, desde #127/#108) | `linux-ci.yml`/`linux-pr-ci.yml` en `main` |
| AppImage «Can't open squashfs» (reporte de `sosan` del 17/10 en #108, host del baseline) | **Reproducido en el escritorio real del host** (exit 127, `Can't open squashfs image: Bad address` tras `fuse: memory allocation failed`); **no en CI** (monta vía FUSE y vive 60 s, exit 124, en kernel 6.8 y 7.0 con `libgles2`) | Bajo (no afecta al `.deb`; workaround probado) | Workaround probado: extraer el payload (`unsquashfs -o 944632`) y ejecutar `AppRun`, o usar el `.deb`; `--appimage-extract-and-run` queda interceptado por AppImageLauncher en este host; runtime alternativo fuera del alcance; delimitado en §4.3 fallo 3 | Cierre #108 |

## 8. Plan de pruebas y regresión Windows (L0d)

- **Linux (gate de release)**: `npm test`, `cargo test --locked`, `npm run
  app:build`, `verify-deb.sh`/`verify-appimage.sh`, y el paso **`Launch
  AppImage directly`** (FUSE real) están verdes en `linux-ci.yml` (manual,
  `with_bundle: bundle`).
- **Linux (gate de PR)**: **resuelto en #150** — `linux-pr-ci.yml` corre
  tests y build en cada PR (sin gate de bundles, que queda en el workflow
  manual de #127/#108).
- **Windows (regresión)**: `ci.yml` (windows-latest) sigue verde por PR; el
  bundle Windows (`nsis`/`msi`) queda inalterado — los cambios Linux no tocan
  los targets Windows de `tauri.conf.json`.
- **Límites no verificados declarados**: distros fuera del MVP, sesiones sin
  D-Bus, compositores no listados en §6, aarch64, macOS. Ninguno de estos se
  afirma como soportado.

## 9. Desglose L1–L3 (L0d)

| Nivel | Issue | Alcance | Validación |
|---|---|---|---|
| L1 | #106 — sesiones, secretos y login CLI nativos (**cerrada**) | Rutas Linux, backend de entonces `keyring`/keyutils, login CLI y recuperación documentados | Validación histórica de #106; backend actual combinado desde #302 |
| L2 | #107 — escritorio y widget nativos (**integrada; ajuste diagnóstico en #290**) | Bloque de compatibilidad y fixes de escritorio; tao#1204 integrado en `main` | Smoke de CI + ajustes pendientes de #290 |
| L3 | #108 — empaquetar y documentar un build local verificable (**esta PR**) | `.deb` + `.AppImage` reproducibles, docs actualizados y gate Linux ya disponible | `linux-ci.yml` + `linux-pr-ci.yml` + evidencia de AppImage en §4.3 |

## 10. Anexo A — comandos reproducidos

Cada bloque indica en qué máquina se ejecutó y su exit code esperado (medido
en este baseline).

```bash
# --- Build-time deps (solo para contribuir / hacer cargo test) ---
# Host Ubuntu 22.04/26.04:
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libdbus-1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libsecret-1-dev libnotify-dev libgtk-3-dev
# (o usar el devcontainer: `devcontainer up` según el Makefile — evita
#  tocar el host; no requiere instalar nada en la máquina real)

# --- Runtime deps del .deb (las que declara el paquete) ---
sudo apt-get install -y libayatana-appindicator3-1 libwebkit2gtk-4.1-0 libgtk-3-0

# --- Comandos del baseline (exit codes medidos: todos 0) ---
npm ci                      # exit 0 (host 26.04, 12.2s)
npm test                    # exit 0 (host 26.04, 147 passed)
npm run typecheck           # exit 0 (host 26.04)
npm run build               # exit 0 (host 26.04)
(cd src-tauri && cargo test --locked)   # exit 0 (devcontainer 22.04, 98 passed)

# --- AppImage sin FUSE (workaround si el módulo no está cargado) ---
sudo modprobe fuse          # carga el módulo; si no existe el .ko:
sudo apt install linux-modules-extra-$(uname -r)
# alternativa sin módulo (montaje no vía FUSE):
./Quorb_*.AppImage --appimage-extract-and-run
```

## 11. Anexo B — entradas del código contrastadas

| Entrada | Esperado | Comportamiento real observado |
|---|---|---|
| `src-tauri/tauri.conf.json` | Windows-first con Linux: `nsis`/`msi` + `deb`/`appimage` | Confirmado desde #108: `bundle.targets` de `main` incluye los cuatro |
| `src-tauri/src/lib.rs` `run()` | Arranque sin crash, single-instance, shortcuts, tray | Arranca en host: `.deb` 0.8.0 y AppImage 0.8.0 extraído, ambos exit 124 = vivo 30 s (evidencia de la versión actual en §4.4 de esta PR); panic tao#1204 resuelto e integrado (via #107) |
| `src-tauri/src/secrets.rs` | `keyring::Entry::new` con `linux-native-sync-persistent` | Secret Service persistente con caché keyutils; el baseline #106 medía el backend anterior solo keyutils |
| `src-tauri/src/login.rs` | Login CLI con terminal Linux | Cascade `$TERMINAL → ghostty → kitty → alacritty`, validado en #106 (cerrada) |
| `src-tauri/src/providers/` (11 módulos: anthropic_api, claude, codex, copilot, cursor, gemini, nan, nan_cloud, openai_api, openrouter) | Puro HTTP (reqwest) | Sin dependencia específica de plataforma; portables |
| `src/lib/dock.ts` | Geometría de bordes (píxeles lógicos) | Sin dependencia de plataforma; portables |
| `src/Settings.tsx` | Bloque "Compatibilidad" (F3) | Integrado en main (vía #107): `src/lib/desktop-compat.ts` (`desktopCompatRows`/`showDesktopCompat`) renderizado en Ajustes; matriz de entornos en §6 |

## 12. Referencias

- Issue #105: `https://github.com/egdev6/quorb/issues/105`
- PRD local: `.claude/prds/linux-portability.prd.md` (referencia al working
  tree; el PRD no forma parte de este PR)
- Rama de trabajo: `feat_native_linux` (commits `7627c44`–`b491ae3`)
- Upstream tao: `tauri-apps/tao#1204` (fix del panic CursorIgnoreEvents)
- AppImage FUSE: `https://github.com/AppImage/AppImageKit/wiki/FUSE`
