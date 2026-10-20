# W0 Wayland evidence — compositor headless en CI

> Recopila el estado del compositor Wayland que Quorb ve al ejecutarse con un
> compositor Wayland real (weston, Mutter y KWin) en el runner `ubuntu-latest`
> de GitHub Actions. El workflow ya ejecuta la matriz weston/Mutter/KWin en CI;
> solo Hyprland queda pendiente (paquete ausente en ubuntu-24.04, requiere
> self-hosted o PPA).

Run reproducible: `gh workflow run w0-wayland.yml --repo sosan/quorb --ref <rama>`
(workflow manual, sin trigger automático).

## F11 — weston headless expone las env vars de Wayland que Quorb detecta

`is_wayland_only_session` (`wm_compat.rs:289`) lista tokens como `"weston"`,
`"hyprland"`, `"sway"`, `"wlroots"`, `"niri"`, `"river"`, `"wayfire"`, `"labwc"`,
`"cosmic"`. La detección principal de Wayland es via `WAYLAND_DISPLAY` (set)
+ `XDG_SESSION_TYPE=wayland` (set), no via el token `XDG_CURRENT_DESKTOP`.

### Iteración 1 — weston `--headless` simple (parcial)

Artefacto `raw/env.txt` del run `39283880394` (2026-10-19, ubuntu-latest):

- `WAYLAND_DISPLAY=wayland-0`
- `XDG_SESSION_TYPE=wayland`
- `XDG_CURRENT_DESKTOP=weston`
- `DESKTOP_SESSION=weston`

**Limitación detectada**: el backend DRM de weston requiere `/dev/dri` que el
runner `ubuntu-latest` no tiene. `weston --headless` arrancó el `seatd`
embedded pero falló el compositor backend (`fatal: failed to create compositor
backend`). El socket `wayland-0` se creó en `$XDG_RUNTIME_DIR` pero no
quedó expuesto (el compositor no corrió de verdad). Las env vars de los 4
items sí se exportaron y se capturaron, pero la evidencia es **de env vars,
no de compositor Wayland corriendo de verdad**.

### Iteración 2 — weston `--use-pixman --backend=headless-backend.so` (completa)

El step 2 del workflow usa:
```bash
weston --use-pixman --backend=headless-backend.so --socket=wayland-0
```
- `--use-pixman`: renderer software (sin EGL/GLES2).
- `--backend=headless-backend.so`: backend que **no requiere DRM/GPU** —
  crea una salida virtual 'headless' (el log lo confirma: `Output 'headless'
  enabled`).
- `--socket=wayland-0`: socket nombrable (Quorb ve el mismo nombre).
- NO se pasa `--headless`: el backend headless-backend ya es headless y weston
  13 rechaza la flag como "unhandled option" (fix de la iteración 2).

Artefacto ampliado del run con `--use-pixman --backend=headless-backend.so`:
- Las 4 env vars anteriores + `XDG_RUNTIME_DIR` + `GDK_BACKEND=wayland`.
- `raw/weston.log`: log del compositor (verifica arranque limpio o error).
- `raw/wayland-info.txt`: salida de `wayland-info` (interfaces disponibles).
- `raw/status.txt`: `kill -0 $WESTON_PID` (alive?) + `ls -la` del socket.

`detect_wm_info_from_env` clasifica esto como Wayland genérico (no
Hyprland / KDE / GNOME específicos, ya que esos tokens no aparecen en el env
capturado). En `surfaces_for` (`wm_compat.rs:215+`) toma la **rama Wayland
genérico** (línea 222+):

