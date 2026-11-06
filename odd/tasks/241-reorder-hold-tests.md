# 241-reorder-hold-tests

> Issue: https://github.com/egdev6/quorb/issues/241 — `chore(widget)`, asignada a `DonatoSilva`.
> Rama: `chore/241-reorder-hold-tests` (reconstruida sobre `upstream/main` f08203b tras el review del mantenedor). Fork: `DonatoSilva/quorb`.
> Alcance aprobado por el mantenedor en la propia issue (`status:approved`, `type:chore`); no cambia la regla de #222.

## Specs

- S1: "**Funciones sin lógica propia.** `holdAfterReorderDrop`, `releaseOnStripLeave` y `canPointerOpen` (`src/lib/anchor-panel.ts`) envuelven un booleano (`x => x`, `_ => false`, `h => !h`), así que sus tests no pueden fallar. Los que comprueban la aridad (`canPointerOpen.length`, `hoverPanel.length`, `clickPanel.length`) y «never changes the panel state» (`src/lib/anchor-panel.test.ts`) no fijan ningún comportamiento."
- S2: "**La lógica con bordes reales no tiene test.** La comprobación de «dentro de la ventana» al soltar un reordenado está en línea en `src/Widget.tsx:1219`:"

  ```ts
  e.clientX >= 0 && e.clientY >= 0 && e.clientX < window.innerWidth && e.clientY < window.innerHeight
  ```

- S3: "Un error de `<` frente a `<=` dejaría la retención activa sin que nada la libere, y el hover no volvería a abrir el panel hasta salir de la tira."
- S4: "Dejar la retención como un `useRef<boolean>` en `Widget.tsx` y quitar las tres funciones envoltorio y sus tests."
- S5: "Extraer `pointerInsideViewport(x, y, width, height)` como función pura y cubrir los bordes en ambos ejes: `0`, `-1`, `width - 1` y `width` (y lo mismo con `height`)."
- S6: "Mantener el test de `ProviderGauge` sobre el enrutado de `mouseenter` a `onPointerEnter`, que sí aporta."
- S7: "Sin cambio de comportamiento: mismas condiciones de retención y liberación que #240."
- S8: "`npm test`, `npm run typecheck` y `npm run build` en verde."
- S9: "Fuera de alcance: cambiar la regla de #222, el temporizador de 400 ms (`REORDER_GUARD_MS`) o el cableado de foco y clic."

## Mecanismo (verificado en el código)

- La retención ya es un `useRef` (`Widget.tsx:255`); `ReorderHold` es un alias de `boolean` (`anchor-panel.ts:151`) y `NO_REORDER_HOLD` es `false` (`:154`).
- Las tres envoltorio son identidades: `holdAfterReorderDrop` devuelve su argumento, `releaseOnStripLeave` devuelve `false` ignorando el argumento y `canPointerOpen` devuelve `!hold`.
- Único consumidor en producción: `Widget.tsx:1220` (escribe al soltar), `:1256` (libera al salir de la tira) y `:1320` (consulta en `onPointerEnter`). El reinicio al ocultar el widget está en `:789`.

## Tasks

- [x] T1 — S5 — Test en rojo de los bordes de `pointerInsideViewport` y la función pura en `src/lib/pointer-viewport.ts` (módulo nuevo: el viewport no comparte dominio con el estado del panel de `anchor-panel.ts`). Route: inline. Commit: `8532d1c`.
- [x] T2 — S2, S3, S7 — Cablear la función pura en el `onPointerUp` de `Widget.tsx`: misma comparación, con `window.innerWidth`/`innerHeight` leídos al soltar. Route: inline. Commit: `8532d1c`.
- [x] T3 — S1, S4 — Borrar `holdAfterReorderDrop`, `releaseOnStripLeave`, `canPointerOpen`, `ReorderHold` y `NO_REORDER_HOLD` de `src/lib/anchor-panel.ts`, y el bloque «the reorder hold» de su test. Route: inline. Commit: `8532d1c`.
- [x] T4 — S4, S7 — Aplanar la retención a `useRef<boolean>` en `Widget.tsx`: `= inside` al soltar, `= false` al salir de la tira, `= false` al ocultar el widget y `if (!reorderHold.current)` en `onPointerEnter`. Route: inline. Commit: `8532d1c`.
- [x] T5 — S8 — `npm test`, `npm run typecheck`, `npm run build` y regenerar `docs/i18n-inventory.md` (el inventario fija el hash del árbol `src/` de HEAD). Route: verify. Commit: `8532d1c` (código) y `5be4521` (inventario i18n).
- [x] T6 — S6, S9 — Commits en work units, push al fork y PR a `egdev6/quorb` con `Closes #241`, más el comentario de aviso en la issue. Route: inline. Commit: PR https://github.com/egdev6/quorb/pull/242 (rama `chore/241-reorder-hold-tests`).

