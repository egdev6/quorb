# Ledger del Juicio — presentación del dato obsoleto

> Target: `odd/tasks/252-stale-presentation.md` en el commit `c96a27b796c583730d660376466baf324c16bd24`.
> `target_identity` (sha256 del brief): `eeebf275ad4b2c1d94ab79134174eff4320a87782ad91a35ad4c8f9cee142511`.
> Código inspeccionado: el mismo commit, leído con `git show <sha>:<path>` (el working tree no es la fuente).
> Jueces: `jd-judge-a` (`mwf84ncf-4-ros0`) y `jd-judge-b` (`mwf84nbb-3-xckz`), en paralelo, mismo brief y mismos criterios.
> Reglas: dos jueces confirmados ⇒ severo corregible; un solo juez ⇒ **sospechoso**, no se corrige; los avisos y sugerencias quedan como `info`.

## Ronda 1 — fusionada (los dos jueces)

### Severos confirmados por **los dos** jueces

| ID | Ubicación | Hallazgo fusionado |
| --- | --- | --- |
| C-1 | `brief:O4` | O4 escrita sobre el flag por medidor **no** resuelve C1: `mergeReports` sólo marca `stale: true` en un medidor en la rama mixta (`format.ts:125`); en la rama de informe entero (`format.ts:105-107`) y en la de `needsLogin` (`format.ts:129-133`) conserva el informe anterior **sin marcar sus medidores**. La regla de obsolescencia tiene que ser "`meter.stale` **o** `report.stale`" y **todos** los consumidores de estado actual tienen que consultarla |
| C-2 | `brief:O2` | O2 (etiquetar sin tocar el cálculo) no resuelve el punto del owner: etiquetar un consumidor no cambia el consumidor que calcula el pico |
| C-3 | `brief:O3` | O3 (atenuar) sola tampoco: la atenuación es estilo de la tarjeta; el pico, el anillo, el estado y el ritmo se calculan aparte |
| C-4 | `brief:O1` | O1 sola borra la última lectura buena sin avisar: se pierde la información accionable de C4. Sólo es admisible con un aviso explícito (O5) |
| C-5 | `code:src/lib/format.ts:87-94` | El defecto del owner, confirmado: `peakMeter` no mira la obsolescencia, así que el pico viejo manda en el tooltip de la bandeja (`format.ts:147-152`), en el estado `over` del orbe (`ProviderGauge.tsx:15-17`), en los anillos (`ProviderGauge.tsx:83-86`), en el ritmo (`pace.ts:38-44`), en el atajo de "más cargado" (`Widget.tsx:955`) y en la salud de Ajustes (`Settings.tsx:622`) |
| C-6 | `code:src/lib/format.ts:104-107` | C3 es un problema de **corrección del dato**: `mergeReports` trata `warning` (suscripción inactiva) igual que `error` (fallo de lectura) y revive el informe anterior entero, con su plan y sus medidores del régimen anterior. El frente no tiene ningún campo que identifique el régimen (`Meter` sólo trae `quotaSource`) |
| C-7 | `code:src/components/ProviderCard.tsx:71-75` | La obsolescencia ya se ve en **dos** niveles: la pastilla de informe en la tarjeta y la pastilla por medidor en `MeterBar`. El brief subestimaba dónde es visible hoy |

### Sospechosos (un solo juez), verificados por el padre sobre el código

| ID | Ubicación | Hallazgo | Verificación del padre |
| --- | --- | --- | --- |
| S-1 | `src/components/ProviderGauge.tsx:86-92` + `src/lib/meter-colors.ts:5-7` | El color del anillo se indexa por la posición del medidor (`var(--ring-N)` para los proveedores por modelo, como NaN). Si los medidores obsoletos salen de la lista del orbe, los índices se corren y el orbe pinta un medidor fresco con el color del anillo 1 mientras la tarjeta y el detalle lo etiquetan como anillo 2/3: se rompe la leyenda | Confirmado leyendo `meter-colors.ts` y `ProviderCard.tsx` |
| S-2 | `src/lib/format.ts:129-133` | Hay una **tercera** rama que conserva el informe anterior con `stale: true`: la de `needsLogin`. Ahí el orbe queda atenuado, pero el tooltip y el atajo siguen usando el pico conservado | Confirmado (la rama existe; el brief decía "dos ramas") |
| S-3 | `src/Settings.tsx:621-630` | `healthSummary` muestra el pico como vigente en la pantalla de Ajustes: es un consumidor que el brief no listaba | Confirmado con grep de `peakMeter` |
| S-4 | `src/components/ProviderDetails.tsx:111-121` | `ringMeters` alimenta **el ritmo y la serie del historial**: sacar de ahí el medidor obsoleto borraría también su línea de historial, que es información real | Confirmado leyendo el bloque |
| S-5 | `brief:O4` | O4 no define el estado del orbe cuando no hay ninguna lectura vigente: la rama de informe entero fuerza `status: 'warning'` y `gaugeState` devuelve `warning` aunque el pico sea 0 sólo porque no hay medidor fresco | Confirmado (`ProviderGauge.tsx:17`) |

