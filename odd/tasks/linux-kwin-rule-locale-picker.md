# Feature: Regla de KWin optativa y selector de idioma fuera de su alcance (#227)

KWin 6.7.5 en Wayland ignora las peticiones de "todos los escritorios" de los clientes XWayland, así que el cambio de #232 no basta en KDE. Se documenta una regla de KWin creada por el usuario como apaño manual y se da al selector de idioma un título propio para que la regla no lo alcance. La issue sigue abierta: no es un arreglo general.

## Specs

- **S1 (Título del selector)**: el selector de idioma del primer arranque (`open_locale_picker`) deja de titularse `Quorb`. egdev6: "`Idioma / Language · Quorb` me parece bien: es fijo, no depende de la traducción y deja fuera al selector con la expresión actual `^Quorb( · .+)?$`."
- **S2 (Solo canal estable)**: egdev6: "Documenta la regla para el canal estable, sin el `( Beta)?`, para no describir un caso que no se puede compilar ni medir."
- **S3 (Explicación de la exclusión)**: egdev6: "Ten en cuenta que esa expresión no se vuelve más estricta; el selector queda fuera porque su título deja de empezar por `Quorb`. Así conviene explicarlo en la documentación."
- **S4 (Test contra la expresión documentada)**: egdev6: "prefiero un test que use la expresión documentada y la compruebe contra la tabla completa de títulos: debe coincidir con la tira, el detalle y el overlay en ES/EN, y no con Ajustes ni con el selector. Así, si alguien cambia la regla o un título, falla el test."
- **S5 (Documentación)**: egdev6: "En `docs/build-linux.md`, presentá la regla como optativa y creada por el usuario, con el entorno probado (CachyOS, Plasma/KWin 6.7.5 en Wayland, Quorb por XWayland) y las limitaciones medidas: el detalle anclado desapareció en una de tres pruebas, el overlay solo se pudo medir en una, y Plasma X11 y GNOME no están verificados. La issue sigue abierta, porque es un apaño manual y no un arreglo general."
- **S6 (Nueva medición)**: "La documentación y la nueva medición, como propones": el selector con la regla y la configuración aislada queda con `onAllDesktops: false`, más una pasada de tira, detalle y Ajustes, con capturas.

## Tasks

- T1 | S1, S3, S4, S5 | inline, test-first | título del selector + test contra la regla documentada + sección de `docs/build-linux.md` | commit: 6fcb1d0
- T2 | S1 | inline | regenerar `docs/i18n-inventory.md` tras el commit de T1 | commit: 3c0956d
- T3 | S6 | inline + manual | build de host, medición con la regla temporal y configuración aislada, capturas | evidencia: build 3c0956d (sha 60d00f73), runs-227/50-53, capturas publish4
- T4 | S1-S6 | inline | revalidar alcance y `main`, borrador de PR con evidencia; abrirla requiere OK de Rafael | PR: pendiente

## Log

- L1: Petición de Rafael: "ok" al plan publicado en #227 (issuecomment-6796865945), que decía "Lo implemento en cuanto lo vea asignado".
- L2: egdev6 asigna #227 a @Rafaeldelinares (2026-11-11T13:40:31Z) con los ajustes recogidos en S1-S4 y S6.
- L3: egdev6 (2026-11-11T08:07:09Z) eligió la opción 2 y fijó el contenido de la documentación (S5).
- L4: Mediciones previas en #227 (issuecomment-6777782892 y 6782467853): la regla alcanza a la tira, el detalle, el overlay y el selector; Ajustes queda fuera; la clase de KWin distingue mayúsculas (`[Qq]uorb`); las ventanas no exponen `WM_WINDOW_ROLE`.
- L5: Medición T3 (2026-11-11, build de host `3c0956d`, regla copiada del bloque `ini` de `docs/build-linux.md` §6.2, configuración de Quorb aislada con `XDG_*_HOME` temporales y `kwinrulesrc` restaurado al terminar): selector `Idioma / Language · Quorb` con `onAllDesktops: false`, se queda en el escritorio 1 al pasar al 2; tira `Quorb` con `onAllDesktops: true`; detalle transitorio acompaña del 1 al 2; Ajustes se queda en el escritorio 1 con `onAllDesktops: false`. Durante la prueba de Ajustes apareció una ventana sin título de Quorb de 147×121 con `onAllDesktops: true` que ya no estaba en el escritorio 2 (probablemente un menú o tooltip transitorio de la tira; no investigado).
