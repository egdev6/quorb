# Feature: El diagnóstico de Linux no presenta como válido lo que no está comprobado (#290)

El diagnóstico de escritorio (`src-tauri/src/wm_compat.rs`) recomienda «Auto-hide» también en Wayland nativo, donde no resuelve, y marca el arranque automático como `ok` en todos los compositores sin verificación. Es lo único que bloquea el criterio 3 de #107: "los fallos no se presentan como activación exitosa".

## Specs

- **S1 (Consejo de «Auto-hide»)**: issue #290: "Ofrecer el consejo de «Auto-hide» solo cuando el posicionamiento es `ok` (X11/XWayland), o reformularlo para que diga hasta dónde llega en Wayland nativo." Criterio: "En Wayland nativo el diagnóstico no recomienda «Auto-hide» como solución, o explica su alcance real." Ubicaciones citadas por la issue en `main` (`f8bc9aa`): `wm_compat.rs:395`, `:407`, `:435`, `:712` y `:725`.
- **S2 (Arranque automático)**: issue #290: "Para el arranque automático, una de dos: verificarlo en al menos una sesión real y dejar la evidencia, o marcarlo como `limited` / no verificado con una nota clara." Criterio: "El arranque automático no figura como `ok` sin evidencia; su estado coincide con lo medido y queda en la matriz §6." Ubicaciones: `wm_compat.rs:387`, `:399`, `:414`, `:426`, `:439`.
- **S3 (Tests)**: criterio: "Tests deterministas del estado por compositor (por la función pública del diagnóstico), incluido que X11/XWayland conserva el consejo cuando aplica."
- **S4 (Matriz)**: issue #290: "En ambos casos, sumar la columna correspondiente a la matriz de `docs/build-linux.md` §6."
- **S5 (i18n)**: criterio: "Textos nuevos en los catálogos/inventario i18n que correspondan."

## Tasks

- T1 | S1, S3 | worker, test-first | consejo de «Auto-hide» solo donde el posicionamiento es `ok`; tests por la función pública | commit: f8b9f93
- T2 | S2, S3, S4 | worker, test-first | arranque automático `limited` con nota según lo medido; columna en la matriz §6 | commit: f8b9f93
- T3 | S5 | inline | regenerar `docs/i18n-inventory.md` después de los commits de código (`node scripts/i18n-inventory.mjs`) | commit: el `docs(i18n)` que sigue a f8b9f93
- T4 | S1-S5 | inline | suite completa, revalidar alcance y `main`, borrador de PR con evidencia; abrirla requiere OK de Rafael | PR: pendiente

## Log

- L1: Rafael (2026-11-17), sobre el plan propuesto (medir el arranque automático, ofrecerse en #290 con tacto, implementar solo tras ver la asignación): "pues vayamos a por ello, y siempre aportando evidencias".
- L2: egdev6 asigna #290 a @Rafaeldelinares (2026-11-17T13:29:48Z): "Te la asigno sin problema @Rafaeldelinares . Ahí te va!"
- L3: Medición publicada en #290 (issuecomment-6948126726). Entorno: CachyOS (kernel 7.2.4), KDE Plasma 6.7.5 en sesión Wayland; `tauri-plugin-autostart` 2.7.0 y `auto-launch` 0.6.0. El plugin escribe `~/.config/autostart/Quorb.desktop` con `Exec=<ruta>` sin comillas, sin argumentos y sin variables de entorno. Plasma lo ejecuta mediante `systemd-xdg-autostart-generator` (`app-Quorb@autostart.service`). Emulación con `systemctl --user start` (AppImage 0.8.0): arranca con `WAYLAND_DISPLAY=wayland-0` y sin `GDK_BACKEND`; KWin lo lista con clase `quorb` (Wayland nativo) y geometría por defecto. Con una ruta con espacios, el generador no crea la unidad y nada lo avisa. Sin verificar: un inicio de sesión real, la tira a simple vista, GNOME y Plasma X11.
- L4: Decisión de implementación: S1 se resuelve con la primera opción de la issue (el consejo solo aparece cuando el posicionamiento es `ok`); S2 con la segunda (`limited` con nota), porque no hay un inicio de sesión real medido y la emulación muestra que en una sesión Wayland arranca en Wayland nativo aunque se use Quorb con `GDK_BACKEND=x11`.
