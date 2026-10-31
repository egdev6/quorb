# click-anchor-panel

> Issue: https://github.com/egdev6/quorb/issues/170 — `type:feat`, `status:approved`.
> Assignee: `Rafaeldelinares` (asignada por el mantenedor el 29-10-2026).
> Decisión de producto del mantenedor: https://github.com/egdev6/quorb/issues/170#issuecomment-6507787551 (respuesta) y el comentario del 22-10 en el mismo hilo.
> Plan v4 publicado: https://github.com/egdev6/quorb/issues/170#issuecomment-6509849630.
> Plan v5 (los cuatro puntos pedidos por el mantenedor): https://github.com/egdev6/quorb/issues/170#issuecomment-6531012837.

## Specs

- S1: "**Clic = anclar / desanclar**, no abrir" (decisión del mantenedor).
- S2: "**Hover** → abre transitorio, como hoy: se cierra al salir (`mouseleave` + temporizador). Sin cambios."
- S3: "**Clic sobre el orbe** → **ancla** el panel: deja de cerrarse al mover el cursor fuera, hasta segundo clic sobre el mismo orbe o clic fuera del panel."
- S4: "**Clic sobre otro orbe con panel anclado** → cambia de provider manteniendo el anclaje."
- S5: "**Clic sobre el orbe ya anclado** → desancla y cierra."
- S6: Casos de uso que esto habilita y el hover no cubre: copiar un dato del panel, cambiar de provider varias veces sin perseguir el cursor, y acceso por teclado/touch de forma natural.
- S7: "El retardo de apertura queda fuera de esta issue: 350 ms en Linux se queda como está, y los presets de sensibilidad del hover irán por separado." (decisión del mantenedor)
- S8: "El clic tiene que respetar el umbral de arrastre de los orbes que ya existe (`orbDrag.moved`), para que reordenar no ancle el panel por accidente. Los tests deberían cubrir ese caso."
- S9: "Si no hay una señal nativa (pérdida de foco u otra equivalente) por plataforma, el panel anclado puede quedarse abierto de forma indefinida. Me vale una respuesta por plataforma, aunque en alguna la única salida sea el segundo clic sobre el orbe, siempre que quede documentada en la código."
- S10 (punto 1 del mantenedor): "**Windows y macOS.** La tabla solo cubre X11, XWayland y Wayland nativo, y la pregunta era por plataforma. Explicad cómo se comporta la pérdida de foco en Windows y en macOS al hacer clic en otra aplicación, teniendo en cuenta que en macOS WebKit ya obligó a muestrear la presencia nativa (#154). Si en alguna plataforma la única salida es el segundo clic, documentadlo igual."
- S11 (punto 2 del mantenedor): "**Clic dentro del panel.** La ventana de detalle se puede enfocar: en `src-tauri/src/lib.rs` (constructor de `DETAIL`) solo lleva `.focused(false)`, sin el `.focusable(false)` del overlay. Al hacer clic en el panel para copiar un dato, el foco pasa a esa ventana y la tira recibe `Focused(false)`. Con la regla del plan, el panel anclado se cerraría justo en el caso de uso principal. La condición tiene que ser que el foco salga de **las dos** ventanas propias, la tira y el detalle, y conviene cubrirlo con un test sobre el seam de foco, no solo con la prueba manual."
- S12 (punto 3 del mantenedor): "**Foco y teclado.** El plan dice que la tira conserva el foco «sin quitarle el teclado a la aplicación del usuario», pero que el clic en el orbe dé el foco a la tira es precisamente quitárselo: de eso dependen `Escape` y la señal de pérdida de foco. Me parece un coste aceptable, pero tiene que quedar descrito tal cual, por plataforma. Por ejemplo: «tras anclar, lo que se escribe va a Quorb hasta hacer clic en otra aplicación, y ese clic cierra el panel»."
- S13 (punto 4 del mantenedor): "**`Escape` con el foco en el panel.** Si el usuario hizo clic dentro del panel, el foco está en la ventana de detalle: `Escape` tiene que cerrar el panel anclado también desde ahí, no solo desde la tira."
- S14 (cierre del mantenedor): "Con esos cuatro puntos en el plan, adelante con la implementación."

## Mecanismo

### Un solo estado

El estado del panel dice **qué provider se ve** y **si está anclado**: `PanelState = { providerId, anchored }` (`src/lib/anchor-panel.ts`). Con un solo estado las reglas no pueden discrepar entre sí: el hover, el temporizador de 8 s, el clic y la pérdida de foco compiten por el mismo valor en vez de llevar banderas paralelas.

