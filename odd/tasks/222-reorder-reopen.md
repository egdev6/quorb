# 222-reorder-reopen

> Issue: https://github.com/egdev6/quorb/issues/222 — `bug(linux)`, asignada a `DonatoSilva`.
> Rama: `fix/222-reorder-reopens-detail-panel` (desde `upstream/main` f7b614a). Fork: `DonatoSilva/quorb`.
> Decisión de producto del mantenedor: opción 1 de la issue, confirmada en su comentario del hilo.

## Specs

- S1: "Al arrastrar un orbe para reordenarlo y soltarlo, el panel de detalle **se vuelve a abrir solo** y queda abierto bajo el puntero, sin que nadie haya hecho clic."
- S2: "2. Pasa el mouse por un orbe (se abre el panel de detalle). 3. Arrastra un orbe para reordenarlo y suéltalo. 4. El panel se reabre solo, sin clic."
- S3: "**400 ms no cubren el ritmo de una persona**: el puntero está quieto sobre el orbe más de 400 ms y, en cuanto el ratón se mueve (o al pasar el tiempo suficiente), el hover vuelve a abrir el panel."
- S4: "**Un reordenado descarta el panel hasta que el puntero salga de la tira y vuelva** (en vez de una ventana de 400 ms). Es la regla que ya usa el anclaje: el puntero no cambia por debajo lo que se decidió con un clic."
- S5: "Como propuesta, prefiero la opción 1: bloquear la reapertura automática tras reordenar hasta salir de la tira y volver a entrar, conservando el clic explícito y el foco de teclado. Aumentar el timeout no resolvería la regla de interacción." (mantenedor)
- S6: "Antes de implementar, convendría registrar la secuencia de `pointerup`, liberación de captura, `mouseenter`, foco, clic y ejecución del temporizador de apertura para identificar el disparador y fijarlo con un test." (mantenedor)
- S7: "el código es compartido: por ahora está observado en Linux, pero no demostrado como exclusivo de Linux." (mantenedor)
- S8: "**Sí, salir de la tira es salir de la ventana completa**, con el mismo `mouseleave` de `.dock` que ya cierra el panel. Una sola señal para cerrar y para liberar el bloqueo." (mantenedor)
- S9: "**No, pasar a otro orbe no debe liberarlo.** El reordenado coloca el orbe por índice y no lo hace seguir al puntero, así que al soltar el puntero puede quedar sobre el orbe vecino. Esa entrada diferida reproduciría el bug en otro orbe. Para abrir otro orbe sigue disponible el clic." (mantenedor)
- S10: "**No pongas la guarda en `openFor`.** `onHover` es el mismo callback para `mouseenter`, foco y clic (`ProviderGauge.tsx:105-113`), así que una bandera ahí también bloquearía el foco de teclado, que debe conservarse. Bloquea solo la vía del puntero, o pasa a `openFor` el origen del evento." (mantenedor)
- S11: "**Confirma que el disparador es `mouseenter` y no `focus`.** [...] Registra los dos eventos por separado; si el disparador fuera el foco, la bandera no lo frenaría y el test fijaría la causa equivocada." (mantenedor)
- S12: "**Soltar fuera de la tira.** Con la captura del puntero se puede soltar fuera de `.dock`. Si su `mouseleave` ya ocurrió, nada vuelve a poner la bandera en `false` y el siguiente hover legítimo queda bloqueado. Actívala solo si el puntero está dentro de la tira al soltar, y cubre ese caso en el test." (mantenedor)
- S13: "Adelante con la opción 1, la regla en una función pura y su test." (mantenedor)

## Mecanismo (hipótesis, sin confirmar hasta T1)

Disparadores posibles, ordenados por probabilidad (exploración de solo lectura):

1. `mouseenter` sobre el orbe que queda bajo el puntero al liberar la captura. En `onPointerUp`, `releasePointerCapture` corre **antes** de fijar `lastReorderAt` (`src/Widget.tsx:1199`), y el temporizador `go` de `openFor` (~858-872) **no** vuelve a comprobar la guarda.
2. `patchConfig` no es optimista (`src/Widget.tsx:318-322`): el orden vuelve al previo hasta que responde el IPC y el navegador re-dispara `enter` en el siguiente movimiento, ya fuera de los 400 ms.
3. `onFocus` abre en todo lo que no sea Windows (`src/components/ProviderGauge.tsx:106-112`). Probabilidad baja.

Ni Rust ni la presencia nativa (`detail-presence.ts`) abren el panel: la decisión es solo de TS.

### Diseño propuesto

