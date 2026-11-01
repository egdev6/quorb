# Feature: Widget visible en todos los escritorios virtuales en Linux (#227)

Presencia continua del widget de Quorb en todos los escritorios virtuales (workspaces / Spaces) en Linux bajo X11 y XWayland, equiparando el comportamiento ya existente en macOS (#112) de forma predeterminada y sin opciones adicionales en Ajustes.

## Specs

- **S1 (Paridad de plataforma)**: En `src-tauri/src/lib.rs`, ampliar el gate de `set_visible_on_all_workspaces(true)` para que aplique tanto en `macos` como en `linux`:
  `#[cfg(any(target_os = "macos", target_os = "linux"))]` para las ventanas `WIDGET`, `DETAIL` y `OVERLAY`.
- **S2 (Comportamiento predeterminado)**: Es el comportamiento predeterminado, sin interruptor en Ajustes, igual que en macOS desde #112: "prefiero que sea el comportamiento predeterminado, sin opción en Ajustes, igual que en macOS desde #112. Una tira de estado que desaparece al cambiar de escritorio va contra su propósito."
- **S3 (Actualización de documentación y comentarios de código)**: Actualizar el comentario de `lib.rs:1036-1041` y el mensaje de error de consola para no asumir que en Linux solo se usa always-on-top ni referirse exclusivamente a "Spaces", sino a escritorios virtuales / workspaces.
- **S4 (Verificación empírica en Linux X11)**: Probar manualmente en X11/XWayland comprobando la presencia del átomo `_NET_WM_STATE_STICKY` con `xprop` en las ventanas (`WIDGET`, `DETAIL`, `OVERLAY`) y verificar que al cambiar de escritorio virtual la tira permanece visible.
- **S5 (No regresión de suite)**: La suite de tests unitarios y de frontend (`npm test`) y la verificación de tipos e inventario i18n deben pasar con 0 fallos.

## Tasks

- [ ] T1: Implementar ampliación del gate `#[cfg(any(target_os = "macos", target_os = "linux"))]` y actualizar comentarios y mensaje de error en `src-tauri/src/lib.rs`. (Cubre S1, S2, S3)
- [ ] T2: Compilar y verificar en Linux X11 con `xprop` los átomos `_NET_WM_STATE_STICKY` en las ventanas y registrar evidencia. (Cubre S4)
- [ ] T3: Ejecutar `npm test`, validar inventario i18n y verificar compilación de Rust. (Cubre S5)
- [ ] T4: Preparar commit con formato Conventional Commits y preparar borrador de PR vinculando issue #227 con evidencia empírica. (Cubre S1-S5)

## Log

- L1: Issue #227 abierto por @Rafaeldelinares: `fix(linux): hacer que el widget sea visible en todos los escritorios virtuales (paridad con macOS)`.
- L2: Respuesta de @egdev6 aprobando la dirección:
  "prefiero que sea el comportamiento predeterminado, sin opción en Ajustes, igual que en macOS desde #112. Una tira de estado que desaparece al cambiar de escritorio va contra su propósito. Si más adelante alguien necesita desactivarlo, se puede valorar entonces una opción.
  Para la PR, además de ampliar el gate a Linux:
  - Actualizar el comentario de `lib.rs:1036-1041` y el mensaje de error, que menciona Spaces.
  - Probar manualmente en KDE y GNOME con X11/XWayland: comprobar `_NET_WM_STATE_STICKY` con `xprop` y cambiar de escritorio con el panel transitorio, el panel anclado y el overlay.
  Adelante con la PR cuando quieras. ¡Gracias!"