## Riesgo

Risk: item 3 (se eliminan exports de `src/lib/anchor-panel.ts` que `Widget.tsx` consumía; los únicos consumidores son `Widget.tsx` y su test, ambos actualizados en el mismo cambio, y `tsc` detecta imports sobrantes).

## Estrategia de entrega

Tres commits: (1) el refactor con sus tests, el motivo del borde en el JSDoc y el ODD (`8532d1c`), (2) el inventario i18n regenerado (`5be4521`; solo cambia la línea de hashes del árbol de `src/`), (3) este registro de la entrega y del review. Push: `git push -u origin chore/241-reorder-hold-tests`, porque la rama rastrea `upstream/main`, donde no hay permiso de escritura.

## Log

- L1: "perfecto ya sabes realiza la nueva rama nacida del main de upstream/main y push al fork que tengo y pr al proyecto con mencion de comentario en el issuo par aque lo revise... recuerdas como lo hicimos con el issue 222 ??"
- L2: Decisión de diseño (parent): `pointerInsideViewport` va en un módulo nuevo `src/lib/pointer-viewport.ts` y no en `src/lib/anchor-panel.ts`. Motivo: el header de `anchor-panel.ts` declara «El estado del panel de detalle (#170)» y el consumidor conceptual del predicado (el hold puro) desaparece en este mismo cambio; el repo agrupa por dominio y los otros predicados geométricos (`dock.ts:80 contains`, `detail-presence.ts:84 pointInBounds`) viven en el módulo de su dominio. Alternativa descartada: `src/lib/anchor-focus.ts` («El seam de foco (#170)»).
- L3: Convención de estilo verificada: `export function` para el predicado (como `dock.ts:80` y `detail-presence.ts:84`; `anchor-panel.ts` usa arrow-const, que es la excepción local), TSDoc en español y breve (familia anchor/reorder), títulos de test en inglés sin acentos (96/96 describes de nivel superior en inglés), módulo DOM-free (vitest corre en entorno `node`, sin jsdom), `tsconfig` con `strict`, `noUnusedLocals` y `noUnusedParameters`.
- L4: El inventario i18n fija el hash del árbol `src/` de HEAD; cualquier cambio en `src/` lo invalida y `node scripts/i18n-inventory.mjs --check` (CI, `ci.yml:49`) falla. El script lee de un commit (`--ref`, por defecto HEAD), no del working tree: hay que commitear `src/` primero y regenerar después.
- L5: Entrega: rama `chore/241-reorder-hold-tests` desde `upstream/main` 29c9188, push al fork `DonatoSilva/quorb` y PR https://github.com/egdev6/quorb/pull/242 (`Closes #241`). Comprobaciones: `npm test` (vitest 69 archivos / 910 tests; `node --test` 298; 0 fallos), `npm run typecheck`, `npm run build` y `node scripts/i18n-inventory.mjs --check`, todo en verde. `cargo test` no aplica: no hay cambios en `src-tauri/`. Sin prueba manual en GUI porque el comportamiento no cambia: las funciones borradas eran identidades y el predicado extraído reproduce la misma comparación. La etiqueta `type:chore` y la asignación de la PR las aplica el mantenedor.
- L6: Review del mantenedor en la PR #242 (`CHANGES_REQUESTED`, 2026-11-06T06:52:01Z). Punto 1, textual: «El JSDoc que se borra de `holdAfterReorderDrop` explicaba por qué no se retiene al soltar fuera de la ventana: el `mouseleave` ya ocurrió y nada liberaría la retención después. Es justo la razón por la que `<` frente a `<=` importa, y hoy ya no aparece en ningún sitio.» Punto 2, textual: «En `odd/tasks/241-reorder-hold-tests.md`, la estrategia de entrega dice «Dos commits», pero el PR tiene tres (el tercero registra la entrega).» Cierra con «Con eso lo apruebo. La etiqueta y la asignación las pongo yo.»
- L7: Aplicados los dos ajustes. El motivo conductual del `<` pasa al JSDoc de `pointerInsideViewport` (el spec S3 ya lo razonaba, pero no vivía en el código) y este documento declara los tres commits con sus hashes reales.
- L8: `upstream/main` avanzó de 29c9188 a f08203b (cuatro commits, entre ellos el selector de idioma #244, que agregó `src/LocalePicker.tsx` y tocó `src/main.tsx`), así que el hash del árbol `src/` cambió y `docs/i18n-inventory.md` quedó en conflicto: era el único archivo compartido entre upstream y esta rama. La rama se reconstruyó sobre f08203b con los mismos tres commits, el inventario regenerado contra el árbol nuevo y las mismas comprobaciones en verde.
