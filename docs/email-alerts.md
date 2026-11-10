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

## Verificación de credenciales

Los tests deterministas usan resultados sintéticos: ausencia, valor vacío,
lectura válida y fallo del backend. No requieren claves reales ni envían correo.
Los smokes de llavero reales mantienen sus restricciones de aislamiento; no son
prueba de persistencia validada en todos los sistemas operativos.