### `info` (los dos jueces, correcciones al brief)

- `theme.css:129` es `.q-meter__label`; el color del número viene de `theme.css:131` (`.q-meter[data-level='max'] .q-meter__value`): el 100 % obsoleto conserva el color de marca más fuerte.
- El aviso de ritmo usa tono `warning`, no de peligro; sólo el texto de la fila de ritmo usa el color de peligro.
- Deriva de líneas del brief: `mergeReports` va de 100 a 136 y las ramas 104-128; `Meter` va de `types.ts:6-30`.

### Decisión (los dos jueces coinciden)

**O4 + O3** — la combinación del autor: el medidor obsoleto **no** participa de ningún cálculo de estado actual, pero **sí** se ve en el detalle, atenuado y con la fecha de su última lectura. Sin empate: O4 sola deja el medidor conservado sin marcar ni fechar; O2/O3 solas fallan el criterio 1; O1 sola falla el criterio 2; O5 sola falla C2.

Correcciones obligatorias que los dos jueces coinciden en exigir:

1. **La regla de obsolescencia es por dos vías**: `meter.stale` **o** `report.stale` (si no, C1 sigue roto).
2. **El mismo filtro de "sólo frescos" rige todos los consumidores**: `peakMeter`, `gaugeState`, los anillos, `meterPace`/`paces`, el tooltip de la bandeja, el atajo de "más cargado" y `healthSummary` de Ajustes — **y el índice de anillo/color** en orbe, tarjeta y detalle, para que la leyenda siga siendo coherente en los proveedores por modelo (S-1).
3. **La fecha exige un cambio de contrato**: `Meter.readAt`, transportado desde el `fetchedAt` del informe anterior dentro de `mergeReports` (hoy no existe; en la rama mixta manda el `fetchedAt` nuevo).
4. **C3**: `mergeReports` tiene que dejar de resucitar los medidores de otro régimen de facturación cuando el aviso es "suscripción inactiva" y no un fallo de lectura.
5. **Cuando no hay ninguna lectura vigente**, el orbe tiene que definir su estado (atenuado o vacío), no derivarlo de `status: 'warning'` (S-5).

### Verificación del padre (spot check)

Confirmados con lectura directa: `gaugeState` sólo atenúa `needsLogin`/`unconfigured`/`error`; los anillos se eligen con `all = report.meters.filter(m => m.percent != null)` y el color sale del índice; la tarjeta tiene su propia pastilla de informe; en `opencode_go.rs` el 403 `EntitlementError` se traduce en `Status::Warning`, que es lo que dispara la resurrección del informe anterior; `Settings.tsx:622` es el quinto consumidor de `peakMeter`.

## Ronda 2 — re-juicio acotado (los dos jueces, sobre este ledger + el delta)

Los dos jueces examinaron el ledger congelado y el delta (`3e7071c`, `1fda69a`, `56a5e96`, `02e74ab`) y **coincidieron sin contradicciones**:

| ID | Juez A | Juez B |
| --- | --- | --- |
| C-1 (obsolescencia por dos vías) | FIXED | FIXED |
| C-2 (el pico se calcula sobre los vigentes) | FIXED | FIXED |
| C-3 (estado, anillos y ritmo recalculados) | FIXED | FIXED |
| C-4 (la última lectura se conserva y se fecha) | FIXED | FIXED |
| C-5 (el pico obsoleto no manda) | FIXED | FIXED |
| C-6 (no se resucita otro régimen) | FIXED en el escenario confirmado | FIXED dentro del alcance declarado |
| C-7 (los dos niveles de marca) | HONORED | FIXED |
| S-1 (índice de anillo coherente) | HONORED | HONORED |
| S-2 (tercera rama, `needsLogin`) | HONORED | HONORED |
| S-3 (salud de Ajustes) | HONORED | HONORED |
| S-4 (la serie del medidor viejo no se borra) | HONORED | HONORED |
| S-5 (estado del orbe sin lectura vigente) | HONORED | HONORED (con un matiz sobre la guarda) |
| I-1 (el valor viejo pierde el color de marca) | addressed | addressed |

### Residuales de la ronda 2

