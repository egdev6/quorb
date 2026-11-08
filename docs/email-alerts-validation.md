# Evidencia manual de email (#245): informe de validación

Este documento inventaría la evidencia manual de la integración de email de
[#245](https://github.com/egdev6/quorb/issues/245) aportada por el usuario en su
entorno macOS, distinguiendo lo **observado en imágenes**, lo **confirmado por
el usuario** y lo **no acreditado**. Prepara una futura PR: no la abre, no
publica imágenes y no declara cerrada #245. Los resultados automatizados con
HTTP simulado son evidencia histórica separada, descrita en
[`email-alerts.md`](email-alerts.md); este informe no introduce resultados nuevos.

## Procedencia y fuentes

| Fuente | Qué aporta |
| --- | --- |
| Capturas `1.png`–`7.png` y `recepcion.png` en la carpeta externa `quorb_screenshots` del usuario (fuera de Git) | Estados visuales, feedback de envío y recepción; textos de ayuda **previos a T7** |
| `README-evidencia-245.md` (misma carpeta externa) | Acuerdo de publicación, límites y pendientes |
| [`odd/tasks/245-email-alerts.md`](../odd/tasks/245-email-alerts.md) (L42–L44) | Confirmaciones humanas registradas y reconciliación |
| Revisión read-only de las ocho imágenes por un explorador independiente | Observaciones por imagen resumidas aquí |
| [`email-alerts.md`](email-alerts.md) | Implementación, checklist de PR y pruebas existentes |

- Las imágenes permanecen fuera del repositorio; aquí se citan solo por su
  nombre de archivo como etiqueta. No se copian, redactan ni publican desde
  esta documentación y no hay enlaces Markdown a rutas personales.
- Los envíos los realizó el usuario; el agente no ejecutó la app ni envió
  correos. No se repiten envíos para preparar esta documentación.
- **Entorno confirmado por el usuario: su Mac local, no una VM.** Este dato
  no está pendiente de confirmar. No se ha acreditado separación de
  configuración, llavero o sesiones personales dentro de ese Mac; esa
  limitación es distinta del entorno local ya confirmado. El
  owner aceptó como **método** de validación (S23–S24) la combinación de
  comprobación manual más HTTP simulado ya existente, sin exigir VM,
  simulación integrada en la app ni tests de Ajustes montado; eso no aprueba
  estas capturas concretas ni este entorno: la evidencia actual y sus huecos
  siguen sujetos a la disposición del owner.
- Versión de macOS, binario realmente en ejecución, commit y fecha de la
  comprobación: **desconocidos**. El HEAD local `3efb171` no acredita el
  binario probado durante las capturas.

## Matriz por captura

| Imagen | Categoría | Observado | Límites |
| --- | --- | --- | --- |
| `1.png` | Observado | Advertencias visibles (disponibilidad, privacidad, sin reintentos, aceptación ≠ entrega), direcciones vacías, consentimiento desmarcado | La clave ya figura como configurada: no es una instalación limpia |
| `2.png` / `3.png` | Observado | Estados casi idénticos: sin consentimiento, campos presentes, clave configurada, direcciones ocultas con mosaico | Estado estático: no demuestra la secuencia de acciones ni el comportamiento de los botones |
| `4.png` | Observado | Consentimiento activo, email automático desactivado, clave configurada; direcciones actuales con mosaico | Nitidez baja; una versión anterior de la imagen mostraba una dirección personal: revisar antes de publicar |
| `5.png` | Observado | Consentimiento activo, email automático desactivado, campo de clave vacío con placeholder «Pega aquí la key»; sin indicador de clave configurada ni botón Quitar visibles | Borrosa; por sí sola no prueba la eliminación de la clave (esa la confirma el usuario) |
| `6.png` | Observado | Feedback rojo exacto: «Resend rechazó remitente, destinatario o dominio (403). Revisa las restricciones de pruebas.» | El **mensaje de resultado** está sanitizado (sin detalles del servidor ni clave); no implica privacidad total de la captura, cuyos campos sí muestran direcciones |
| `7.png` | Observado | Feedback verde exacto: «Solicitud aceptada por Resend» | No muestra el payload recibido por Resend ni permite correlación inequívoca con la recepción |
| `recepcion.png` | Observado | Gmail con remitente `onboarding@resend.dev`, asunto «Quorb: alerta de consumo», cuerpo «Quorb: prueba explícita de email (sin datos de consumo).» | Recepción puntual de una prueba explícita, no un aviso automático ni una garantía de entrega; destinatario y fecha no visibles; el formato real es JPEG pese a la extensión `.png`; la barra lateral de Gmail ya está ausente en la imagen actual (la precaución antigua de recortarla no describe una fuga vigente) |

Todas las capturas de Ajustes (`1.png`–`7.png`) muestran la ayuda **anterior a
T7** (incluido el aviso Linux antiguo con lenguaje técnico), por lo que no
validan visualmente los textos de ayuda actuales; `recepcion.png` es una
captura de Gmail y no muestra ningún panel de Ajustes.

## Matriz de comprobaciones

| Comprobación | Resultado | Categoría | Evidencia |
| --- | --- | --- | --- |
| Advertencias de disponibilidad, privacidad y límites | Observadas | Observado | `1.png` |
| Sin consentimiento, prueba no disponible | Estado visual observado (consentimiento desmarcado); no acredita el comportamiento del botón deshabilitado | Observado (solo visual) | `2.png` / `3.png` |
| Consentimiento activo con email automático desactivado | Estado visual observado | Observado | `4.png` |
| Guardar la configuración no activa el envío | Sin trazabilidad humana específica de este paso aislado; estado estático compatible con la regla y cobertura automatizada existente | No acreditado como comportamiento observado aislado | `4.png` (estado compatible, email automático desactivado); tests existentes de `email.rs`/`email.test.ts` |
| Desactivar email, guardar y reactivar conserva la clave sin reintroducirla | Confirmado | Confirmado por el usuario | Secuencia; sin captura dedicada |
| Cerrar Quorb completamente y reabrir conserva la clave | Confirmado | Confirmado por el usuario | Secuencia; una imagen estática no demuestra el cierre/reapertura |
| Rechazo 403 con feedback rojo sanitizado | Observado | Observado | `6.png` |
| Aceptación con feedback verde, sin prometer entrega | Observado; el usuario confirma que apareció tras una nueva solicitud con campos guardados, sin editar la imagen | Observado + confirmado | `7.png` |
| Recepción puntual del correo de prueba | Observada | Observado | `recepcion.png` |
| Quitar elimina la clave y sigue ausente tras reabrir | Confirmado | Confirmado por el usuario | Confirmación humana; `5.png` es compatible, no demostrativa |
| Campo de clave enmascarado en las capturas revisadas | Observado | Observado | Varias capturas; solo acredita el enmascarado de la UI, no la seguridad completa de los datos guardados |
| Aviso automático con envío real | Sin evidencia | No acreditado | Solo se observó la prueba explícita |
| Validación visual de los textos T7 | Sin evidencia | No acreditado | Capturas previas a T7 |
| Inspección visual en inglés | Sin evidencia | No acreditado | Los tests i18n es/en no equivalen a inspección visual |
| Llavero en Windows | Pendiente del owner | No acreditado | S24; sin acceso a Windows en esta PR |

## Reconstrucción de la comprobación (no una cronología real)

Las capturas cubren estados estáticos, feedback verde/rojo y la recepción, no
una cronología precisa de acciones: el orden real de los pasos y las fechas de
la comprobación del usuario **no están establecidos**. La tabla siguiente es
una reconstrucción para hacer la comprobación repetible, **no instrucciones
para repetir envíos**; no se reenvía nada para documentar. Los envíos fueron
solicitudes **reales del usuario**, ni del agente ni HTTP simulado.

| Paso | Esperado | Fuente/estado |
| --- | --- | --- |
| Abrir Ajustes → Alertas con clave configurada y direcciones vacías | Advertencias visibles | `1.png`; observado (estático) |
| Sin consentimiento marcado | Prueba no disponible visualmente; no acredita el botón deshabilitado como comportamiento | `2.png`/`3.png`; observado (estático) |
| Marcar consentimiento con email automático desactivado | Estado guardado coherente | `4.png`; observado (estático) |
| Desactivar email, guardar y reactivar sin reintroducir la clave | La clave se conserva | Confirmación humana («hice todas las alternativas, incluso cerrando la app»); sin captura de la transición |
| Cerrar Quorb por completo y reabrir | La clave sigue conservada | Confirmación humana; una imagen estática no demuestra el cierre/reapertura |
| Enviar una prueba con datos que provocan rechazo | Feedback rojo 403 sanitizado | `6.png`; observado |
| Nueva solicitud con los campos guardados, sin editar nada | Feedback verde «Solicitud aceptada por Resend» | `7.png`; observado + confirmado por el usuario |
| Comprobar la recepción del correo de prueba | Gmail con remitente/asunto/cuerpo de prueba | `recepcion.png`; observado |
| Pulsar Quitar y reabrir tras cerrar | Clave eliminada y ausente | Confirmación humana; `5.png` compatible, no demostrativa |

Notas:

- El texto explicativo de la UI «Guardar no activa el envío» describe la regla
  de diseño; no equivale a una demostración observada de ese paso aislado.
- Las confirmaciones humanas específicas son: conservación tras
  desactivar/guardar/reactivar, conservación tras cerrar completamente/reabrir,
  y eliminación con Quitar más ausencia tras reabrir.
- `7.png` apareció tras una nueva solicitud del usuario con los campos
  guardados y sin editar la imagen; no hay vínculo inequívoco entre `7.png` y
  `recepcion.png`.
- Cerrar y reabrir acredita persistencia entre procesos, no tras reiniciar
  macOS.

## No acreditado

- Separación de configuración, llavero o sesiones personales dentro del Mac
  local: no acreditada. **La ejecución sin VM sí está confirmada por el
  usuario**; no debe figurar como desconocida. Una VM fue una propuesta del
  agente, no el entorno de estas comprobaciones ni un requisito del owner.
- Versión exacta de macOS, binario/commit en ejecución y fecha de la
  comprobación. El HEAD local conocido no establece el artefacto probado.
- Persistencia tras reiniciar macOS (solo se acredita entre procesos).
- Correlación inequívoca entre `7.png` y `recepcion.png`, destinatario exacto
  o fecha de recepción. Si hiciera falta, consultar el registro existente en
  Resend sin repetir envíos ni compartir la API key.
- Contenido del payload recibido por Resend; `7.png` acredita la pantalla, no
  el mensaje remoto.
- Avisos automáticos con envío real y aceptación ≠ entrega: la recepción
  observada es puntual y no garantiza entregas futuras.
- Seguridad completa de la clave guardada: el campo enmascarado solo acredita
  el ocultamiento en la UI. No se ve ninguna API key en las capturas.
- Validación visual de los textos T7 y de la interfaz en inglés.
- Llavero en Windows: expresamente pendiente del owner (S24).

Las pruebas existentes con HTTP simulado (`email.rs`, `email.test.ts` y afines)
siguen siendo evidencia histórica separada de estas capturas; no se relanzaron
ni se convierten en resultados nuevos.

## Huecos y lista para la publicación

Antes de presentar la PR:

- [ ] Registrar versión de macOS y fecha de la comprobación, o declarar su
      ausencia.
- [ ] Establecer la trazabilidad del artefacto ejecutado (commit/hash) o
      indicar que es desconocida.
- [ ] Revisar `4.png` (versión anterior con dirección personal) y la nitidez
      de `4.png`/`5.png` antes de publicar.
- [ ] Preferir bloques opacos y copias aplanadas al mosaico actual de
      `2.png`/`3.png`/`4.png`/`5.png`; no modificar los originales ahora.
- [ ] Exportar la copia pública de la recepción con extensión coherente con su
      formato (JPEG) y sin barra lateral de Gmail.
- [ ] Capturar los textos de ayuda T7 (sin repetir envíos) si se quiere
      validar visualmente la ayuda actual.
- [ ] Dejar la comprobación de Windows expresamente para el owner (S24).
- [ ] Adjuntar las copias anonimizadas en el cuerpo de la PR, no como binarios
      en el historial de Git, y enlazar este documento desde la PR.
- [ ] No cerrar #245 hasta resolver los pendientes y la decisión del owner.

## Referencias

- [`email-alerts.md`](email-alerts.md): implementación, checklist de PR y
  pruebas automatizadas.
- [`odd/tasks/245-email-alerts.md`](../odd/tasks/245-email-alerts.md): alcance
  vigente, S23–S24 y S27, registro L42–L44.
- `README-evidencia-245.md` y las imágenes: carpeta externa `quorb_screenshots`
  del usuario, fuera de Git.
