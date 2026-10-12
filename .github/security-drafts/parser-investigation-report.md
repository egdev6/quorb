# Investigación de cobertura: evidencia y límites

**Investigación concluida: señal candidata suficiente para diseñar una integración posterior.**
La revisión independiente respalda ese alcance, no el cierre del runner ni la activación de CI.
`show dump-ast` discriminó los seis controles; no certifica todo JavaScript/TypeScript ni la cobertura global.

## Procedencia y presupuesto

- Tag upstream `v1.180.0` resuelto a `a35fe8306115b3e55274969098cc46f8451d6b4d`.
- Una consulta de índice; cinco fuentes y 1.466 líneas completas de las 1.500 aprobadas.
- Bytes de cada fuente contrastados con su blob Git del índice; SHA-256 registrados en el ledger local.
- Wheel probado: Semgrep 1.180.0, SHA-256 `16db2e2706ab814a975eeec25debfad49abba846b7c513d88e041447152f8447`.
- Runtime fijado: Python 3.12.15, manifiesto OCI `2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d`.
- No hay prueba de build reproducible o atestación que equipare ese código fuente con el wheel.
  La coincidencia de versión y el comportamiento experimental no sustituyen esa procedencia.

## Lecturas realizadas

Enlaces al commit resuelto, no a una rama móvil:

| Fuente | Líneas | Evidencia relevante |
|---|---:|---|
| [Parse_target.ml](https://github.com/semgrep/semgrep/blob/a35fe8306115b3e55274969098cc46f8451d6b4d/src/parsing/Parse_target.ml) | 298 | JS: Tree-sitter TSX con fallback Pfff; TS: Tree-sitter. Existen variantes estrictas que incluyen errores tolerados. |
| [Parsing_result2.ml](https://github.com/semgrep/semgrep/blob/a35fe8306115b3e55274969098cc46f8451d6b4d/src/parsing/Parsing_result2.ml#L20-L67) | 73 | Representa `errors`, `tolerated_errors`, `skipped_tokens` e `inserted_tokens`; distingue ERROR de MISSING. |
| [Show_subcommand.ml](https://github.com/semgrep/semgrep/blob/a35fe8306115b3e55274969098cc46f8451d6b4d/src/osemgrep/cli_show/Show_subcommand.ml#L157-L193) | 289 | `DumpAST` devuelve éxito solo si esas cuatro listas están vacías; de lo contrario, `invalid_code`. |
| [Show_CLI.ml](https://github.com/semgrep/semgrep/blob/a35fe8306115b3e55274969098cc46f8451d6b4d/src/osemgrep/cli_show/Show_CLI.ml#L221-L242) | 482 | `show dump-ast [LANG] FILE`; sin LANG infiere por extensión. |
| [Pfff_or_tree_sitter.ml](https://github.com/semgrep/semgrep/blob/a35fe8306115b3e55274969098cc46f8451d6b4d/src/parsing/Pfff_or_tree_sitter.ml#L103-L266) | 324 | MISSING no se considera error serio; se conserva como tolerado. Describe selección de parser/fallback y resultados parciales. |

No se leyó la ruta completa de transformación de errores de `scan` a JSON; no se atribuye
la causa definitiva de los jobs 64–66 a una instrucción concreta no inspeccionada.
La señal candidata añade algo distinto de `errors: []` y `paths.scanned`, sin sustituir el scanner.

## Prueba congelada antes de ejecución

Un job offline, hasta seis invocaciones y 180 segundos totales. Misma imagen y wheelhouse verificados;
ninguna descarga, cambio de motor, retry o variante posterior a un resultado inesperado.

Comando por caso: `/tmp/venv/bin/semgrep show dump-ast /inputs/<archivo>`.
Se descarta stdout del AST; stderr solo se usa para booleanos de etiquetas, nunca se imprime ni persiste.
La instalación offline y la versión del paquete se verifican sin consumir invocaciones extra de Semgrep.

| Caso | Entrada inerte | Expectativa fijada |
|---|---|---|
| valid.js | `const x = 1;` | Exit 0 |
| valid.ts | `const x: number = 1;` | Exit 0 |
| missing.js | `const x = ;` | Exit no cero |
| missing.ts | `const y: number = ;` | Exit no cero |
| partial.js | `class {` | Exit no cero |
| partial.ts | `class {` | Exit no cero |

Los controles válidos van primero. Un fallo de control válido, timeout o setup detiene la prueba.
Cualquier resultado inesperado deja evidencia insuficiente; no se cambia la expectativa después.

## Resultado y revisión

Job 70: exit 0, seis invocaciones, 10,817 segundos totales; sin retries ni cambios de matriz.
Los controles `valid.js` y `valid.ts` dieron exit 0. Los cuatro casos `missing.*` y `partial.*`
dieron exit 3. Se cumplieron todas las expectativas fijadas antes de ejecutar.
El contenedor y los directorios temporales fueron eliminados. AST y stderr crudos no se conservaron.
Las etiquetas de diagnóstico presentes no permiten afirmar que las cuatro listas fueran no vacías.

Metadatos reproducibles y fixtures inertes: [evidencia](parser-investigation-evidence.json).
Revisión independiente `mv4g2glr-p-l49l`: **candidata suficiente para una fase posterior autorizada**,
no runner listo ni aprobación de CI. Contrastó fuentes, hashes, matriz, script y resumen sin repetir la ejecución.
Presupuesto final: una consulta de índice, cinco fuentes/1.466 líneas, un job/seis invocaciones, 10,817 segundos.
No se consumen nuevas lecturas ni pruebas en esta fase.

Cautelas de la revisión:
- El valor observado es exit 3; su asociación numérica con `invalid_code` no se verificó en otro archivo fuente.
- La matriz fue escrita antes de lanzar el job, pero su hash se calculó después: no es un sellado criptográfico previo.
- Los argv ejecutados coinciden con la plantilla, aunque el script no los deriva automáticamente de ella.
- La limpieza está registrada por el propio harness; no hay una atestación independiente del host.

## Límites y decisión

- No se ha demostrado completitud universal del parser ni corrección de toda la gramática JS/TS.
- La matriz cubre `.js` y `.ts`, no certifica cada extensión o construcción admitida por el exportador.
- `dump-ast` tendría que comprobarse por cada objetivo y enlazarse al mismo hash y dialecto usado al escanear.
- Los errores de ejecución o estados desconocidos deben bloquear; no se convierten en ausencia de hallazgos.
- Incluso una señal candidata respaldada requiere otra fase de diseño, implementación y regresiones.
- El bloqueo humano vigente no se levanta automáticamente con este informe; CI y publicación siguen sin autorizar.

Contexto: [plan aprobado](parser-investigation.md) y [plan de integración](integration-plan.md).
