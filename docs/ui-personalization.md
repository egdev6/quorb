# Personalización inmediata de la tira

Los controles de aspecto de **Ajustes › Apariencia** y **Ajustes › Tira** se
aplican al momento y se guardan solos: no hace falta pulsar **Guardar cambios**.

## Qué se aplica al momento

Ocho campos, y solo estos:

| Control | Campo | Límite (lo fija el backend) |
|---|---|---|
| Tamaño del anillo | `orbSize` | 32–80 px |
| Color base | `accentColor` | `#rgb` o `#rrggbb` |
| Opacidad de la tira y el panel | `opacity` | 0.3–1.0 |
| Círculos pequeños | `compact` | sí/no |
| Borde | `dockEdge` | `top` \| `bottom` \| `left` \| `right` |
| Posición en el borde | `dockOffset` | 0.0–1.0 |
| Ocultar sola | `autoHide` | sí/no |
| Siempre encima | `alwaysOnTop` | sí/no |

Cada cambio se envía al backend, que **normaliza y persiste** el valor de forma
atómica. La respuesta canónica (ya saneada) es la que manda.

## Qué NO se aplica al momento

El resto del formulario sigue esperando a **Guardar cambios**: cuentas y
proveedores, avisos, atajos, rutas de credenciales (incluidas las de WSL, que
por ahora se editan y guardan a mano) e **Inicio con Windows**, que es un flujo
aparte con su propia confirmación del sistema operativo.

## Por qué no ensucia «Guardar cambios»

Los ocho campos vivos no cuentan como cambios manuales sin guardar. Así el
botón **Guardar cambios** refleja solo lo que de verdad espera confirmación, ni
mientras un autoguardado está en vuelo ni si falló.

## Errores recuperables (sin éxito falso)

- Si el guardado falla, el valor que ves en pantalla se conserva, aparece el
  error y un enlace **Reintentar** que reenvía exactamente el mismo cambio. No
  se muestra «Guardado ✓» por algo que no se confirmó.
- **Siempre encima** puede guardarse y, aun así, no aplicarse al sistema (por
  ejemplo, si Windows rechaza la petición). En ese caso se conserva lo
  persistido y se avisa del fallo nativo: no se promete deshacer nada y el
  reintento vuelve a aplicar el efecto.

## Colores y visibilidad

Los anillos y las barras de consumo mantienen el color elegido y sus tonos
derivados. El aviso conserva su halo ámbar y el exceso su halo de peligro,
independientes del acento; los logos no cambian. Las bandas del panel heredan
su contorno redondeado sin recortar el foco ni la altura natural. Como la
ventana acaba en el panel, conserva solo su sombra de borde interior: la
elevación exterior recortada dejaría píxeles oscuros en las esquinas. Las
sombras de los círculos y los efectos de foco no cambian.

El bloque «Círculos ocultos» ya no aparece. No se borra `hiddenProviders`
al abrir Ajustes. Para recuperar un círculo oculto, activa **Mostrar en el
widget** en su cuenta y pulsa **Guardar cambios** (en las APIs de gasto, el
control es **Mostrar gasto del mes**). Solo se recupera esa cuenta, también
si es adicional; las demás ocultaciones no cambian. Sigue siendo un cambio
manual, no una personalización inmediata.

## Al cerrar la ventana

Cerrar **Ajustes** con la X o con **Cerrar** espera a que se envíe el último
cambio pendiente antes de destruir la ventana. Si ese envío falla, la ventana
no se cierra: verás el error y el reintento para no perder el cambio en
silencio. La capacidad `settings-close` permite al SDK finalizar ese cierre
solo desde el contexto de la ventana `settings`; no añade el permiso a las
otras ventanas.

Queda como límite conocido que **salir desde la bandeja**, matar el proceso o
un cierre inesperado no pueden garantizar ese envío final; es el único caso en
que un cambio hecho en el último instante podría no guardarse.

## Geometría de la tira

El borde, la posición, **Círculos pequeños** y **Ocultar sola** se siguen
resolviendo con la geometría nativa del dock (misma matemática de siempre): la
tira no se mueve al plegarse para mostrar la franja, y el arrastre del asa sigue
pegándose al borde más cercano y guardándose igual.