- `hoverPanel`: el hover abre transitorio. Con el panel **anclado** no hace nada: el anclaje lo eligió un clic y el puntero no lo cambia por debajo.
- `clickPanel`: ancla; sobre el orbe ya anclado, desancla y cierra; sobre otro orbe, cambia de provider **manteniendo** el anclaje.
- `closePanel`: cierra, y el anclaje se va con él.
- `panelHoldsOpen`: mientras esté anclado, ni el hover ni el temporizador lo cierran.

### La señal: el foco de las dos ventanas propias

El anclaje se suelta cuando el foco sale de **las dos** ventanas propias (la tira y el detalle), porque el detalle es focusable (`src-tauri/src/lib.rs`: lleva `.focused(false)` —que es sólo el arranque— y **no** el `.focusable(false)` del overlay) y al hacer clic dentro para copiar un dato el foco pasa a esa ventana.

- El backend reenvía el evento nativo: `WindowEvent::Focused` de las ventanas `widget` y `detail` → `emit_to(WIDGET, "window-focus", (etiqueta, tiene_foco))`. Es un evento de **ventana**, no del DOM: llega igual en X11, Wayland, Windows y macOS, y no depende de que WebKit entregue los eventos de ratón (el problema de #154).
- La decisión **no** se toma en el evento sino después: la pérdida de foco de la ventana antigua llega **antes** que la ganancia de la nueva (X11: `FocusOut`/`FocusIn`; macOS: `windowDidResignKey`/`windowDidBecomeKey`; Windows: `WM_KILLFOCUS`/`WM_SETFOCUS`). `src/lib/anchor-focus.ts` guarda el estado de las dos ventanas y sólo suelta el anclaje si, **150 ms después del último evento de foco**, ninguna de las dos tiene el foco.

### El clic no ancla al reordenar

El umbral de 6 px (`orbDrag.moved`) se consume en `pointerup`, y el clic llega **después**: lo que frena el clic es la guarda de 400 ms tras reordenar (`lastReorderAt`), como regla pura (`isReorderGesture`) con su test.

### `Escape`

- La tira atiende `Escape` (tiene el foco desde el clic que ancló) → cierra el panel.
- El panel atiende `Escape` (el foco está en la ventana de detalle) → avisa a la tira por `detail-escape` → cierra el panel.
- En los dos casos el panel se cierra tanto si estaba anclado como si era transitorio.

## Tasks

- T1 — Estado único (`src/lib/anchor-panel.ts` + test): `PanelState`, `hoverPanel`, `clickPanel`, `closePanel`, `panelHoldsOpen` y la guarda de reordenación. Route: apply.
- T2 — Seam de foco (`src/lib/anchor-focus.ts` + test): el tracker con la ventana de asentamiento de 150 ms, el abandono (`null`) y el aviso una vez por episodio. Route: apply.
- T3 — Backend: reenviar `WindowEvent::Focused` de `widget` y `detail` al frontend. Route: apply.
- T4 — Frontend: el estado único en la tira, las reglas del hover, el clic que ancla, la guarda de reordenación, el listener de foco y el `Escape`. Route: apply.
- T5 — `Escape` en el panel (`src/DetailPanel.tsx` + `detail-escape`). Route: apply.
- T6 — Verificación: `npm test`, `npm run typecheck`, `cargo test --locked`, `cargo fmt --check`, inventario i18n regenerado, prueba manual en KDE/X11 y medición en Wayland nativo; evidencia en la PR. Route: verify.

## Estrategia de entrega

El comportamiento es **un** commit (`feat(widget): el clic sobre el orbe ancla el panel de detalle (#170)`, ~500 líneas con sus tests) y después, aparte, el artefacto y el inventario i18n regenerado. No se parte en commits parciales a propósito: los módulos puros sin cablear no cambian ningún comportamiento (un estado intermedio sin valor, que es lo que objetó la review de #179) y partir el cableado dejaría el anclaje sin su condición de salida. El límite de la rebanada queda aquí: termina en el commit del comportamiento.

## Log

- L1: Spec de #170 y decisión de producto del mantenedor (22-10), citada arriba en S1–S7.
- L2: Respuesta del mantenedor al nuestro mensaje (29-10): "Os asigno la issue. Estoy de acuerdo en dejar el retardo de apertura fuera de esta issue" + la pregunta de S9 y el recordatorio del umbral de S8.
- L3: Hallazgos del código para responder S9: la ventana de la tira es **focusable** (`focus: false` en `tauri.conf.json` es sólo el arranque) ⇒ al hacer clic en un orbe la tira toma el foco; si el usuario hace clic en otra aplicación, la tira **pierde** el foco ⇒ `WindowEvent::Focused(false)` en la ventana `widget` es una señal **nuestra**, sin watch global de la entrada y sin dependencias nuevas.
- L4: **Descartado el `XGrabButton` pasivo** (primera versión del plan): bajo XWayland el servidor X no ve los clics de las aplicaciones nativas, así que el watch global no resolvería el caso de GNOME y además sería un watch global de la entrada mientras el panel está anclado. Queda como posible añadido posterior y sólo para X11 nativo (el clic en un fondo que no toma el foco).
- L5: **Descartado pedir el foco al panel** (segunda versión del plan): robaría el teclado a la aplicación del usuario y, al hacerlo, la tira perdería el foco y el anclaje se desharía solo. La señal elegida es la pérdida de foco de la **tira**.
- L6: **El anclaje no es una trampa**: salidas siempre disponibles = segundo clic sobre el orbe, clic en otra aplicación (la tira pierde el foco) y `Escape` atendido por la tira. **Sin control nuevo en el panel**: el botón de "ocultar provider" es otra cosa y un botón de cerrar sería redundante. Si el compositor no concede el foco a la tira, la única salida es el segundo clic sobre el orbe, y queda documentado en el código.
- L7: **Un solo estado**, no dos banderas: el estado del panel dice qué provider se ve y si está anclado, con reglas explícitas (el hover y el temporizador de 8 s no cierran un panel anclado; la tira no se colapsa mientras está anclado; ocultar el provider o cerrar la app limpian el anclaje).
- L8: Plan v4 publicado en el hilo #170 para revisión del mantenedor (https://github.com/egdev6/quorb/issues/170#issuecomment-6509849630).
- L9: El mantenedor aprueba la dirección del plan v4 pero pide cuatro puntos antes del código (S10–S13): el comportamiento por plataforma en Windows y macOS, el clic dentro del panel (foco propio), el coste de foco y teclado, y `Escape` con el foco en el panel. Cierra con "Con esos cuatro puntos en el plan, adelante con la implementación" (S14).
- L10: **Corrección**: el plan v4 afirmaba que "la tira conserva el foco (no le quitamos el teclado a la aplicación del usuario)". Es falso: el clic en el orbe da el foco a la tira y con él se lleva el teclado. El coste real queda descrito por plataforma en el plan v5 (S12) y corregido en el comentario publicado.
- L11: Verificado en el código para responder S10: `tao 0.37.1` traduce a `Focused(false)` el `focus_out_event` de GTK (Linux), `WM_NCACTIVATE`/`WM_KILLFOCUS` (Windows) y `windowDidResignKey` (macOS). La tira y el detalle son focusable en las tres plataformas (`canBecomeKeyWindow` devuelve el atributo `focusable`; en Linux, `tao` restituye `accept_focus` tras el primer dibujo). El problema de #154 era de eventos DOM de ratón, no de foco: la señal de foco no depende de WebKit.
- L12: Verificado en el código para responder S11: `DETAIL` se construye con `.focused(false)` y **sin** `.focusable(false)` (`src-tauri/src/lib.rs`), así que el detalle es focusable; sólo el overlay lleva `.focusable(false)`. Por eso la regla pasa a ser "el foco debe salir de **las dos** ventanas propias" y la decisión se difiere 150 ms para no reaccionar al orden real de los eventos (pérdida antes que ganancia).
- L13: Verificado para responder S13: hoy no hay ningún `Escape` en `src/` salvo en `Settings.tsx`; tanto la tira como el panel deben atenderlo (T5).
- L14: Notas de implementación del mantenedor en su propuesta (22-10), que seguimos: `ProviderGauge` acepta `onClick` opcional; el anclaje convive con `mouseleave` (el cierre sólo procede si el panel **no** está anclado); el clic se distingue del arrastre por `pointerup` sin movimiento; el anclaje se comporta igual en Linux, macOS y Windows y no depende del `OPEN_DELAY`.
- L15: Premisa del mantenedor que hay que corregir con evidencia: "La tira y el panel son ventanas nativas transparentes que no toman el foco" (22-10). No es así: ambas son focusable (en macOS `canBecomeKeyWindow` devuelve el atributo `focusable`; en Linux `tao` restituye `accept_focus` tras el primer dibujo) y `focus: false` en `tauri.conf.json` es sólo el arranque. De ahí que el clic en el orbe dé el foco a la tira y que `Escape` sea atendible en ella.
- L16: Decisión de implementación que el plan no fijaba: **con el panel anclado el hover no abre otro provider**. El anclaje lo eligió un clic; el puntero no lo cambia por debajo (para cambiar de provider hay que hacer clic, que además mantiene el anclaje). Es lo que hace coherente el «un solo estado».
- L17: El `OPEN_DELAY` (350 ms en Linux) no se toca (S7): el clic ancla de inmediato y el hover sigue esperando su retardo.
- L18: La cobertura determinista vive en los dos módulos puros (`anchor-panel`, `anchor-focus`): el repo no tiene entorno de DOM (jsdom/happy-dom es decisión de alcance del mantenedor), así que el cableado del componente y el `Escape` se acreditan con la prueba manual y el smoke, no con tests de render.