- `PanelState` se queda en dos campos (`click-anchor-panel.md`, T1/L7). La retención va aparte: un valor puro `ReorderHold` junto a `isReorderGesture` en `src/lib/anchor-panel.ts` (`afterRelease`, `afterStripLeave`, `canHoverOpen`).
- La compuerta vive en `openFor` (entrada **y** dentro de `go`), no en la prop `onHover` de `ProviderGauge`, que sirve a ratón y foco a la vez.
- La retención se fija antes de `releasePointerCapture`. `clickPanel`, `closePanel` y el foco no cambian.
- Se reinicia al ocultar o cerrar el widget (`widgetHidden`, `dismiss`, `hide`).
- Abierto: qué elemento marca «salir de la tira» (`.dock` incluye el botón peek; `.strip` no tiene handlers).

## Tasks

- [x] T1 — S6 — Registrar con marcas de tiempo `pointerup`, liberación de captura, `mouseenter`, foco, clic y ejecución del temporizador, en Wayland nativo y XWayland (CachyOS + Hyprland); identificar el disparador. La instrumentación es temporal y no se commitea; la evidencia va al Log. Route: inline. Commit: —
- [x] T2 — S3, S6, S12, S13 — Test en rojo (incluye soltar fuera de la tira) que fije el disparador identificado (`src/lib/anchor-panel.test.ts`, estilo del bloque «the reorder guard»). Route: inline. Commit: —
- [x] T3 — S4, S5, S9, S12, S13 — `ReorderHold` puro en `src/lib/anchor-panel.ts` con su test. Route: inline. Commit: —
- [x] T4 — S4, S5, S8, S9, S10, S12 — Cableado: bloquea solo la vía del puntero (prop opcional `onPointerEnter` en `ProviderGauge`, mismo patrón que `onClick ?? onHover`), la bandera se activa solo si el puntero está dentro de la ventana al soltar, se libera con el `mouseleave` de `.dock` y se reinicia al ocultar el widget; foco y clic no cambian. Route: apply. Commit: —
- [x] T5 — S5, S7 — Verificación diferencial del comportamiento previo (clic ancla, foco abre, `Escape` cierra, tests de foco de `ProviderGauge.test.tsx`) contra una copia de la base en un `mktemp -d`; no se commitea. Route: verify. Commit: —
- [x] T6 — S1, S2 — `npm test`, `npm run typecheck`, inventario i18n si cambia texto, y prueba en la app real en los dos backends; evidencia en la PR. Route: verify. Commit: —
- [ ] T7 — Un commit Conventional (`fix(widget): ... (#222)`) y, aparte, push desde el fork y PR. Push y PR son decisión del usuario. Route: inline. Commit: —

## Riesgo