- `always_on_top`: `limited` (depende del compositor — `weston` no es Hyprland/KDE/GNOME)
- `click_through`: `limited` (el widget no implementa click-through; solo el overlay
  de efectos lo usa — F2 del PR #128)
- `tray_icon`: `limited` (necesita StatusNotifier/AppIndicator en la barra)
- `global_shortcuts`: `limited` (necesita portal — weston en headless no lo expone)
- `autostart`: `ok` (XDG session, la barra lo permite)
- `notifications`: `ok` (org.freedesktop.Notifications)
- `transparency`: `ok` (el compositor aplica transparencia)

Sin compilación de la app en CI (toolchain Tauri requiere GTK/webkit2gtk),
los tests de unidad en el workflow existente `w0-evidence.yml` validan la
clasificación de la sesión. La evidencia del Wayland headless es la captura
del env + el head del compositor (artefacto `raw/env.txt` + `raw/weston.log`).

## Matriz Wayland — resultados reales

Runs: `39333298554` (2026-10-19, iter 1: weston OK, Mutter/KWin fallos) y
`39339723250` (2026-10-19, iter 2 con fixes: Mutter y KWin ahora OK).

> **Verificación de los runs**: ambos ID pertenecen al fork `sosan/quorb`
> (donde se iteró el workflow antes del PR). Desde `egdev6/quorb` la URL
> `actions/runs/<id>` devuelve 404: hay que consultarlos en
> `github.com/sosan/quorb/actions/runs/39339723250` (y `.../39333298554`),
> o re-ejecutarlos con `gh workflow run w0-wayland.yml --repo sosan/quorb`.

| Compositor | Estado CI | Detalle |
|---|---|---|
| Wayland genérico (weston + pixman + headless-backend) | ✅ **VALIDADO** | `Using Pixman renderer`, `Output 'headless' enabled`, `weston-keyboard` + `weston-desktop-shell` lanzados; socket `srwxr-xr-x /run/user/1001/wayland-0`. Env: wayland-0, wayland, weston, weston. |
| Mutter (GNOME Wayland) | ✅ **VALIDADO** (iter 2, fix D-Bus) | `apt install mutter gnome-session-bin dbus-x11` ✅ (44 pkgs). `dbus-run-session -- bash -c "exec mutter --headless --wayland > raw-gnome/mutter.log 2>&1" &` (dbus-run-session en background mantiene el session bus al hacer exec de mutter). Crea socket `wayland-0` en `/tmp/runtime-gnome/`. Env capturado: `WAYLAND_DISPLAY=wayland-0`, `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=GNOME`, `DESKTOP_SESSION=gnome`. Artifact `w0-mutter-gnome-evidence`. |
| KWin (KDE Wayland) | ✅ **VALIDADO** (iter 2, fix flags) | `apt install kwin-wayland kwin-x11 dbus-x11` ✅ (181 pkgs). `kwin_wayland --virtual --no-lockscreen` (sin `--headless`, que no existe en 5.27). OpenGL via llvmpipe (Mesa 25.2.8) OK; `kwin_core: Parse error in tiles configuration ... Creating default setup` es solo warning. Crea socket `wayland-0` en `/tmp/runtime-kde/`. Env: `WAYLAND_DISPLAY=wayland-0`, `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=KDE`, `DESKTOP_SESSION=plasma`. Artifact `w0-kwin-kde-evidence`. |
| Hyprland | ❌ **PAQUETE AUSENTE** | `apt install hyprland` → `E: Unable to locate package hyprland` (no está en ubuntu-24.04 universe). Queda self-hosted o PPA. |

El único pendiente restante es **Hyprland** (paquete ausente en ubuntu-24.04;
requiere self-hosted o PPA). Weston, Mutter y KWin quedan validados en CI.
Las filas anteriores ya reflejan los 3 ✅ de la iteración 2 (run `39339723250`).

> **Simulación de env GNOME/KDE**: dentro de cada job, `XDG_CURRENT_DESKTOP` y
> `DESKTOP_SESSION` (GNOME/gnome, KDE/plasma) se fijan manualmente vía
> `$GITHUB_ENV` para reproducir el env que Quorb leería en una sesión real.
> El compositor headless no los emite por sí mismo; lo que sí emite y captura
> el job es el socket Wayland real y `WAYLAND_DISPLAY`/`XDG_SESSION_TYPE`
> derivados de él (evidencia del compositor corriendo de verdad).

## Verificación

- `gh workflow run w0-wayland.yml --repo sosan/quorb --ref <rama>` → tarda ~5 min.
- Artefacto: `w0-wayland-evidence.zip` con `raw/env.txt` (~200 bytes en
  iteración 2) + `raw/weston.log` + `raw/wayland-info.txt` + `raw/status.txt`.
- PR a `egdev6/quorb:main` con este doc + el workflow.
- Comentario en la issue #107 enlazando al PR con la evidencia de la matriz
  (weston/Mutter/KWin ✅ en CI) y declarando solo Hyprland como pendiente
  self-hosted/PPA.

## Lo que NO se hace

- No se ejecuta el binario de Quorb (necesita toolchain Tauri; los tests
  de unidad de `wm_compat` cubren la clasificación de la sesión).
- No se ejecuta Hyprland en CI (paquete ausente en ubuntu-24.04; requiere
  self-hosted o PPA).
- No se reabre el loop `#107` — solo se cuelga el PR con la evidencia
  parcial cuando esté listo.
- No se modifica código de la app ni workflows existentes.