| ID | Sev | Hallazgo | Quién |
| --- | --- | --- | --- |
| **F1** | WARNING | El gasto conservado se presenta como actual en el detalle (fila de ritmo y proyección "a este ritmo") y en la tarjeta, mientras el tooltip de la bandeja sí lo esconde: la regla se aplica en un consumidor y no en el otro | A y B |
| **F2** | WARNING | La rama que conserva el informe anterior devuelve `{ ...old, ... }`: **descarta la declaración de régimen del informe nuevo** y se queda con la del anterior. Con el caso "el nuevo declara el régimen y el anterior no" no hay comparación posible y los medidores del régimen anterior se resucitan en cada ciclo | A (el padre lo verificó en el código) |
| **F3** | WARNING | El resumen que se copia (`reportSummary`) lista los medidores viejos y el gasto conservado como valores actuales, sin la marca de caché ni la fecha | A y B |
| **F4** | SUGGESTION | El tooltip esconde el gasto con `hasStaleData` (algún medidor viejo) en vez de "el gasto es viejo": en un informe **mixto** con gasto **fresco** y medidores viejos, el gasto fresco desaparece (defecto **introducido** por el arreglo) | B |
| **F5** | SUGGESTION | El orbe compacto (colapsado) pinta su único anillo con el índice 0, así que para los proveedores por modelo el color puede no coincidir con el número de anillo de la tarjeta. **Preexistente**, fuera del delta | B |
| **F6** | SUGGESTION | El comentario de `gaugeState` dice "sin ninguna lectura vigente el orbe queda atenuado" pero la guarda exige además que haya datos viejos: el **comportamiento** está bien (una suscripción inactiva sin lecturas sigue avisando), lo que no cuadra es el comentario | B |

### Ronda de corrección 2 (decidida por el padre)

- **F1 + F4**: la regla del gasto es única y es "el gasto es viejo si el **informe entero** está viejo" (`report.stale`), no "si hay algún medidor viejo". Con eso el gasto fresco de un informe mixto **vuelve a verse** (F4) y el gasto viejo **no se proyecta** ni se presenta como actual (F1).
- **F2**: la comparación de régimen pasa a ser **asimétrica**: si el informe nuevo declara un régimen y el anterior no declara ninguno, los medidores del anterior **no** se conservan (no se pueden atribuir al régimen vigente); si el nuevo no declara nada (lectura fallida), se conserva todo como hoy. Sólo afecta a NaN, el único proveedor que declara régimen. El test del delta que fijaba el comportamiento viejo cambia y se añade el caso positivo.
- **F3**: el resumen copiado marca los medidores viejos (caché + fecha) y el gasto viejo.
- **F6**: se corrige el comentario de `gaugeState` (el comportamiento se queda).
- **F5**: queda registrado como `info`: es **preexistente** y no lo introduce este trabajo.

## Ronda 3 — re-juicio final (los dos jueces, sobre este ledger + el delta de la corrección)

Los dos jueces examinaron el ledger congelado y el delta de la corrección (`a5b4d87`, `adf2af1`) y **terminaron con `findings: []`**: los dos coinciden en que **no queda ningún defecto**.

| ID | Veredicto de los dos jueces |
| --- | --- |
| F1 (el gasto conservado como actual) | FIXED |
| F2 (el régimen se perdía al conservar) | FIXED (comparación asimétrica) |
| F3 (el resumen copiado afirmaba el estado viejo) | FIXED |
| F4 (el tooltip escondía el gasto fresco del informe mixto) | FIXED |
| F6 (el comentario de `gaugeState` no describía su guarda) | FIXED (solo el comentario; el comportamiento no cambió) |
| F5 (el orbe colapsado con índice 0) | CONFIRMADO PREEXISTENTE, fuera de alcance: el delta no lo introduce y no contradice ningún criterio |
| Criterios de aceptación | Reverificados de punta a punta por los dos jueces |

Ambos washes: **ningún defecto introducido por la corrección**. El juez A lo verificó además ejecutando sobre un `git archive` del commit: `tsc --noEmit` limpio y `vitest run --dir src` → 77 archivos / 1070 tests en verde; y comprobó que el inventario i18n registra exactamente los hashes del árbol del delta (`src=3814331d…`, `src-tauri/src=efa61876…`) y que no se agregó ninguna clave nueva.

Observación del juez A (no es un hallazgo): la rama bloqueada por el cambio de régimen descarta también el `spend` del ciclo anterior, lo cual es coherente con la regla asimétrica congelada y con la rama de régimen distinto que ya existía, porque en NaN el gasto también depende del régimen.

## Veredicto terminal

```yaml
target_identity: eeebf275ad4b2c1d94ab79134174eff4320a87782ad91a35ad4c8f9cee142511
round: 3
confirmed: [C-1, C-2, C-3, C-4, C-5, C-6, C-7]
suspect: [S-1, S-2, S-3, S-4, S-5]
info: [I-1, I-2, I-3, F5]
fix_work_units: [T31a, T31b, F1, F2, F3, F4, F6]
contradictions: []
scoped_rejudgment: approved
terminal_state: approved
skill_resolution: paths-injected
```

El juicio **no emite recibo ni autoriza la entrega**: publicar (push, PR, release) sigue siendo la decisión del owner bajo la política del repo.
