# Avisos por email con Resend

Implementación incremental de [#245](https://github.com/egdev6/quorb/issues/245).
El alcance vigente y la evidencia de cada unidad están en
[`odd/tasks/245-email-alerts.md`](../odd/tasks/245-email-alerts.md).

## Credenciales

La clave `resend_api_key` usa el almacén seguro y los comandos de secretos
existentes. No se guarda en JSON ni se devuelve su valor al frontend. No hay
fallback a texto plano. Resend no es un proveedor de consumo ni una cuenta extra.

El lector exclusivo de email distingue una clave ausente o vacía de un fallo de
lectura del almacén. Los fallos se comunican sin diagnósticos internos del backend.
No cambia `secrets::get()` ni la lectura o migración de los proveedores existentes.

**Linux:** si el backend efectivo es keyutils, la clave puede no sobrevivir a un
reinicio. La validación y resolución de ese almacenamiento pertenece a #106, no
a esta integración.

## Configurar y probar en Ajustes → Alertas

1. Lee las advertencias de disponibilidad, privacidad y límites del correo.
2. Introduce remitente y destinatario y guarda tu API key mediante el campo
   oculto de Resend. No se puede recuperar el valor guardado desde la interfaz.
3. Marca el consentimiento explícito. Guardar por sí solo no habilita email.
4. Si quieres, pulsa **Enviar prueba**: guarda la configuración del formulario
   y hace una única solicitud de prueba sin datos de consumo. No activa email
   y funciona aunque Alertas global esté desactivado. Si guardar falla, no envía.
5. Para avisos automáticos, activa tanto email como Alertas global y guarda.
   Desactivar la notificación nativa no desactiva el email.

El resultado sanitizado más reciente se muestra en Ajustes, también cuando
proviene de un aviso automático. Revocar consentimiento desmarca la activación
en el formulario; el backend exige consentimiento en cualquier envío.
Los cambios de configuración se aplican al guardarlos. Desactivar email conserva
la clave; **Quitar** elimina la clave del almacén e impide nuevas solicitudes.
Una solicitud que ya empezó no puede retirarse de Resend.

## Frontera de envío

El envío usa `POST https://api.resend.com/emails` exclusivamente desde Rust,
con la clave en `Authorization: Bearer`. No amplía la CSP ni admite un endpoint
configurable. Un intento usa un cliente nuevo, HTTP/1, sin redirecciones ni
reintentos, con timeout de 10 segundos; no hay cola ni replay.

La configuración no secreta en `alerts.email` contiene `enabled`, `consent`,
`sender` y `recipient`, inicialmente desactivados/vacíos. Se admiten direcciones
simples, sin nombre visible ni listas. Guardar direcciones no activa email.
Ambos interruptores (Alertas y email) y el consentimiento son necesarios para
avisos automáticos; la notificación nativa es independiente. La prueba explícita
requiere consentimiento y configuración válida, pero no los interruptores.

El remitente lo introduce el usuario: el remitente de pruebas de Resend sirve
para el email de su propia cuenta; para otros destinatarios necesita un dominio
verificado y un remitente autorizado. Quorb no proporciona un remitente fijo.

El payload incluye únicamente el sobre (remitente/destinatario), asunto y
texto de proveedor, medidor, ventana, porcentaje y tipo de evento según el
idioma configurado (es/en; el inglés conserva los literales originales). No incluye
nombres/identificadores de cuentas, etiquetas configurables, informes completos,
prompts, código ni sesiones. Resend procesa también las direcciones personales.
La prueba no incluye datos de consumo. El último estado vive solo en memoria;
no se guardan eventos ni payloads. La API no devuelve claves ni respuestas crudas.

El estado aceptado significa **Solicitud aceptada por Resend**, no entrega en
la bandeja de entrada. Fallos de autenticación (401), remitente/destinatario o
dominio (403), petición (otros 4xx), límite (429) y servicio (5xx) se distinguen
sin mostrar la respuesta del servidor. Un error de transporte/timeout deja la
aceptación incierta y nunca provoca un reintento automático.

Referencia de protocolo: [Send Email](https://resend.com/docs/api-reference/emails/send-email)
y [Errors](https://resend.com/docs/api-reference/errors). Solo se consultó la
documentación: no se hicieron envíos reales.

## Identidad, memoria y avisos automáticos

El widget pasa a email exactamente los eventos emitidos por `detectAlerts`,
después de actualizar su memoria existente y lanzar los avisos locales. La
identidad sigue siendo proveedor (incluida su cuenta local), medidor,
`windowKey(resetsAt)` y tipo (umbral o reinicio). No se añade otro deduplicador,
registro persistente, cola ni memoria para email.

Un umbral ya recordado no se reenvía al repetir el sondeo, traducir una etiqueta,
fallar Resend o activar email más tarde. Una ventana nueva puede emitir otro
aviso. Los reinicios conservan la detección de transición existente entre el
informe anterior y el nuevo; no se crea un registro remoto de reinicios. Se
conserva la limpieza de memoria y la compatibilidad de claves antiguas del
aviso local. No se promete deduplicación remota tras borrar/perder esa memoria,
ni entrega exactamente una vez.

La cuenta se usa solo para identidad local: al enviar se proyecta el proveedor
base, sin sufijo de cuenta, nombre personal ni etiqueta configurable. El medidor
exportado usa solo el ID real del informe si cumple `[a-z0-9_]{1,64}`; si falta
o no cumple ese formato, se representa como `usage`. Nunca se exporta el
fallback local a la etiqueta, aunque parezca un ID válido (por ejemplo,
`alice_private`). La etiqueta sigue formando parte de la identidad, memoria
y texto locales de los medidores legacy sin ID; esos comportamientos no cambian.

Los fallos remotos no bloquean notificaciones ni efectos y no pasan por el
mecanismo de reintentos de lectura de consumo. Cada evento emitido causa como
máximo una llamada al envío, con ambos interruptores, consentimiento y
configuración válidos. El backend vuelve a comprobar los permisos de envío y
la presencia de la clave al atender la solicitud.

## Verificación de credenciales

Los tests deterministas usan resultados sintéticos: ausencia, valor vacío,
lectura válida y fallo del backend. No requieren claves reales ni envían correo.
Los smokes de llavero reales mantienen sus restricciones de aislamiento; no son
prueba de persistencia validada en todos los sistemas operativos.
