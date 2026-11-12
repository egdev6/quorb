# Sistema de diseño — Quorb (EGDEV Foundation)

Sincronizado desde las fuentes reales del proyecto. **No editar el código fuente**: este
documento sólo registra lo que hay en los archivos citados.

- Fuentes leídas: `src/ds/egdev/tokens.css` (tokens), `src/styles.css` (variables de app y
  paleta de anillos), `src/theme.css` (componentes EGDEV), `src/components/*.tsx` (marcado real
  de `ProviderCard`, `MeterBar`, `ProviderGauge`, `ProviderDetails`).

## Colores

### Superficies y texto — `src/ds/egdev/tokens.css`
| Token | Valor | Uso |
| --- | --- | --- |
| `--color-surface-0` | `#141518` (graphite-950) | Fondo más profundo: barras de progreso, sparkline, código |
| `--color-surface-1` | `#1B1C20` (graphite-900) | Fondo de tarjeta (`--color-bg-surface`) |
| `--color-surface-2` | `#232428` (graphite-850) | Chips, filas, superficies elevadas |
| `--color-surface-3` | `#2D2E33` (graphite-750) | Superficie de hover |
| `--color-fg-default` | `#FFFFFF` | Texto principal |
| `--color-fg-secondary` | `#CCCCCC` | Texto secundario |
| `--color-fg-muted` | `#A1A2A8` (graphite-400) | Metadatos, ejes, rótulos de estado |
| `--color-border-default` | `#2A2B30` (graphite-800) | Borde de tarjeta |
| `--color-border-hairline` | `rgba(255,255,255,0.08)` | Separadores internos |

### Marca y estado — `src/ds/egdev/tokens.css`
| Token | Valor | Uso |
| --- | --- | --- |
| `--color-fg-brand-default` / `--ring-1` | `#FF0036` | Rojo de marca: anillo 1, foco, barra principal |
| `--ring-2` | `#FFFFFF` (`src/styles.css:17`) | Anillo 2 / marca 2 (segundo límite de la cuenta) |
| `--ring-3` | `#FF8FA6` (`src/styles.css:18`) | Anillo 3 / marca 3 (tercer límite) |
| `--color-status-success` | `#2DE2C4` | Sin uso en medidores; reservado |
| `--color-status-warning` | `#FFB224` | Aviso: umbral 90 %, suscripción inactiva |
| `--color-status-danger` | `#FF6680` (red-300) | Agotado (100 %), halo `.eg-gauge.is-over` |
| `--color-status-info` | `#8AB4FF` | Informativo |
| `--color-focus-ring` | `#FF0036` | Anillo de foco |

### Superficies de color — `src/ds/egdev/tokens.css`
`--color-alpha-white-07/08` (relleno sutil), `--color-alpha-red-10/12/18` (marca sutil, hover de
botón primario), `--color-bg-brand-subtle` (`alpha-red-10`), `--color-bg-scrim` (negro).

## Tipografía — `src/ds/egdev/tokens.css`
| Token | Pila | Uso |
| --- | --- | --- |
| `--font-display` | `"Barlow Condensed", "Arial Narrow", sans-serif` | Títulos de módulo en mayúsculas (`src/theme.css:111`) |
| `--font-sans` | `"Barlow", system-ui, sans-serif` | Texto de la interfaz; 15 px en Ajustes (`src/theme.css:16`) |
| `--font-mono` | `"JetBrains Mono", ui-monospace, monospace` | Códigos y JSON |

Pesos y tamaños en uso: rótulo de medidor 14 px (`src/theme.css:128`), metadatos 12 px
(`src/theme.css:132`), valor del medidor con `font-variant-numeric: tabular-nums`
(`src/theme.css:130`), título de módulo 20 px display 800 en mayúsculas (`src/theme.css:111`),
título de sección del panel `700 16px/1.3 var(--font-sans)` (`src/theme.css:135`).

## Espaciado — `src/ds/egdev/tokens.css`
Escala `--space-*`: 0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96 px.
Uso observado: gap 8 px en la fila del medidor (`src/theme.css:128`), gap 12/16 px entre
bloques del panel, `--content-max: 1280px` y `--gutter: clamp(16px, 4vw, 40px)`.

## Radios — `src/ds/egdev/tokens.css`
`--radius-none:0`, `--radius-sm:4`, `--radius-md:12`, `--radius-lg:16`, `--radius-xl:22`,
`--radius-2xl:24`, `--radius-full:9999`.
Uso: píldoras para chips y botones (`src/theme.css:113`, `:214`), `--radius-md` en campos y
listas (`src/theme.css:252`), `--radius-lg` en módulos (`src/theme.css:326`).

## Sombras — `src/ds/egdev/tokens.css`
`--shadow-elev-1/2/3` (elevación de paneles), `--shadow-well` (inset: campos y barras vacías),
`--shadow-card` (tarjeta de cristal con borde de marca), `--shadow-glow-base/active/intense`
(marca encendida), `--shadow-focus: 0 0 0 2px #141518, 0 0 0 4px #FF0036` (foco visible),
`--shadow-edge` (borde superior sutil), `--shadow-hot` (marca caliente).

## Reglas de componente

- **Orbe (`ProviderGauge.tsx` + `src/theme.css:19-26,66-72`)**: botón circular con el logo al
  centro (28 % de inset) y hasta **tres anillos concéntricos**; el color va en `--c`
  (`--ring-1/2/3` por posición, `src/theme.css:19-21`). Estados del orbe (`ProviderGauge.tsx:16-21`):
  `is-over` (≥100 %, halo rojo `src/theme.css:26`), `is-warning` (≥90 % o informe en aviso),
  `muted` (error / sin credencial / sin configurar).
- **Medidor del panel (`MeterBar.tsx` + `src/theme.css:28-35,128-132`)**: fila con marca de
  color (`eg-gauge__key`, con modificadores `--2`/`--3`), etiqueta a la izquierda, valor a la
  derecha (`tabular-nums`), barra `eg-progress--lg` con relleno `--p` (0-1) y color por
  `--meter-color`, y línea de metadatos (importe + "Se reinicia en…") en 12 px atenuado.
  **Un medidor sin `percent` no dibuja barra** y muestra sólo el importe.
- **Barra de ritmo (`ProviderDetails.tsx:32-44`)**: pista con relleno = consumido, marca vertical
  = tiempo transcurrido, y estado por atributo (`data-status`: `ok`/`fast`/`over`).
- **Aviso (`eg-notice--warning`, `ProviderDetails.tsx:137-152`)**: borde/superficie
  `--color-alpha-red-12`, icono de alerta, texto con la palabra clave en negrita.
- **Chip de plan (`ProviderCard.tsx:66-67`)**: neutro, píldora `--radius-full`.
- **Gráfico diario (`ProviderDetails.tsx:66-99`)**: barras en `var(--ring-1)` dentro de un SVG
  con eje y rótulos en 12 px atenuado.
- **Tipografía de los números**: siempre `tabular-nums`.

## Límites conocidos (para maquetas y para el código)

- El orbe **dibuja como máximo 3 anillos**, y en compacto (orbe pequeño) **sólo el de mayor
  consumo** (`ProviderGauge.tsx:86`).
- La paleta de NaN es **posicional**: el color de cada anillo depende del orden en que el
  backend entregue los medidores (`src/lib/meter-colors.ts:7`).
- Los textos de "Tokens por día" están **escritos a mano** en el catálogo
  (`src/i18n/es.ts:474`, `src/i18n/en.ts:450`): no derivan de la unidad del medidor.
