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

El payload incluye únicamente el sobre (remitente/destinatario), asunto fijo y
texto de proveedor, medidor, ventana, porcentaje y tipo de evento. No incluye
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

## Verificación de credenciales

Los tests deterministas usan resultados sintéticos: ausencia, valor vacío,
lectura válida y fallo del backend. No requieren claves reales ni envían correo.
Los smokes de llavero reales mantienen sus restricciones de aislamiento; no son
prueba de persistencia validada en todos los sistemas operativos.
