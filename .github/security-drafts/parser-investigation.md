# Investigación acotada: cobertura de parseo de Semgrep 1.180.0

**Investigación concluida; señal candidata respaldada.** Mantener el bloqueo del runner y de su activación en CI.
Resultado y límites: [informe revisado](parser-investigation-report.md).
Buscar una señal verificable de parseo completo para el alcance JS/TS aprobado;
no sustituirla por `exit 0`, `errors: []`, ausencia de hallazgos o una lista de archivos.

## Punto de partida

- Job 64: falló la expectativa de rechazo de `const … = ;`; Node confirmó sintaxis inválida sin ejecutarla.
- Jobs 65 y 66: cuatro archivos, tres malformados y un control positivo, dieron exit 0,
  `errors: []` y un hallazgo válido, tanto con optimizaciones por defecto como desactivadas.
- Esto no demuestra AST completo, pero tampoco un error ocultado por nuestro wrapper.
- El wheel fijado despacha por defecto al CLI nativo; la ruta Python legacy no basta como prueba.

## Preguntas que deben resolverse

1. ¿Qué ruta nativa procesa estos archivos y convierte errores del parser en salida JSON/exit status?
2. ¿Hay recuperación, nodos ausentes, filtros o descarte de diagnósticos? ¿Qué evidencia lo distingue?
3. ¿Existe una señal por archivo que permita rechazar parseo parcial o desconocido antes de declarar éxito?

No se presupone que la causa sea tolerancia, optimización o un bug. Una coincidencia AST aislada
no prueba cobertura completa; una ausencia de coincidencia tampoco prueba un fallo del parser.

## Presupuesto y secuencia

| Fase | Límite | Entregable |
|---|---|---|
| Lectura | Hasta 6 archivos fuente relevantes / 1.500 líneas, más una consulta de índice para localizarlos | Mapa de ruta nativa y diagnósticos con referencias verificables |
| Diseño | Una matriz de hasta 6 fixtures inertes | Para cada caso: hipótesis, señal esperada y qué resultado la refuta |
| Prueba condicional | Un job offline, hasta 6 invocaciones fijadas y 180 s de presupuesto total | Metadatos saneados, exits y comparación de señales |
| Revisión | Una revisión independiente del informe | Suficiente, insuficiente o indeterminado, con razones |

Leer el código upstream asociado al tag `v1.180.0`, registrando su commit resuelto y procedencia.
Contrastar con el wheel cuyo SHA ya está fijado; un tag, un texto fuente o el número de versión
no prueban por sí solos equivalencia con el binario. Cualquier brecha de procedencia queda explícita.
No descargar repositorios completos, nuevos binarios, paquetes ni motores alternativos.

La prueba solo se ejecuta si la lectura identifica una señal concreta y una interfaz utilizable
en el artefacto existente. Antes de lanzarla, fijar comandos, entradas, expectativas y criterio de parada.
Si no hay señal o se agota la lectura, terminar con «evidencia insuficiente»: no encadenar probes.
Un timeout o fallo se registra; no se repite ni se cambia de motor o configuración a ciegas.

## Seguridad y límites

- Usar únicamente el runtime y wheelhouse locales ya verificados; sin red durante la ejecución.
- Conservar aislamiento, límites, mounts read-only y cleanup del runner; no ejecutar las fuentes de prueba.
- Capturar solo metadatos necesarios: versión, hashes, estado por archivo, tipos de diagnóstico y exits.
- No publicar AST, snippets, mensajes crudos ni datos del repositorio; los fixtures son desechables e inertes.
- No modificar checker, reglas, runner, política ni workflows en esta investigación.
- No añadir validación sintáctica completa como requisito implícito ni tratarla como equivalente a cobertura AST.

## Criterio de cierre

**Señal candidata suficiente:** evidencia trazable que distinga parseo completo de parcial/desconocido
por cada objetivo JS/TS, con controles positivos y negativos que ejerzan esos estados y revisión independiente.
Si solo funciona para una parte del alcance, no se considera suficiente para cerrar el conjunto.
Los fixtures son evidencia de comportamiento acotado, no una prueba universal ni un certificado de seguridad.

**Insuficiente o indeterminada:** mantener el bloqueo y presentar el hueco exacto. No degradar a aviso,
no asumir que `scanned` significa AST completo y no aceptar la garantía limitada sin una nueva decisión humana.

Incluso con señal suficiente, implementar su consumo y sus regresiones sería una fase posterior.
Este informe no autoriza cerrar el runner automáticamente, activar CI, cambiar de motor ni publicar.

## Estado de autorización

El usuario aprobó este presupuesto y se completó dentro de sus límites.
La revisión independiente respalda una señal candidata, no la implementación ni la activación.
Cualquier fase para incorporar ese control requiere autorización nueva; no se modifica ni publica el runner aquí.
Contexto y estado general: [plan de integración](integration-plan.md).
