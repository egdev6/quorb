# 268-nan-credits

> Issue: https://github.com/egdev6/quorb/issues/268 — `type:feature`, abierta por el mantenedor el 2026-11-11T22:35Z (`status:needs-review`).
> Rama: `fix/268-nan-credits`, encadenada sobre `fix/252-nan-tier-quota` (la otra mitad del alcance). Cuando `#261` entre, esta rama se rebasa sobre `main` y su PR queda con el diff de los créditos solo.
> Decisión de alcance del mantenedor (2026-11-11T22:40Z, en el PR #261): "**cada tipo de suscripción con su propio artefacto**. `#261` → planes con asignación por modelo (Gentle). `#268` → planes con créditos (Inference/Premium). Un medidor de créditos del periodo, en otra PR."
> El mantenedor eligió la presentación el 2026-11-12T18:10Z: "Me parece correcto. **Incluiría el desglose por modelo tal y como está en la imagen.** Con esto también abrimos precedente de cómo aplicarlo si cualquier otra subscripción o proveedor tiene una casuística igual. Adelante con el desarrollo!"
> Maqueta de la propuesta: `design/nan-credits/` (canvas con el board del sistema, los estados y el antes/después).

## Specs

- S1: "Desde el **10 de noviembre de 2026**, NaN Builders mide la inferencia en **créditos** y no en una asignación de tokens por modelo. La tira y el detalle de Quorb siguen mostrando un medidor por modelo con tope en tokens, así que en las cuentas que pasaron a créditos el medidor ya no representa lo que limita a la persona." (issue #268)
- S2: "**Un único fondo por cuenta:** Inference (nan_member, 70 €/mes) incluye 7.000 créditos por periodo de facturación y Premium (200 €/mes) 20.000. ... **Every model marked credits draws from that same pool, by its price per token** (input, cached input and output), so there is no separate allowance per model." (issue #268)
- S3: "**Reinicio:** el fondo vuelve a llenarse al empezar el periodo de facturación de Stripe («almost never the 1st»). Los créditos incluidos no se acumulan y se prorratean al empezar o subir de plan a mitad de periodo." (issue #268)
- S4: "**Packs de créditos:** se consumen después de los créditos incluidos, caducan a los 6 meses de la última compra y pueden recargarse automáticamente. Sin créditos, la API responde `402 insufficient_balance`." (issue #268)
- S5: "**Modelo sin contador**: `gemma4`, `qwen3.6`, `qwen3-embedding`, `rerank`, `kokoro` y `whisper` no consumen créditos. Las imágenes (`flux-2-klein`, `qwen-image-2.1`) tienen su propio límite de 100 solicitudes al mes por mes natural." (issue #268)
- S6: "**Ventana de `glm5.3`:** 400M tokens por ventana móvil de 4 h, independiente de los créditos; al llenarse responde `429`." (issue #268)
- S7: "**Plan Gentle**: no usa créditos y conserva una asignación de tokens por modelo (`402 monthly_cap_reached` al agotarla)." (issue #268)
- S8: "**Requisito previo**: capturar con una API key real (censurada, sin claves ni datos personales) la respuesta actual de `GET /v1/usage` y de `GET https://cloud-api.nan.builders/api/usage/quota` de una cuenta Inference o Premium. El payload de #252 es del 8 de noviembre, anterior al cambio, y todavía traía `cap` por modelo." (issue #268)
- S9: "**API**: según Getting started, `GET /v1/usage` devuelve el uso por día y modelo con los créditos facturados y, además, «your current billing period, whatever window you ask for: your allowance, the credits used and remaining, and your pack credits». La documentación no publica los nombres exactos de esos campos." (issue #268) → el contrato público los publica: `https://nan.builders/openapi.json` (`credits` con `period_start`, `period_end`, `allowance`, `used`, `remaining`, `pack_credits`, `pack_expires_at`, `frozen`; y `credits` es `null` si la cuenta no se factura en créditos).
- S10: "**Cuentas con créditos.** Como mínimo, #261 no debería mostrar medidores por modelo engañosos en esas cuentas. El medidor de créditos en sí lo dejaría para #268, para no ampliar más esta PR." (issue #268)
- S11: "Incluiría el desglose por modelo tal y como está en la imagen. Con esto también abrimos precedente de cómo aplicarlo si cualquier otra subscripción o proveedor tiene una casuística igual." (owner, 2026-11-12T18:10Z)
- S12: "El consumo de créditos debe salir de la API, no de una tabla local." (issue #268, fuera de alcance: calcular créditos a partir de tokens y precios por modelo)

## Decisiones de presentación (aún por cerrar)

- **A) Un solo anillo de créditos** — el mínimo: un anillo con el % de créditos del periodo, la barra con el importe, el reinicio y el ritmo, y la línea del saldo de packs aparte. Es la forma en que ya se muestran otros saldos (Claude `extra_usage`, Codex `credits`).
- **B) A + el desglose por modelo** — lo que eligió el mantenedor: además, una lista con el consumo de cada modelo, **sin porcentajes** (en créditos no hay tope por modelo). Es la opción con más información y la que abre precedente.
- El **saldo de packs** va **aparte**, sin barra y sin porcentaje: es un saldo, no un límite, y no se suma al denominador (S4).
- El **gráfico diario** queda como hoy (aparece sólo si el proveedor declara una serie diaria): no se agrega en esta PR.
- El **texto del plan** lo declara la persona (Gentle / Inference / Premium), sin precios; la asignación del periodo la muestra el medidor.

## Tasks

- [ ] T1 — S1, S2, S9 — El medidor de créditos del periodo: un anillo en la tira, la barra con el importe (`24,3 / 7.000 créditos`), el reinicio (`period_end`) y el ritmo. Route: worker. Commit: pendiente.
- [ ] T2 — S4 — El saldo de packs: una línea aparte, sin barra ni porcentaje, con su caducidad (`pack_expires_at`), y sólo si hay saldo. Route: worker. Commit: pendiente.
- [ ] T3 — S11 — El desglose informativo por modelo, **genérico** (el precedente que señaló el mantenedor): el backend declara la lista y el front la dibuja sin saber de qué proveedor es. Route: worker. Commit: pendiente.
- [ ] T4 — S9 — La suscripción inactiva (`frozen`): aviso, sin perder la visibilidad del saldo. Route: worker. Commit: pendiente.
- [ ] T5 — S7, S9 — El texto del plan (Gentle / Inference / Premium) y el de las cuentas sin créditos incluidos. Route: worker. Commit: pendiente.
- [ ] T6 — S8 — Los tests con los payloads reales: cuenta con créditos, plan Gentle, primer periodo prorrateado, packs sin créditos incluidos y endpoint caído con el fallback señalado. **Bloqueado por S8**: falta la captura de una cuenta Inference o Premium. Route: worker. Commit: pendiente.
- [ ] T7 — S5, S6 — Los modelos sin contador y la ventana de 4 h de `glm5.3`: no consumen créditos, así que no aparecen como consumo; la ventana de 4 h sigue fuera (es un límite aparte, no un crédito). Route: inline. Commit: pendiente.

## Log

- L1: Exploración y propuesta (2026-11-11/12). La API pública de NaN (`https://nan.builders/openapi.json`) publica los nombres exactos de los campos que la documentación del sitio no da: el bloque `credits` de la raíz de `GET /v1/usage`, con `allowance`, `used`, `remaining`, `pack_credits`, `pack_expires_at` y `frozen`, y `credits` es `null` cuando la cuenta no se factura en créditos. La captura de nuestra cuenta (plan Gentle, la única que conserva la asignación por modelo) confirma ese `null` y que el endpoint de Cloud sigue contestando igual que el 8 de noviembre. Se propusieron dos presentaciones (A: un anillo de créditos; B: A + el desglose por modelo) y el mantenedor eligió la B el 2026-11-12T18:10Z, pidiendo que el desglose sea el precedente para otros proveedores con la misma casuística. La maqueta de la propuesta quedó en `design/nan-credits/` (canvas abierto) y se movió a esta rama: no va en el diff de `#261`, que es el arreglo de la otra mitad del alcance. **Lo que falta**: la captura de una cuenta Inference o Premium (S8), que el mantenedor ya pidió; sin ella, T6 no se puede cerrar con un payload real.
