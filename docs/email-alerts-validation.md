# Validación de avisos por email (#245)

Esta guía describe cómo presentar la validación de
[#245](https://github.com/egdev6/quorb/issues/245). **La checklist ejecutada,
los resultados, la procedencia y las capturas de cada comprobación pertenecen
a la PR**, como pidió el owner en su
[respuesta sobre validación](https://github.com/egdev6/quorb/issues/245#issuecomment-6716512919).
Este documento conserva el procedimiento y sus límites, no el informe de una
ejecución concreta ni un inventario de imágenes locales. **Windows y Linux
siguen pendientes de validación por un compañero; se solicitará en la PR.**
No se declara cerrada #245.

## Dónde va cada evidencia

| Lugar | Contenido |
| --- | --- |
| Repositorio | Esta guía y la [documentación de email](email-alerts.md): comportamiento esperado, procedimiento y criterios de interpretación |
| Cuerpo de la PR | Checklist con resultados por comprobación, entorno y artefacto probado, límites, pendientes y capturas adjuntas con títulos descriptivos |
| Adjuntos de la PR | Copias revisadas para publicación, visibles junto a la comprobación correspondiente; no binarios incorporados al historial Git |

La PR debe enlazar esta guía. No es necesario añadir al repositorio las
imágenes, sus URL ni un commit posterior dedicado a enlazarlas. Los nombres
de archivos o rutas de una carpeta local no sirven como referencia pública
de evidencia: en la PR, cada captura debe verse junto a su explicación.

## Método acordado

El owner acepta comprobación manual más pruebas automatizadas con HTTP
simulado. La lógica de interruptores se comprueba con funciones puras/gates
y sus tests; la comprobación manual cubre lo visual, el cableado y el almacén
real de credenciales por plataforma. Los tests de Ajustes montado quedan
fuera de esta issue; no se exige una VM ni simulación integrada en la app.

Consultar la [checklist de implementación](email-alerts.md#checklist-de-comprobación-manual-pr-245)
para las reglas y la cobertura automatizada, con sus límites. Los resultados
automatizados y manuales se presentan por separado: ninguno sustituye al otro.

## Preparar el informe de la PR

1. Registrar sistema operativo y versión, entorno utilizado y separación de
   estado/credenciales efectivamente comprobada. No afirmar aislamiento por
   usar una VM o cambiar `HOME`; tampoco confundir ejecución local con
   aislamiento acreditado.
2. Identificar el commit y el comando o artefacto usado para cada grupo de
   comprobaciones. Distinguir confirmación humana de identificación observada
   del binario. El HEAD actual no demuestra qué artefacto se ejecutó antes.
3. Indicar fecha cuando se conozca, idioma, alcance de cada captura y si muestra
   textos anteriores a un cambio posterior de interfaz. No atribuir evidencia
   antigua a una interfaz nueva ni deducir una secuencia por la numeración.
4. Para cada comprobación, anotar acción, resultado esperado, resultado obtenido,
   categoría de evidencia y límites. Una captura estática no demuestra por sí
   sola la transición de estado que la precedió.
5. Insertar las capturas necesarias en la PR, con títulos como «Ayuda del
   remitente», «Prueba sin consentimiento», «Clave ausente», «Rechazo 403» o
   «Solicitud aceptada». Evitar duplicados visuales sin borrar los originales.
6. Dejar explícitos los puntos pendientes y quién debe comprobarlos. No marcar
   toda la validación como completada por disponer de capturas o tests correctos.

### Categorías de evidencia

| Categoría | Qué permite afirmar |
| --- | --- |
| Observado | Lo visible en una imagen o lo medido en una ejecución identificada, sin inferir acciones anteriores ni efectos no observados |
| Confirmado por quien realizó la comprobación | Secuencias, entorno o procedencia declarados por esa persona; no presentarlos como medición independiente |
| No acreditado / pendiente | Lo que no se comprobó o no puede deducirse de la evidencia disponible; indicar su alcance y responsable cuando corresponda |

## Checklist para presentar en la PR

Esta lista es una plantilla, **no un resultado de ejecución**. Completarla en
la PR con resultados y evidencias; si una comprobación es parcial o no se
realizó, declararlo en lugar de marcarla como aprobada.

- [ ] Advertencias visibles de disponibilidad, privacidad, ausencia de reintentos
      y aceptación distinta de entrega; ayudas de remitente y prueba en el
      idioma inspeccionado. El aviso Linux se comprueba en su plataforma.
- [ ] Consentimiento y disponibilidad del botón de prueba, sin confundir el
      aspecto estático del control con una interacción ejecutada.
- [ ] Guardar sin activar email; desactivar, guardar y reactivar conservando la
      clave; cerrar completamente y reabrir conservándola, sin reintroducirla.
- [ ] Clave enmascarada; Quitar y ausencia tras reabrir. Indicar qué pasos se
      observaron y cuáles fueron confirmados por quien los realizó.
- [ ] Feedback de aceptación/error visible y sanitizado, separando evidencia
      visual de resultados con HTTP simulado. Aprovechar evidencia existente:
      esta guía no pide repetir envíos reales para obtener capturas.
- [ ] Resultados automatizados identificados por candidato y alcance, sin
      presentarlos como prueba del llavero real o interacción de UI montada.
- [ ] Windows: guardado, conservación y eliminación de clave con su almacén del
      sistema e inspección de la interfaz. Solicitar validación por un compañero
      en la PR; se conserva el acuerdo de comprobación del owner (S24).
- [ ] Linux: interfaz y almacenamiento real, con backend efectivo y límites
      registrados. Si se comprueba persistencia tras reiniciar, distinguirla
      de cerrar/reabrir la app. La limitación conocida de keyutils sigue en
      #106; validarla no amplía esta issue para resolverla.
- [ ] Dejar Windows y Linux pendientes hasta que un compañero aporte sus
      resultados en la PR; las pruebas macOS o con almacenes sintéticos no
      sustituyen estas comprobaciones.
- [ ] Límites y pendientes transparentes, sin declarar cerrada #245 mientras
      falten las comprobaciones requeridas y la disposición del owner.

## Privacidad e interpretación

- Revisar las copias antes de adjuntarlas: sin claves, direcciones personales,
  cuentas, sesiones u otros datos ajenos a la comprobación. Preferir bloques
  opacos y exportación aplanada al mosaico; conservar los originales sin cambios.
  Un mensaje de error sanitizado no vuelve anónima toda la imagen.
- Usar extensión coherente con el formato real de la copia publicada y evitar
  elementos personales de otras aplicaciones, barras laterales o notificaciones.
- «Solicitud aceptada por Resend» no demuestra entrega en el buzón. Una
  recepción puntual de prueba no acredita un aviso automático, futuras entregas
  ni una correlación inequívoca con otra captura de aceptación.
- Cerrar y reabrir comprueba persistencia entre procesos, no tras reiniciar el
  sistema operativo. El campo enmascarado no demuestra la seguridad completa
  del almacén.
- No repetir envíos, arrancar la app contra datos personales ni instalar nuevas
  herramientas por el solo hecho de preparar el informe. Cualquier ejecución
  adicional debe respetar su alcance y autorizaciones.
