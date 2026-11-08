# 250-hyprland-window-fit

> Issue: https://github.com/egdev6/quorb/issues/250 — `bug(linux)`; asignación solicitada a `DonatoSilva` (pendiente del mantenedor: sin push ni PR hasta entonces).
> Rama: `fix/250-hyprland-window-fit` (desde `upstream/main` 79ee3cd). Fork: `DonatoSilva/quorb`.
> Alcance: el propuesto en la propia issue. La rama X11 de la colocación no cambia.

## Specs

- S1: "con el minimo de cambios posibles y sin dañar lo de ubunto" — la rama X11 de `widget_placement::place` y `detail_placement::place` y todo entorno que no sea Hyprland (GNOME/Ubuntu, KDE, desconocido) conservan el comportamiento actual: el perfil por defecto no pide ningún ajuste y no hace ninguna llamada nativa nueva.
- S2: "es mas si se puede hacer extendible mejor que si en el fututo se encuentra en otro sistema de gestor sea solo añadir la configuracion para ese sistema y listo" — el ajuste es un perfil por compositor, calculado con una función pura a partir de la detección por entorno de `wm_compat.rs`; soportar otro compositor es añadir una fila y su test.
- S3: "**Wayland nativo:** llamar también en la rama no-X11 de `place()` (tira y detalle) a `set_size_constraints`, que ya existe y usa el ciclo X11 (petición de tamaño + pistas `min == max`). Medido: 61×181 en 69–83 ms. Sin el permiso de resize (`apply_size`), que no aporta."
- S4: "**XWayland:** fijar `set_type_hint(Utility)` en la tira y el detalle antes del primer `show`, para que Hyprland las flote y respete las pistas que el ciclo X11 ya manda. `utility` y no `dialog`: este último también flota, pero toma foco al mapearse."
- S5: "**Documentación:** completar la fila de Hyprland de la matriz de `docs/build-linux.md` con esta evidencia."
- S6: "Pruebas: la función del perfil con ramas reales (Hyprland/GNOME/desconocido; nativo/XWayland), un test que fija que la fila por defecto no emite ninguna llamada nativa nueva, y los efectos a través del doble de `Surface` ya existente. La validación en un Hyprland real se declara como manual en el PR."
- S7: "Fuera de alcance: la posición en Wayland nativo (#180), el borde/blur/redondeo (son del compositor), tocar la configuración del compositor con `hyprctl`, y que el ciclo X11 reporte `PositionRefused` aunque la ventana quede en su sitio (hallazgo aparte)."
- S8: "sus tests no pueden fallar" (el dueño, #241) y "el doble de geometría prefijada no detecta esta omisión" (el dueño, #224) — cada función nueva tiene un test que puede fallar, sin envoltorios sin lógica, y la conversión de píxeles físicos a lógicos se prueba a escala ×2.

## Mecanismo (medido en CachyOS + Hyprland 0.57.0)

- Wayland nativo: la ventana ya está flotante, centrada y de 1270×1026 cuando corre `place()` (el primer `Resized` llega ~36 ms antes del `place-request`); el frontend pide 61×181. La rama no-X11 (`widget_placement.rs`, tras el `if transport == X11`) solo llama a `apply_widget` y devuelve `Unverified`: no manda la petición de tamaño ni las pistas `min == max`. Con `set_size_constraints` antes de `apply_widget` la ventana pasa a 61×181 en 69–83 ms (5/5); `apply_size` da lo mismo.
- XWayland: Hyprland coloca la ventana en mosaico (`floating: false`, 1262×1022) y el ciclo X11 informa `SizeRefused` (2/2). Con `_NET_WM_WINDOW_TYPE_UTILITY` antes del primer `show` queda flotante y de 61×181 (4/4) y no toma foco al mapearse; `dialog` flota pero toma foco.
- La configuración de Hyprland no tiene reglas de ventana: el 1270×1026 es el tamaño que Hyprland le da por defecto.
- El tipo de ventana no tiene efecto en Wayland nativo (1/1) y las pistas de la ruta no-X11 no se usan en X11: cada efecto pertenece a un solo backend.

## Decisiones

- D1: módulo **nuevo** `src-tauri/src/window_fit.rs` (como `detail_placement.rs` en #215): el perfil por compositor y sus decisiones puras viven juntos; `wm_compat.rs` solo exporta (`pub(crate)`) la detección que ya tiene.
- D2: funciones **puras** con lógica propia (perfil por entorno; tamaño de las pistas en píxeles lógicos con la escala) y el efecto como llamada directa a `set_size_constraints` / `set_type_hint`. No hay doble de `Surface` porque la ruta nativa no tiene ciclo ni read-back; la issue mencionaba ese doble y aquí se sustituye por tests de la decisión y de la conversión, que es lo que puede fallar, sin envoltorios sin lógica (#241).
- D3: la bandera de XWayland se evalúa con el transporte real de GDK en el sitio de la llamada (`start_main_ui`) y no tiene test unitario: el efecto se valida a mano en Hyprland.
- D4: la escala del detalle sale de `window.scale_factor()` (la propia ventana, como `UiSurface::request_size`); la de la tira, de `placement.scale`.

## Tasks

- [x] T1 — S1, S2, S3, S8 — Tests en rojo del perfil por entorno y de `hint_size` (con stubs), y la lógica en `src-tauri/src/window_fit.rs` (módulo nuevo; `FitProfile { wayland_size_hints }`). Route: inline. Commit: commit 1.
- [x] T2 — S3 — Cablear `set_size_constraints` en las ramas no-X11 de `widget_placement::place` y `detail_placement::place`, antes de `apply_widget` / `apply`, solo si el perfil lo pide. Route: inline. Commit: commit 1.
- [ ] T3 — S2, S4 — Añadir `x11_float_hint` al perfil (Hyprland la activa) y cablear `set_type_hint(Utility)` en `start_main_ui`, solo con transporte X11. Route: inline. Commit: _pendiente_ (commit 2).
- [ ] T4 — S1, S3, S4 — Validación en Hyprland real: nativo y XWayland con `hyprctl`, más un control con entorno GNOME simulado (debe verse el comportamiento de antes). Route: verify. Commit: —.
- [ ] T5 — S5 — Fila de Hyprland de la matriz de `docs/build-linux.md` y este registro. Route: inline. Commit: _pendiente_ (commit 3).
- [ ] T6 — S6 — `cargo fmt --check`, `cargo test --locked`, `npm test` y `node scripts/i18n-inventory.mjs --check`. Route: verify. Commit: —.

## Riesgo

Risk: item 3 (la rama no-X11 de `place()` la comparten otros compositores de Wayland nativo, entre ellos GNOME; el cambio queda acotado por el perfil y un test fija que GNOME y el entorno desconocido no piden ajustes) e item 6 (el cableado en `place()` y `start_main_ui` no tiene test unitario: se prueban la decisión y la conversión, y el efecto se valida a mano en Hyprland nativo y XWayland).

## Estrategia de entrega

Tres commits: (1) Wayland nativo, con el perfil y sus tests; (2) XWayland, con su bandera y el cableado, aparte porque el cableado de `start_main_ui` no tiene test unitario; (3) la fila de la matriz y este registro. Push solo tras la asignación del mantenedor: `git push -u origin fix/250-hyprland-window-fit` (la rama rastrea `upstream/main`, donde no hay permiso de escritura). No cambia `src/`, así que el inventario i18n no se regenera (se comprueba con `--check`).

## Log

- L1: "No dijo nada pero quiero solucionarlo antes de levantar el issue... quiero que explores el codigo bien y mires como lo solucionaba el issue que era para ubuntu y que mires opciones de como se podria arreglar el problema que encontramos con el minimo de cambios posibles y sin dañar lo de ubunto es mas si se puede hacer extendible mejor que si en el fututo se encuentra en otro sistema de gestor sea solo añadir la configuracion para ese sistema y listo.... recuerda explorar el como se realiza el codigo agends.md y sobre todo lo aprendido del enfoque que el dueño tiene para los test y lo digo por que en el 222 nos paso que no lo supimos hacer y salio otro issue por atacar que era el de los test que luego arreglamos"
- L2: "para mi la solucion esta en mezclar 1 y 2 que opinas por que si y por que no ?" (opción 1: pistas de tamaño en Wayland nativo; opción 2: tipo de ventana `utility` en XWayland).
- L3: "vale entonces creemos la rama para aplicar y medir levantas el servidor con logging (logs) para que puedas medir y tener pruebas vale". Resultado: 16 corridas medidas en Hyprland 0.57.0 (nativo y XWayland); la evidencia vive en la rama de medición `spike/hyprland-window-measure` (sin commit, cambios en un stash) y en la issue.
- L4: "me parece perfecto el issue está bien explicado con el cómo lo pensamos arreglar el por qué las pruebas perfecto ... monta el issue después monta un comentario pidiendo que se lo asignen para poder nosotros hacer la solución ... lo que vas a hacer es mover esta solución la solución la lógica solo la lógica de solución con los test a esa rama y ya o sea porque también tiene que hacer el pool de la de la main del proyecto de la owner porque puede estar desactualizada la que tenemos nosotros sin tener conflictos". Hecho: issue #250 publicada, comentario pidiendo la asignación, `git fetch upstream` (`upstream/main` sigue en 79ee3cd, sin conflictos) y rama nueva sin la instrumentación.
- L5: Validación manual del autor, durante las corridas de medición: con la ventana ajustada a la tira, el detalle se cierra al salir de la tira (comprobado en XWayland; en Wayland nativo se espera lo mismo y no se comprobó a mano).
