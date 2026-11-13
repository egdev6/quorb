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

## Estado de la ronda

```yaml
target_identity: eeebf275ad4b2c1d94ab79134174eff4320a87782ad91a35ad4c8f9cee142511
round: 1
confirmed: [C-1, C-2, C-3, C-4, C-5, C-6, C-7]
suspect: [S-1, S-2, S-3, S-4, S-5]
info: [I-1, I-2, I-3]
contradictions: []
fix_work_units: [T31]
scoped_rejudgment: not_run
terminal_state: pending
skill_resolution: paths-injected
```

Ronda 2 (re-juicio acotado): sobre este ledger congelado + el delta de la implementación de T31. Sin la ronda 2 no hay veredicto terminal.
