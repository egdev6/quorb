# Quorb en Linux — baseline, contrato y soporte

> Documento vivo de la issue **#105** (milestone Linux portability). Congela
> el baseline medido en una máquina Linux real (Ubuntu 26.04 LTS, GNOME
> Wayland) y el contrato de soporte inicial **antes** de L1/L2/L3.
> **Cero código en esta unidad**: solo mediciones, decisiones y docs.
> Compilación ≠ experiencia funcional.

## 1. Resumen ejecutivo

- **Estado del port**: el binario compila, se empaqueta (`.deb` + `.AppImage`)
  y arranca en Ubuntu 26.04/GNOME Wayland, con warnings benignos de GTK y
  libayatana. El panic de arranque en Wayland (tao#1204) está resuelto en la
  rama `feat_native_linux` ([commit
  `53058fa4`](https://github.com/sosan/quorb/commit/53058fa46ccd64c65b1ddfee320d562d6e445ca5),
  evidencia externa del fork) y pendiente de integrar a
  `main` vía #107.
- **Qué queda fuera del MVP**: distros no-Debian/Arch (Fedora, openSUSE,
  NixOS), arquitectura aarch64, macOS, firma digital (F5), paquete AUR,
  CI matrix para Arch rolling.
- **Gate de CI**: `ci.yml` corre **solo en Windows**; la cobertura Linux vive
  en `build-linux.yml` (tags `v*` o `workflow_dispatch`). No hay gate de PR
  para Linux — hallazgo de este baseline (ver §4 y §8).
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
| Paquete instalado | `quorb` 0.6.0 (`.deb`) |

### 2.2 Entornos complementarios con evidencia

| Entorno | Rol | Evidencia |
|---|---|---|
| Devcontainer `mcr.microsoft.com/devcontainers/base:ubuntu-22.04` (`.devcontainer/`) | Build/tests locales sin distro física | `cargo test --locked` verde (§4) — **evidencia externa**: infra parked en `chore-linux-build-local-108` (fork, revisión #108), no incluida en este candidato |
| CI runner `ubuntu-22.04` (`build-linux.yml`) | Bundles + verify | Tags `v0.6.6`/`v0.6.8` verdes (§4, fork externo; workflow no en este candidato) |
| CI runner `windows-latest` (`ci.yml`) | Regresión Windows | Verde por PR (ver §8) |
| `.deb` v0.6.6 instalado en host | Arranque en compositor real | §4 |

## 3. Inventario de dependencias (L0a)

### 3.1 Toolchain de build

node 24.15, npm 12.0.1, rustc/cargo 1.99, TypeScript 5.9, Vite 7, vitest 4.1.11.

### 3.2 Dependencias Rust (`src-tauri/Cargo.toml`, main)

tauri 2 (`tray-icon`, `protocol-asset`) + 9 plugins (opener, autostart,
single-instance, notification, dialog, global-shortcut, updater, process);
reqwest (`rustls-tls`, sin openssl), rusqlite `bundled`, keyring con feature
`linux-native`, serde/serde_json, chrono, dirs, base64, futures, libc (unix).

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

- **Estado integrado en upstream** (`egdev6/quorb`): `ci.yml` (Windows) es el
  único workflow CI presente en `main` de este candidato.
- **Evidencia externa** (fork `sosan/quorb`, ramas de trabajo e infra parked):
  proveniente de las ramas `feat_native_linux` y `chore-linux-build-local-108`
  (revisión de #108). No está integrada en `main`; se cita para contrastar las
  mediciones, no como estado del upstream.

| Fuente | Ámbito | Cubre | Referencia |
|---|---|---|---|
| `ci.yml` (runner `windows-latest`; PR/push a `main`, `workflow_dispatch`) | upstream | `npm ci`, `npm test`, `npm run build`, `cargo test --locked` en Windows | https://github.com/egdev6/quorb/actions/workflows/ci.yml |
| `build-linux.yml` (runner `ubuntu-22.04`; tag `v*`, `workflow_dispatch`) | externa (fork) | `npm test`, `npm run build`, `cargo test --locked`, `npm run app:build`, `verify-deb.sh`, `verify-appimage.sh`, `Launch AppImage directly` | https://github.com/sosan/quorb/actions/workflows/build-linux.yml |
| Rama `feat_native_linux` | externa (fork) | Commits concretos: [`7627c448`](https://github.com/sosan/quorb/commit/7627c448f49376b3379dbaf688a9e5d64a252134) (wm_compat), [`53058fa4`](https://github.com/sosan/quorb/commit/53058fa46ccd64c65b1ddfee320d562d6e445ca5) (fix tao#1204), [`74b8be72`](https://github.com/sosan/quorb/commit/74b8be72e8a3a57c0b0b1873aa13a08a784b8a14)–[`b491ae32`](https://github.com/sosan/quorb/commit/b491ae32fe81c4d4d99e93b99fb5a6d22e9ad4be) (CI AppImage) | https://github.com/sosan/quorb/commits/feat_native_linux |
| Tags `v0.6.6` / `v0.6.8` (sobre `feat_native_linux`) | externa (fork) | Build verde con plugin `continuous` (sin pin): run [`38822295271`](https://github.com/sosan/quorb/actions/runs/38822295271) (v0.6.6, 6m50s); `Launch AppImage directly` exit 124 = app viva: run [`38826266889`](https://github.com/sosan/quorb/actions/runs/38826266889) (v0.6.8, 8m20s) | runs del workflow anterior |
| Devcontainer `.devcontainer/` (Ubuntu 22.04) + Makefile | externa (parked) | `npm ci`, `npm test`, `cargo test --locked` reproducibles localmente | rama `chore-linux-build-local-108` del fork (en revisión en #108); **no está en este candidato** |

### 4.2 Tabla del baseline

| Comando del issue | Fuente de evidencia | Exit | Tiempo | Observaciones |
|---|---|---|---|---|
| `npm ci` | host Ubuntu 26.04 + devcontainer + CI | 0 | 12.2s (host) | 0 vulns; esbuild postinstall bloqueado por `allowScripts` (no afecta al build) |
| `npm test` | host Ubuntu 26.04 + devcontainer + CI | 0 | 11.4s (host) | 147 passed, 0 failed, 0 skipped (vitest) |
| `npm run typecheck` | host + `build-linux.yml` (Linux tag) | 0 | 17.5s (host) | `tsc --noEmit` limpio |
| `npm run build` | host + `ci.yml` + `build-linux.yml` | 0 | 19.4s (host) | Vite 7.3.7, 87 modules, dist 376KB JS + 182KB CSS |
| `cargo test --locked` en `src-tauri/` | devcontainer 22.04 + CI (Windows y Linux tag) | 0 | 7m24s (devcontainer, primer build) | 98 passed, 0 failed, 0 ignored |
| `npm run app:dev` | devcontainer (`smoke-app.sh`, `xvfb-run` + `dbus-run-session`) | 124 (timeout = app viva) | — | Headless: valida "compila y arranca el main loop"; **no valida compositor** |
| `npm run app:build` (deb + AppImage) | `build-linux.yml` (tags `v0.6.6`/`v0.6.8`) + `.testcontainer/verify-*.sh` | 0 | — | Produce `.deb` y `.AppImage`; verify con `--appimage-extract-and-run` |
| Arranque/primer uso (compositor real) | `.deb` v0.6.6 en host Ubuntu 26.04/GNOME Wayland; `Launch AppImage directly` en `build-linux.yml` (runner 22.04 con FUSE real) | 0 (proceso estable) | — | Warnings benignos: `gdk_wayland_window_set_dbus_properties_libgtk_only` (Gdk-CRITICAL), `libayatana-appindicator is deprecated` (cosmético), `gtk_widget_get_scale_factor` (Gtk-CRITICAL). Panic de tao#1204 **resuelto** en `53058fa` (feat_native_linux) |

### 4.3 Fallos preexistentes conocidos

1. **No hay CI Linux para PRs** — `ci.yml` corre solo en `windows-latest`.
   Para validar Linux hay que usar un tag `v*` o `workflow_dispatch`
   manual. (Workaround actual; el fix es decisión de #108/CI.)
2. **AppImage requiere el módulo `fuse` del kernel** — en el host Ubuntu
   26.04/kernel 6.17, `lsmod | grep fuse` está vacío (el módulo no está
   cargado por defecto en esta instalación), aunque `/dev/fuse` existe y
   `libfuse2t64`/`libfuse3-4` están instalados. Sin el módulo, el
   `AppRun` interno no puede montar el payload y falla con
   `fuse: memory allocation failed` / `Cannot mount AppImage`. Workaround
   documentado en §10 (`sudo modprobe fuse` o `linux-modules-extra-$(uname -r)`).
   **Sin impacto en el `.deb`**.
3. **Backend de secretos: `keyring` 3.6.3 con la feature `linux-native` usa
   keyutils** (crate `linux-keyutils`, keyring del kernel), **no Secret
   Service/D-Bus**. Sin sesión de escritorio no se espera un fallo por
   ausencia de D-Bus; la persistencia y el comportamiento exacto (incluido
   el fallo explícito del command en entornos sin keyutils) se confirman en
   F2/#106 (placeholder hasta entonces). La migración a Secret Service
   queda en #106, sin cambio de dependencias en esta PR.
4. **Hallazgos de contribuidores** (del comentario de Rafael en #105):
   `connect_map` GTK crash y `startDragging()` nativo vs layer-shell
   pertenecen a F3/#107, no a este baseline.

## 5. Contrato de soporte inicial (L0b)

Decisiones aceptadas en este baseline (revisables solo con evidencia nueva):

| Tema | Decisión |
|---|---|
| Distribuciones target | Ubuntu 22.04 LTS y Arch rolling, ambas x86_64. El resto (Fedora, openSUSE, NixOS) queda fuera del MVP |
| Arquitectura | x86_64. `aarch64` diferido |
| Sesión gráfica | GNOME Wayland y KDE Plasma Wayland soportados; Hyprland con degradaciones documentadas; X11 best-effort |
| Política X11/Wayland | **Wayland-first**: la app arranca y funciona bajo Wayland; en X11 funciona pero sin garantías de always-on-top/click-through estrictos. Degradaciones documentadas en el bloque "Compatibilidad" de Ajustes (F3/#107 lo implementa) |
| Bandeja | `libayatana-appindicator3` (recomendado); `libappindicator3` legacy como fallback si la distro no provee ayatana |
| Secretos | Backend: `keyring` 3.6.3 con feature `linux-native` → **keyutils** (`linux-keyutils`, keyring del kernel) por defecto, **con soporte Secret Service/D-Bus vía libsecret** (GNOME Keyring/KWallet) implementado en #106/#122. Round-trip con Secret Service validado por el mantenedor en escritorio Linux real. Si no hay keyutils del kernel ni sesión D-Bus con llavero, el command falla explícitamente — **sin fallback a texto plano**. Mensaje accionable en Ajustes vía la heurística de `src/lib/keyring-message.ts` |
| Paquete local | `.deb` (Debian/Ubuntu) y `.AppImage` (Arch y resto). AUR fuera del MVP. Firma digital fuera (F5) |
| Compilación ≠ experiencia | El binario puede compilar y no ser usable en un compositor/distro dado; esto no se considera "soportado" sin la matriz §6 y el smoke real |

## 6. Matriz de 7 entornos (L0b) — qué funciona y qué degrada

Celdas: `medido` (con evidencia de esta sesión/CI), `pendiente contribuidor`
(no verificado aquí; CachyOS/Omarchy/Arch por Rafael y la comunidad),
`n/a` (no aplicable en ese entorno).

| Entorno | Install | app:dev/arranque | Widget | Click-through | Always-on-top | Bandeja | Secretos |
|---|---|---|---|---|---|---|---|
| Ubuntu 22.04 X11 (GNOME) | medido (devcontainer) | n/a (sin compositor en container) | n/a | n/a | n/a | n/a | pendiente F2 |
| Ubuntu 22.04 Wayland (GNOME) | medido (CI runner) | medido indirecto (xvfb) | n/a | degradación Mutter (esperado, no verificado) | degradación Mutter (esperado) | libayatana | pendiente F2 |
| Ubuntu 26.04 Wayland (GNOME) | medido (host) | medido (.deb) | sí | degradación Mutter (esperado) | degradación Mutter (esperado) | libayatana | pendiente F2 |
| Arch rolling GNOME (Wayland) | pendiente contribuidor | – | – | – | – | – | – |
| Arch rolling KDE Plasma (Wayland) | pendiente contribuidor | – | – | – | – | – | – |
| CachyOS KDE Plasma | pendiente contribuidor | – | – | – | – | – | – |
| CachyOS / Omarchy Hyprland | pendiente contribuidor (Rafael) | – | – | – | – | – | – |

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

## 7. Riesgos priorizados (L0a→L0d)

| Riesgo | Prob. | Impacto | Mitigación | Evidencia / entrada de código |
|---|---|---|---|---|
| tao 0.37.1 panicea en `CursorIgnoreEvents` si la ventana está oculta (GdkWindow None) | Alta (reproducido) | Alto (crash al arrancar en Wayland) | Fix `53058fa` (feat_native_linux): `set_ignore_cursor_events` tras `show()`, no en setup. Integrar en #107 | `src-tauri/src/lib.rs` `run()`/`play_effect`; tao `event_loop.rs:457`; upstream tao#1204 |
| AppImage no monta sin módulo `fuse` del kernel (Ubuntu 26.04/kernel 6.17) | Media (host sin auto-load) | Medio (AppImage inusable en ese host) | `sudo modprobe fuse` / `linux-modules-extra-$(uname -r)` (§10); el `.deb` no lo sufre | `lsmod` vacío + `/dev/fuse` presente (host) |
| WebKit2GTK ≥ 2.40 / GTK ≥ 3.22 (distros antiguas) | Media | Alto (excluye usuarios) | Documentar versión mínima; diferir distros no-Debian/Arch | PRD línea 110; `build-linux.yml` apt |
| libayatana deprecation warning en runtime | Alta (cosmético) | Bajo | Nada (no impide) | Log de arranque del `.deb` (host) |
| `keyring` linux-native requiere keyutils disponible (keyring del kernel); entorno sin keyutils | Media | Medio | Fallo explícito del command, no degradar a texto plano (F2/#106) | `src-tauri/src/secrets.rs` (`keyring::Entry::new`) |
| `connect_map` GTK crash (Rafael) | Desconocida | Medio | Pertenece a F3/#107 | Comentario de Rafael en #105 |
| `startDragging()` nativo vs layer-shell (Rafael) | Desconocida | Medio | Decisión de F3/#107 | Comentario de Rafael en #105 |
| No hay gate de CI Linux para PRs | Alta (confirmado) | Medio (regresiones Linux pasan desapercibidas) | Usar tag `v*`/`workflow_dispatch`; fix en #108 | `ci.yml` vs `build-linux.yml` |

## 8. Plan de pruebas y regresión Windows (L0d)

- **Linux (gate de release)**: `npm test`, `cargo test --locked`, `npm run
  app:build`, `verify-deb.sh`/`verify-appimage.sh`, y el paso nuevo **`Launch
  AppImage directly`** (FUSE real) deben estar verdes en `build-linux.yml`
  antes de mergear a `main` cualquier cambio Linux.
- **Linux (gate de PR)**: pendiente de #108 — hoy no existe; workaround tag
  manual. **Registrado como límite no verificado.**
- **Windows (regresión)**: `ci.yml` (windows-latest) sigue verde por PR; el
  bundle Windows (`nsis`/`msi`) queda inalterado — los cambios Linux no tocan
  los targets Windows de `tauri.conf.json`.
- **Límites no verificados declarados**: distros fuera del MVP, sesiones sin
  D-Bus, compositores no listados en §6, aarch64, macOS. Ninguno de estos se
  afirma como soportado.

## 9. Desglose L1–L3 (L0d)

| Nivel | Issue | Alcance | Validación |
|---|---|---|---|
| L1 | #106 — sesiones, secretos y login CLI nativos | Rutas Linux, backend de secretos completo (migración keyutils → Secret Service si procede), login CLI con cascade `$TERMINAL → ghostty → kitty → alacritty`, fallback `x-terminal-emulator` | Subset en devcontainer (rutas, paths); secretos reales se validan con sesiones de escritorio reales (§4.3, §5) |
| L2 | #107 — escritorio y widget nativos | Bloque "Compatibilidad" en Ajustes con auto-detección de WM (`WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`, `DESKTOP_SESSION`, `XDG_CURRENT_DESKTOP`); degradaciones always-on-top/click-through/edge-docking; fix tao#1204 (port de `53058fa`) | Smoke en compositores reales (§6) |
| L3 | #108 — empaquetar y documentar un build local verificable | `.deb` + `.AppImage` reproducibles, docs de dependencias por distro, gate CI Linux para PRs | `npm run app:build` + verify en clean container |

## 10. Anexo A — comandos reproducidos

Cada bloque indica en qué máquina se ejecutó y su exit code esperado (medido
en este baseline).

```bash
# --- Build-time deps (solo para contribuir / hacer cargo test) ---
# Host Ubuntu 22.04/26.04:
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
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
| `src-tauri/tauri.conf.json` | Windows-first (`nsis`/`msi`); Linux targets a añadir en #108 | Confirmado: solo `nsis`/`msi` en `bundle.targets` de main |
| `src-tauri/src/lib.rs` `run()` | Arranque sin crash, single-instance, shortcuts, tray | Arranca en host (`.deb` v0.6.6); panic tao#1204 resuelto en `53058fa` (feat) |
| `src-tauri/src/secrets.rs` | `keyring::Entry::new` con `linux-native` (keyutils, `linux-keyutils`) | Comportamiento exacto de keyutils (persistencia, fallo sin keyutils) a verificar en F2/#106 |
| `src-tauri/src/login.rs` | Login CLI con terminal Linux | Cascade `$TERMINAL → ghostty → kitty → alacritty` per Rafael; a verificar en F2/#106 |
| `src-tauri/src/providers/` (11 módulos: anthropic_api, claude, codex, copilot, cursor, gemini, nan, nan_cloud, openai_api, openrouter) | Puro HTTP (reqwest) | Sin dependencia específica de plataforma; portables |
| `src/lib/dock.ts` | Geometría de bordes (píxeles lógicos) | Sin dependencia de plataforma; portables |
| `src/Settings.tsx` | Bloque "Compatibilidad" (F3) | A integrar en #107; hoy no existe en main |

## 12. Referencias

- Issue #105: `https://github.com/egdev6/quorb/issues/105`
- PRD local: `.claude/prds/linux-portability.prd.md` (referencia al working
  tree; el PRD no forma parte de este PR)
- Rama de trabajo: `feat_native_linux` (commits `7627c44`–`b491ae3`)
- Upstream tao: `tauri-apps/tao#1204` (fix del panic CursorIgnoreEvents)
- AppImage FUSE: `https://github.com/AppImage/AppImageKit/wiki/FUSE`