Risk: item 3 (código compartido con el anclaje de #170/#223: `openFor`, `onHover` y `isReorderGesture` los usan otros comportamientos que la issue no menciona).

## Estrategia de entrega

Un solo commit de comportamiento con sus tests. Primer push: `git push -u origin fix/222-reorder-reopens-detail-panel`, porque la rama hoy rastrea `upstream/main`, donde no hay permiso de escritura.

## Estado al cierre de la sesión (2026-11-05)

- T1 cerrado con evidencia (L10, L11). T2 a T7 **sin empezar**, por decisión del usuario.
- **Nada publicado en GitHub**: ni comentarios, ni issues, ni PR. Hay tres borradores de comentario para el hilo de #222 (corto, medio, detallado) sin publicar. El usuario consultó al mantenedor (Discord) si conviene publicarlo en el hilo o si basta con el aviso verbal; se espera su respuesta.
- Antes de publicar: confirmar que la primera pasada de mediciones fue en Wayland nativo (el log no lo registra) y decidir si se le pregunta al mantenedor si soltar la retención al pasar a otro orbe.
- **El árbol de trabajo tiene la instrumentación temporal aplicada** en `src/Widget.tsx`, `src/components/ProviderGauge.tsx` y `src-tauri/tauri.conf.json` (CSP). Revertir antes de T2 con `git checkout -- src/Widget.tsx src/components/ProviderGauge.tsx src-tauri/tauri.conf.json`. Copia del parche: `/tmp/quorb-t1/instrumentation.patch`. Evidencia: `/tmp/quorb-t1/t1-evidence-2026-11-05.log` (el receptor `/tmp/quorb-t1/server.mjs` trunca el log al arrancar).
- Primer push: `git push -u origin fix/222-reorder-reopens-detail-panel` (la rama rastrea `upstream/main`).

## Hallazgos fuera de alcance (sin reportar)

Observados en CachyOS + Hyprland 0.57.0. El mantenedor conoce verbalmente el primero y el segundo; ninguno está en GitHub.

1. **Ventana demasiado grande (Wayland nativo):** `hyprctl` la mide en 1270x1026, flotante; Hyprland le dibuja borde, redondeo y blur, y se ve una «caja» translúcida bajo la tira y ~10 px alrededor del detalle. Parecido a #215/#224 (solo X11, GNOME) y #180.
2. **Mosaico (XWayland):** Hyprland tila la tira al arrancar (media pantalla). Con Super+clic pasa a flotante y toma su forma; el asa de mover de la propia tira también la deja bien.
3. **Detalle recortado y sin scroll:** la tarjeta de MiniMax queda cortada y no se puede desplazar (`DetailPanel.tsx:196`, `overflow: hidden`); en Wayland nativo no hay lectura del tamaño real (`widget_placement.rs:528-541`).
4. **El detalle se queda abierto al salir de la tira sin hacer clic** (nativo y XWayland): `.dock` es `inset: 0`, es el único elemento con `mouseleave` y la ventana es mayor que la tira; en Linux no hay respaldo de presencia nativa (`detail-presence.ts`).
5. **Anclado indistinguible de hover:** un clic sin arrastre ancla el panel y se ve igual que el hover. `click-anchor-panel.md` S9/L6 dicen que la salida «queda documentada en el código» y no se encontró esa documentación.
6. **Pulsar un orbe reabre un instante el panel:** `pointerdown` enfoca el orbe, `onFocus` llama a `openFor` y el panel vuelve a abrirse hasta `drag-start`.
7. **Temporizador de apertura (350 ms) sobrevive a salir del orbe** mientras el puntero sigue en `.dock`: puede abrirse el panel de un orbe ya abandonado.
8. **`createPanelCoordinator` existe y no se usa** (`Widget.tsx` tiene sus propios temporizadores): dos caminos que pueden divergir.
9. **Ruido del entorno, preexistente:** 11 warnings de Rust (`dead_code`, `unused_mut`), un `Gtk-CRITICAL gtk_widget_get_scale_factor` al arrancar y 2 vulnerabilidades moderadas de `npm audit`. No usar `npm audit fix --force`.
10. **No es un bug:** MiniMax viene deshabilitado por defecto y requiere API key (se habilita en Ajustes).

## Log

- L1: vale ataquemos el issue 222 que me acaban de asignar... primero quiero que explores el pproyecto guardes en engram los decubrimientos y luego quiero que por favor me expliques como lo podemos solucionar... darme una breve descripcion de lo que buscamos y que se debe entrgar y por que... pero todavia sin tocar nada solo es exploracion, analisis y comprension de lo que hay respecto al issue y que solucionamos con el issue
- L2: Exploración de solo lectura con `path:line` en «Mecanismo». El disparador real sigue **sin confirmar** hasta T1: el orden de eventos al liberar la captura difiere entre WebKitGTK, WebView2 y WKWebView. Nota: `createPanelCoordinator` existe pero `Widget.tsx` no lo usa (temporizadores propios); no se unifica en esta issue.
- L3: Fork `DonatoSilva/quorb` creado (`gh repo fork --remote --default-branch-only`). Remotos: `origin` = fork (SSH), `upstream` = `egdev6/quorb`. Rama creada desde `upstream/main` (f7b614a).
- L4: Entorno de medición: CachyOS + Hyprland, Wayland nativo y XWayland. La rama de `docs/build-linux.md` §6 «CachyOS / Omarchy Hyprland» figura como pendiente de contribuidor.
- L5: El repo no tiene entorno de DOM en vitest (según L18 de `click-anchor-panel.md`; sin verificar en la configuración actual): la cobertura determinista vive en funciones puras y el cableado se acredita con prueba manual.
- L6: Línea base verde antes de tocar código (rama sobre `upstream/main` f7b614a): `npm ci` (106 paquetes; `npm audit` avisa de 2 vulnerabilidades moderadas preexistentes, fuera del alcance), `npm test` = 68 archivos / 904 tests de vitest + 298 tests de `node --test`, todos en verde, y `npm run typecheck` sin errores.
- L7: Hallazgo aparte, fuera de alcance de #222 y sin reportar: en Hyprland 0.57.0 la ventana `quorb` mide 1270x1026 (flotante, Wayland nativo) y el compositor le dibuja borde, redondeo y blur, así que se ve una «caja» translúcida bajo la tira y ~10 px alrededor del detalle. Guardado en Engram como `quorb/hyprland-oversized-window`.
- L8: Dos comportamientos observados por el usuario en CachyOS + Hyprland, analizados en solo lectura (Engram `quorb/hover-panel-behaviors`), sin issue previo que los cubra: (B1) tras reordenar, moverse sobre el mismo orbe no reabre el detalle: es el comportamiento objetivo (S4), el hover solo abre con `mouseenter`/foco (`Widget.tsx:858`, `ProviderGauge.tsx:105-113`); (B2) el detalle a veces se queda abierto al salir de la tira: `.dock` es `inset:0` y es el único elemento con `mouseleave` (`styles.css:51`, `Widget.tsx:1232`), y la ventana nativa es mayor que la tira, así que el margen transparente sostiene el panel; un clic accidental también lo ancla (`anchorOn`, `Widget.tsx:874`). Hipótesis, sin observar en WebKitGTK.
- L9: Corrección de la hipótesis 1 del Mecanismo: `releasePointerCapture` (`Widget.tsx:1195`) y `lastReorderAt` (`:1199`) corren en el mismo `onPointerUp` síncrono, así que no hay carrera entre ellos, y que `go` no re-compruebe la guarda es inocuo (solo se agenda tras pasar la comprobación de entrada). El disparador real de #222 sigue sin confirmar hasta T1; revisar T4 ("antes de `releasePointerCapture`", "dentro de `go`") tras medir.
- L10: T1, primera medición (Hyprland, una sola pasada de escenarios; backend por confirmar, falta medir el otro). **Disparador identificado**: tras cada reordenamiento (2 de 2) el navegador sintetiza un `mouseenter` sobre `.dock` y el orbe soltado a ~204-205 ms de `pointerup`, **sin ningún movimiento del ratón** entre medias (0 eventos `move` entre `pointerup` y el `mouseenter`). Ese `openFor` lo frena la guarda: `openFor-blocked reorderGuard ms=204`. Es decir, el reabrir exige que ese `mouseenter` sintetizado llegue pasados 400 ms; aquí llega a ~205 ms y no abre. `patchConfig` tardó 4 ms, así que la hipótesis 2 queda descartada en esta máquina. Dato extra: el `pointerdown` sobre un orbe dispara `orb-focus` -> `openFor` -> `go-run delay=0`, o sea que con el panel abierto el simple pulsar lo reabre un instante antes de que `drag-start` lo cierre (hipótesis 3 confirmada como real, transitoria). Log: `/tmp/quorb-t1/t1.log` (efímero).
- L11: T1 cerrado con la segunda medición (XWayland, `GDK_BACKEND=x11`): **el bug se reproduce** (2 de 4 reordenamientos en XWayland; la primera pasada tuvo 2 más, ambos frenados por la guarda). Tras soltar, el `mouseenter` sobre el orbe soltado llega en un instante impredecible: a ~202-205 ms (4 de los 6 reordenamientos en total, frenado por la guarda: `openFor-blocked reorderGuard`) o con el primer movimiento del ratón, a +999 ms y +2337 ms (2 casos, ambos en XWayland, sin guarda activa: `openFor-schedule delay=350` -> `go-run` -> `panel {providerId}` abierto, sin clic). En 3 de los 4 reordenamientos de XWayland `pointercapture-lost` ocurrió a mitad del arrastre (-376 a -1786 ms) con su `mouseenter` bloqueado por `orbDrag.moved`; además `dock-mouseenter` se dispara sin `dock-mouseleave` previo, así que **no sirve como señal de «volvió a entrar»**. Conclusión: ninguna ventana de tiempo acota ese evento, lo que respalda la regla del mantenedor (S4). Copia de la instrumentación: `/tmp/quorb-t1/instrumentation.patch` (revertir con `git checkout` antes de T2; nunca se commitea).
- L12: Cierre de sesión 2026-11-05: ver «Estado al cierre» y «Hallazgos fuera de alcance». Corrección: la medición tiene 6 reordenamientos (2 de la primera pasada, 4 en XWayland), no 5.
- L13: Comentario publicado en #222 por el usuario (opción B ajustada, sin la frase de Wayland nativo y sin «o te quedas con la regla literal»), con OK explícito y tras indicarlo el mantenedor: https://github.com/egdev6/quorb/issues/222#issuecomment-6668222910 (autor DonatoSilva, 2026-11-05). Incluye el cómo (bandera `useRef`, liberada por `mouseleave` de `.dock`) y dos preguntas al mantenedor: salir de la tira = salir de la ventana completa; ¿pasar a otro orbe libera el bloqueo? Se espera respuesta antes de T2.
- L14: Respuesta del mantenedor a nuestro comentario (2026-11-05T20:20:01Z), literal:

  > @DonatoSilva, buena medición. El mecanismo cierra con el código: el orbe se mueve bajo un puntero quieto y la entrada llega con el siguiente movimiento, cuando sea. Por eso ninguna ventana de tiempo lo resuelve. Adelante con la opción 1, la regla en una función pura y su test.
  >
  > Tus preguntas:
  >
  > 1. **Sí, salir de la tira es salir de la ventana completa**, con el mismo `mouseleave` de `.dock` que ya cierra el panel. Una sola señal para cerrar y para liberar el bloqueo.
  > 2. **No, pasar a otro orbe no debe liberarlo.** El reordenado coloca el orbe por índice y no lo hace seguir al puntero, así que al soltar el puntero puede quedar sobre el orbe vecino. Esa entrada diferida reproduciría el bug en otro orbe. Para abrir otro orbe sigue disponible el clic.
  >
  > Tres puntos antes de implementar:
  >
  > 1. **No pongas la guarda en `openFor`.** `onHover` es el mismo callback para `mouseenter`, foco y clic (`ProviderGauge.tsx:105-113`), así que una bandera ahí también bloquearía el foco de teclado, que debe conservarse. Bloquea solo la vía del puntero, o pasa a `openFor` el origen del evento.
  > 2. **Confirma que el disparador es `mouseenter` y no `focus`.** En Linux, `onFocus` llama a `onHover` sin filtrar por `:focus-visible` (ese filtro solo aplica en Windows). Además, `pointerdown` sobre el `<button>` le da foco y React mueve el nodo al reordenar. Registra los dos eventos por separado; si el disparador fuera el foco, la bandera no lo frenaría y el test fijaría la causa equivocada.
  > 3. **Soltar fuera de la tira.** Con la captura del puntero se puede soltar fuera de `.dock`. Si su `mouseleave` ya ocurrió, nada vuelve a poner la bandera en `false` y el siguiente hover legítimo queda bloqueado. Actívala solo si el puntero está dentro de la tira al soltar, y cubre ese caso en el test.

- L15: Punto 2 del mantenedor comprobado con el log de XWayland: en los dos reordenamientos que reabrieron el panel (+999 y +2337 ms) la cadena fue `orb-mouseenter` -> `openFor-enter` -> `openFor-schedule` -> `go-run` -> `panel`, **sin ningún `orb-focus`** entre soltar y abrir; `orb-focus` solo aparece en el `pointerdown`. El disparador es `mouseenter`.
- L16: Instrumentación temporal revertida con `git checkout` (3 archivos). Se implementa T2-T4 siguiendo S8-S13.
- L17: T2-T4 hechos (delegados al worker con este documento como especificación y revisados por el padre). RED observado: `anchor-panel.test.ts` 6 fallos (`holdAfterReorderDrop is not a function`) y `ProviderGauge.test.tsx` 1 fallo (`onPointerEnter` nunca llamado). GREEN: `npm test` = vitest 68 archivos / 912 tests (+8 sobre la base de 904) y `node --test` 298; `npm run typecheck` limpio. Diff: 5 archivos, +153 -3. Diseño: `ReorderHold` puro en `anchor-panel.ts`; bandera `useRef` en `Widget.tsx` fijada en `onPointerUp` solo si el puntero está dentro de la ventana (coordenadas, no `insideRef`), liberada en el `mouseleave` de `.dock`, reiniciada en `widget-hidden`; prop opcional `onPointerEnter` en `ProviderGauge` (solo `mouseenter`, foco y clic siguen por `onHover`, S10). `openFor`, `anchorOn`, `clickPanel` y la guarda de 400 ms sin cambios.
- L18: T5 verificación diferencial: sonda (no se commitea) sobre una copia de `HEAD` y otra del árbol modificado, `mouseenter`/foco/clic sin `onPointerEnter` en 3 sistemas x `:focus-visible` x con/sin `onClick`, más el HTML renderizado: salida **idéntica** (4623 bytes en ambos). Pendiente T6: el cableado de `Widget.tsx` no tiene test unitario (sin entorno de DOM), se acredita con la prueba en la app real en XWayland.
- L19: T6 verificado el 2026-11-05: `npm run build` (exit 0), `npm test` (vitest 68 archivos / 912 tests; `node --test` 298, 0 fallos) y `npm run typecheck` (exit 0). Prueba manual del usuario en la app real (XWayland, CachyOS + Hyprland 0.57.0): con el cambio el panel ya no se reabre solo tras reordenar. **No se probó** el resto de la lista manual punto por punto (soltar fuera de la ventana, teclado, ocultar/mostrar) ni Wayland nativo; el cableado de `Widget.tsx` no tiene test unitario. T7: commit del fix con el ODD y, aparte, el inventario i18n regenerado; push y PR son decisión del usuario.
