# Brief congelado: cómo presentar un dato obsoleto (`stale`)

> Objetivo del Juicio: elegir, entre las salidas que el owner dejó abiertas y las que propone el autor, la mejor forma de presentar un medidor conservado de un ciclo anterior.
> Rama: `fix/252-nan-tier-quota` (PR #261, issue #252). Esta decisión **no** pertenece a #268 (que es la presentación de los créditos).
> Target congelado: este documento + el árbol del commit `<CODE_SHA>` de esa rama. Los dos jueces deben leer el código **desde ese commit**, no desde el working tree.

## 1. El problema, con las palabras del owner

> "Efecto fuera de NaN, en OpenCode Go (`src/lib/format.ts:87-93,114-125,147-153`). Si falta una ventana semanal que antes estaba al 100 %, se conserva stale y desplaza al 95 % fresco: el tooltip dice `OpenCode Go: 100%` y el indicador/ritmo quedan en `over`, sin señalar allí que el pico es antiguo. El aviso y el email del medidor fresco sí funcionan. Hay que evitar presentar el pico obsoleto como actual, o marcar explícitamente esa antigüedad en sus consumidores."
> — mantenedor, revisión de la PR #261 (2026-11-13)

## 2. Qué es un medidor obsoleto

`Meter.stale` (`src/lib/types.ts`) lo marca **el propio frente**: el backend no lo declara. Se marca en `mergeReports` (`src/lib/format.ts:100-133`) cuando un ciclo falló y el medidor no vino en el informe nuevo: se conserva el valor del ciclo anterior. Hay dos ramas:

- **Informe fallido sin medidores** → se conserva el informe entero con `stale: true` (nivel de informe).
- **Informe fallido mixto** (trae algunos medidores frescos) → se conservan **sólo** los medidores que faltan, marcados `stale: true` uno por uno.

Origen: commit `d6781f3` "fix(alertas): marcar los medidores conservados uno por uno", para que un medidor fresco que superó el umbral siga avisando aunque su compañero sea viejo.

## 3. Comportamiento actual (evidencia)

| Consumidor | Ubicación | Qué hace hoy con un medidor `stale` |
| --- | --- | --- |
| `peakMeter` | `src/lib/format.ts:87-94` | **No** filtra `stale`: el medidor viejo puede ser "el pico" |
| Anillos del orbe | `src/components/ProviderGauge.tsx:83-88` | Se eligen con `peakMeter` y con `report.meters.filter(m => m.percent != null)`: un medidor viejo entra al anillo |
| Estado del orbe | `src/components/ProviderGauge.tsx:12-19` | `peak >= 100` → `over`; `peak >= threshold` → `warning`: un pico viejo puede poner el orbe en `over` |
| Tooltip de la bandeja | `src/lib/format.ts:149` (`trayTooltip`) | Usa el pico → "OpenCode Go: 100%" |
| Atajo "abrir el más cargado" | `src/Widget.tsx:955` | Usa `peakMeter` |
| Ritmo | `src/lib/pace.ts:38-44` (`meterPace`) | **No** mira `stale`: el ritmo se calcula sobre el medidor viejo |
| Detalle: ritmo y aviso | `src/components/ProviderDetails.tsx:111-112,133-152` | `paces` incluye los viejos; si un ritmo queda `over`, sale el aviso "A este ritmo…" con color de peligro |
| Detalle: lista de medidores | `src/components/MeterBar.tsx:24,39-45` | **Único** lugar donde el usuario ve que el dato es viejo: pastilla `details.staleChip` ("caché" / "cached") con tooltip `details.staleChipTitle` ("Datos del último ciclo correcto" / "Data from the last good cycle") |
| Estilo | `src/theme.css:133-136` | `.q-meter--stale .eg-progress { opacity: 0.45 }`: **sólo la barra** se atenúa. El número conserva su color de marca (`data-level`, `src/components/MeterBar.tsx:26` → `src/theme.css:129`) |
| Avisos y email | `src/lib/alerts.ts:63,68` | **Sí descartan lo viejo** (informe entero `stale` y medidores `stale`). Funciona y hay que conservarlo |
| Textos | `src/i18n/es.ts:531-532`, `src/i18n/en.ts:506-507` | "caché" / "cached". **No existe** ninguna clave con "antiguo", "desactualizado" ni "última lectura" |

## 4. Restricción de datos (importante)

`Meter` **no** tiene marca de tiempo (`src/lib/types.ts:5-27`). El informe sí: `UsageReport.fetchedAt`.

- En la rama "informe entero conservado" se conserva el `fetchedAt` viejo.
- En la rama "informe mixto" **manda el informe nuevo**: los medidores viejos llegan sin fecha.

Etiquetar "última lectura: &lt;fecha&gt;" exige **transportar el `fetchedAt` del informe anterior hasta el medidor conservado**. No es un texto: es un cambio de contrato (`Meter.readAt`) y un ajuste en `mergeReports`.

## 5. Casos que la decisión tiene que cubrir

- **C1 — sólo hay dato viejo.** Se cayó la lectura de la ventana semanal y no queda ningún medidor fresco. Hoy el widget muestra el pico viejo como si fuera el estado actual.
- **C2 — mezcla.** Hay medidores frescos y viejos a la vez. ¿El anillo debe mostrar el viejo, el fresco, o ninguno?
- **C3 — otro régimen de facturación.** El medidor viejo pertenece a un régimen que ya no aplica (p. ej. topes por modelo de un plan Gentle en una cuenta que ahora se factura en créditos). `mergeReports` (`src/lib/format.ts:104-125`) trata `warning` (suscripción inactiva) igual que `error` (fallo de lectura) y resucita medidores del régimen anterior. Ahí el dato no es sólo viejo: es **incorrecto**. Es el punto 2 de la revisión del owner.
- **C4 — por qué existe el dato viejo.** Si se cortó internet, el valor del ciclo anterior es información real ("hace 3 horas estabas al 95 %"), aunque no sea el estado actual.

## 6. Espacio de opciones

- **O1 — Ocultar.** El medidor viejo no aparece: ni en la tira, ni en el tooltip, ni en el ritmo, ni en el detalle.
- **O2 — Etiquetar.** Se mantiene visible con la pastilla y una fecha ("caché · 12 nov"), sin tocar quién calcula el pico. Es la segunda salida literal del owner: "marcar explícitamente esa antigüedad en sus consumidores".
- **O3 — Atenuar.** Todo el componente se atenúa (no sólo la barra) y se etiqueta con la fecha.
- **O4 — Recalcular sin él.** El medidor viejo **no** participa del pico, del anillo, del estado `over` ni del ritmo; sigue visible en el detalle, atenuado y con fecha. Es la primera salida literal del owner: "evitar presentar el pico obsoleto como actual".
- **O5 — Aviso genérico.** No se muestra el dato viejo; se muestra un aviso ("no hay lectura actual") y nada más.

Combinaciones plausibles: **O4+O3** (propuesta del autor: "no mostrar el obsoleto como actual, atenuarlo y etiquetarlo como última lectura, tal fecha"), O4 a secas, O2 a secas, O1+O5, O3+O2.

## 7. Criterios (idénticos para los dos jueces)

1. **Verdad de la lectura**: nada viejo se presenta como estado actual (anillo, color, `over`, ritmo, tooltip, atajo "más cargado").
2. **Utilidad**: se conserva información accionable ("hace 3 horas estabas al 95 %") sin que la app la trate como vigente.
3. **Coherencia con las convenciones del repo**: el frente consume un modelo genérico y **no sabe** de qué proveedor ni de qué régimen de facturación se trata (S27); i18n ES/EN; la pastilla "caché" ya existe.
4. **Robustez** con datos parciales (C2) y con el cambio de régimen (C3).
5. **No romper lo que ya funciona**: los avisos y el email del medidor fresco, el detalle, el saldo sin porcentaje (packs de créditos).
6. **Comprensibilidad**: alguien sin contexto entiende en un vistazo qué está viejo y desde cuándo.
7. **Riesgo de regresión transversal**: el cambio afecta a todos los proveedores (código compartido).
8. **Esfuerzo y superficie**: backend o frente; qué archivos toca; qué contrato cambia.

## 8. Pregunta al juez

- ¿Qué opción o combinación es la mejor según estos criterios? Nombrala con su identificador.
- Reportá como **CRITICAL** cualquier opción (o parte de una combinación) que: (a) no resuelva el punto del owner — presenting el pico obsoleto como actual; (b) rompa los avisos o el email del medidor fresco; (c) pierda información necesaria sin avisar; (d) presente como vigente un dato de otro régimen de facturación.
- Reportá como **WARNING** o **SUGGESTION** las mejoras de redacción, i18n, accesibilidad, alcance o contrato de datos.
- Si ninguna combinación satisface los criterios, proponé una que no esté en la lista y justificá por qué.
- Si dos opciones empatan, decilo y elegí una, con el argumento que usaste.

## 9. Fuera del alcance del juicio

- El reinicio real dentro del mismo día UTC (punto 1 de la revisión): es lógica de ventanas, no presentación.
- La forma del payload de créditos (`credits_breakdown`) y la captura real de una cuenta Inference/Premium: es contrato del proveedor.
- El texto de `billingDay` y la mezcla del mes natural con el periodo de facturación: es copy del backend.

## 10. Cómo se juega esto

El veredicto fija la **decisión de presentación**. La implementación (Rust + TypeScript, textos ES/EN, tests) se hace después, en la rama de la PR #261, con la revisión del owner como criterio de aceptación.
