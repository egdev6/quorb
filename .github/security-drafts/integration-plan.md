# Integración por áreas y commits revisables

Estrategia aprobada: tres áreas funcionales entregadas como commits locales encadenados y revisados.
Los commits locales están autorizados; push, PR, merge y activación requieren decisiones separadas.
Las secciones técnicas conservan la secuencia histórica de investigación y pruebas; el estado actual
se resume en «Estado de entrega». Un pendiente histórico no invalida evidencia posterior explícita.
La primera base confiable debe ser revisada e integrada por una persona antes de fijar su SHA.
Los borradores y la investigación no se publican indiscriminadamente en una única PR.

## 1. Checker y política (implementado; entrega pendiente)

Superficie: `scripts/security/check-repository{,.test}.mjs`, `.github/security/policy.json`,
la línea de `package.json` que incorpora el test, y documentación breve de uso.
Carga actual: 291 líneas modificadas/nuevas antes de documentación.

- Infracciones objetivas y errores/cobertura inesperada hacen fallar el check.
- Semgrep y zizmor mantienen hallazgos como avisos que requieren contexto humano.
- 18 imágenes versionadas excluidas por ruta y SHA exactos, no por extensión global.
- Una excepción no prueba que un archivo sea benigno; cambios nuevos requieren revisión.
- Tests: RED observado, 18 unitarios GREEN, 18 CLI y suite Node 70/70 correctos.
- Verificador independiente confirmó hashes de las 18 imágenes y preservación de controles.
- Pendientes: verificación completa aplicable y revisión nativa del candidato de entrega.

## 2. Runner y scanners (implementado y revisado localmente; adopción pendiente)

Disponible: `scripts/security/semgrep-report.mjs`, función pura
`normalizeSemgrep(report, expectedPaths, { root })`, y 14 tests incluidos en `npm test`.
Exige Semgrep 1.180.0, `errors: []`, `skipped_rules: []` y coincidencia exacta de archivos.
Devuelve hallazgos como avisos sin mensajes, snippets ni metadatos del scanner.
El caller debe obtener `expectedPaths` de un inventario confiable independiente del informe;
`root` debe ser la raíz absoluta del snapshot Linux (en la evidencia local, `/inputs`).
Las pruebas con informes reales verifican compatibilidad, no cobertura independiente del inventario.
La cobertura parcial de parseo y la portabilidad a Windows requieren pruebas antes de integración;
esta validación JSON por sí sola no demuestra que todas las reglas se hayan ejecutado.
Prueba focal: `node --test scripts/security/semgrep-report.test.mjs`.
No hay ejecución de scanners ni conexión al workflow en este módulo.

Disponible también: `scripts/security/export-snapshot.mjs`, API
`exportSnapshot({ repo, commit, parent })`; `commit` es un SHA completo y `parent` un directorio temporal confiable.
Lee blobs Git, nunca archivos dirty ni código ejecutable del target. Exporta JS/TS en nombres planos
conservando extensión, inventario `targets` con ruta original y SHA256, y lista `excluded` de otros archivos.
No copia archivos de configuración/ignore; rechaza symlinks, gitlinks y rutas inseguras.
Límites: 1 MiB por fuente, 32 MiB total, 10.000 entradas; excederlos falla, no omite silenciosamente.
El caller debe eliminar el `root` temporal tras usarlo y mapear sus nombres al mount `/inputs` y a rutas originales.
Rechaza fuentes binarias/no UTF-8; no implementa validación sintáctica ni ejecución del scanner.
Prueba focal: `node --test scripts/security/export-snapshot.test.mjs` (también en `npm test`).
Exportación local comprobada: 66 fuentes y 101 exclusiones explícitas del commit a23322f; 66 hashes verificados.

Disponible: `scripts/security/snapshot-report.mjs`, API `normalizeSnapshotReport(report, inventory)`.
Construye las rutas esperadas en `/inputs` desde `inventory.targets`, nunca desde el reporte del scanner.
Valida el resultado con el normalizador y devuelve rutas originales, commit y exclusiones explícitas.
El inventario debe provenir del exportador confiable; no es un formato firmado ni verifica bytes del mount.
Prueba focal: `node --test scripts/security/snapshot-report.test.mjs` (también en `npm test`).
Incluye un export Git real con reporte sintético: prueba la conexión de módulos, no una ejecución Semgrep.

Para mantener revisiones acotadas, separar exportador+normalizador del adaptador y la futura ejecución;
esta subdivisión no autoriza publicar ni convertir los borradores en una única PR grande.
Runner local disponible: `runSemgrep({ repo, commit, wheelhouse, parent })` en `scripts/security/run-semgrep.mjs`.
Requiere Linux no-root, Docker local (`unix:///var/run/docker.sock`), imagen fijada ya disponible y wheelhouse absoluto.
Exporta el commit, monta snapshot/control/wheels read-only, ejecuta sin red y normaliza antes de devolver el informe.
Comprueba hashes de fuentes y de reglas, lock, entrypoint e inventario antes/después; elimina contenedor y temporales.
Prerrequisitos locales revalidados: Python 3.12.15 y 66 wheels contra el lock, sin nuevas descargas.
Ejecución integrada local: 66 fuentes del commit a23322f, 101 exclusiones explícitas, cero hallazgos y cero contenedores nuevos residuales.
La limpieza ante errores se prueba con transporte simulado; la creación incierta por timeout no garantiza ausencia de una materialización tardía.
La entrega se divide por decisión humana: (a) `semgrep-entry.py`, su test de contrato y fixtures;
(b) `run-semgrep.mjs` y sus tests de orquestación/limpieza. Sin eliminar tests para reducir el diff.
Los tests Node entran en `npm test`; el test del entrypoint es estático, no sustituye la ejecución real offline.
Estas pruebas locales no autorizan adopción en CI ni prueban portabilidad a Windows.
Fixtures persistentes: `.github/security/fixtures/semgrep.json`, cadenas de código inertes que nunca
se importan ni ejecutan. Definen 5 fuentes y 11 avisos esperados, incluyendo un archivo oculto con
`nosemgrep` y un `.semgrepignore` del target que intenta excluir todo. Ejecución real offline: 5 archivos,
11 hallazgos exactos por regla/ruta/línea y cero coincidencias negativas; el archivo oculto con supresión se detectó.
Revisión independiente del runner completada; el hueco de aserción sobre cleanup tras fallo de creación
se cubrió con tests de llamada `rm` al mismo nombre y creación incierta. Esto no prueba que un daemon
no pueda materializar un contenedor tardíamente después de ese intento de cleanup.
Prueba negativa adicional fallida: se esperaba rechazo de `const … = ;`, pero el runner devolvió éxito.
`node --check` confirmó sintaxis inválida, sin ejecutar ese código. Un diagnóstico offline con cuatro
archivos (tres malformados y un control positivo) obtuvo exit 0, `errors: []` y un hallazgo válido.
La comparación con `--optimizations none`, solo en un entrypoint temporal de diagnóstico, no cambió el resultado.
Estos resultados no prueban AST completo ni un fallo ocultado por el wrapper. No se modificó el runner para forzar verde.
La [referencia CLI](https://semgrep.dev/docs/cli-reference) define `--strict` para errores WARN reportados,
no como validador completo de JavaScript. El wheel 1.180.0 despacha por defecto al CLI nativo;
leer la implementación Python legacy no demuestra qué ruta interna se ejecutó en estos casos.
Decisión humana: **mantener el bloqueo**; no aceptar una garantía limitada a lo declarado por el scanner.
El cierre del runner y la activación de este control siguen pendientes de evidencia de cobertura suficiente.
[Investigación acotada de parseo](parser-investigation.md) completada y [revisada independientemente](parser-investigation-report.md):
`show dump-ast` es una señal candidata respaldada por seis controles `.js`/`.ts` (dos exit 0 y cuatro exit 3).
El usuario autorizó diseñar e integrar el control por objetivo; los resultados posteriores se detallan abajo.
Se separa el helper de parseo y sus tests de la integración del entrypoint/host, sin recortar pruebas.
El diseño corregido comprueba **un analizador coincidente por archivo**: JavaScript para `.js/.jsx/.mjs/.cjs`,
TypeScript para `.ts/.tsx`. El exportador transforma únicamente los sufijos `.mts/.cts` en `.ts`, manteniendo
bytes, hash y ruta original. Se retiró `--scan-unknown-extensions` para que el scan no omita su filtro de lenguaje.
Cinco fuentes del commit fijado de Semgrep, verificadas por blob Git y revisadas independientemente,
respaldan la correspondencia. `.tsx` conserva el dialecto TSX; `.mts/.cts` usan TypeScript sin JSX.
El cruce de ambos lenguajes fallaba en JSX (jobs 71/72); inferir sin LANG también falló en `.cjs` (77/78).
Estos fallos se conservaron como evidencia, no se ignoraron. La selección explícita coincide ahora con el scan.
Ante incompatibilidad, timeout o error, bloquea; no convierte el rechazo en un veredicto de malware.
Descarta AST y stderr del precheck; presupuesto global 120 s y máximo 10 s por invocación, incluidos checks finales.
Job-79 pasó ocho extensiones válidas, ocho rechazos malformados, ocho avisos positivos y los cinco fixtures
con once avisos exactos y supresiones ignoradas; falló después en `ProviderLogo.tsx:28` del repositorio real.
Una reproducción mínima identificó `/<!--.../` como rechazo del parser. Con autorización humana explícita,
se sustituyó el literal por su equivalente `/\\x3c!--.../`, con regresión y pruebas de equivalencia RED→GREEN.
Job-86 pasó las 66 fuentes y 101 exclusiones de la baseline con ese ajuste, sin hallazgos. No cambia otros archivos
funcionales ni excluye el componente. El candidato completo de borradores y las últimas integraciones aún requieren verificación.
La revisión independiente confirmó mapa de dialectos, integridad y fail-closed (23 tests Node/16 Python en ese punto).
Los sufijos compuestos `.d.ts` y `.min.js` se analizan en vez de descartarse; esa cobertura adicional es intencional.
Matriz inerte: `.github/security/fixtures/parse-gate.json`. Cambios de idiomas/reglas requieren revisar este contrato.
Los tests de comportamiento Python se invocan desde `npm test`: requieren Python 3 (`python3` en Linux,
`python` en Windows). No se instala Python ni se modifica CI automáticamente; falta comprobar Windows.
Las pruebas positivas anteriores no cierran esta incertidumbre y no autorizan publicar ni activar CI.
Pendientes también: revisión nativa del candidato y adopción del entorno en CI.
`tool-artifacts.json` y `provision-tools.mjs` reemplazan la preparación manual en `/tmp`: 67 URLs y hashes
fijados, límites de tamaño, redirecciones rechazadas y escritura completa antes de publicar el wheelhouse.
CLI real: 67 descargas HTTPS verificadas desde disco. No ejecuta los artefactos descargados.
`runZizmor` reutiliza el aislamiento del runner con un perfil confiable fijo, lock propio y exportación YAML.
El entrypoint aplica `--offline --no-config --strict-collection --no-ignores --no-exit-codes` por workflow.
Normaliza inventario exacto y avisos sin contenido; errores de sintaxis, esquema y archivos vacíos bloquean.
Prueba real: tres workflows actuales sin avisos, supresión ignorada con un aviso exacto, tres negativos rechazados.
La captura Python tiene límites posteriores a la captura; el contenedor de 2 GiB es el límite de memoria externo.
El sobre JSON emitido sí está limitado a 8 MiB antes de escribir y el host impone otro límite de 8 MiB.
El label operativo compartido `semgrep-run-failed:<stage>` también identifica errores del perfil zizmor.
Descargas verificadas separadas del análisis sin red; target siempre datos, nunca scripts ejecutados.
No sustituir paquetes ni reinterpretar errores como cero hallazgos.
Dividir dentro de esta unidad si su implementación real excede la carga de revisión acordada;
no recortar tests/documentación ni comprimir código para aparentar menos líneas.

### Subdivisión de entrega y corrección del corte zizmor

Se mantiene la elección humana de entregas encadenadas. No se juntan todos los borradores en una PR.
El corte bootstrap-only de zizmor fue rechazado: su ejecución directa devolvía éxito sin escanear.
Una corrección fail-closed pasó su regresión, pero no satisfizo el criterio de auditor ejecutable completo.
No se declaró aprobada: su revisión quedó escalada y su commit se conservó en una rama de archivo.

Con autorización humana se reagrupó el auditor completo y todas sus pruebas: 661 líneas, excepción
explícita al objetivo de 400. La recuperación nativa conservó el predecesor y revisó el nuevo candidato.
El commit `0b8e3bf` tiene aprobación nativa reconocida; sus 24 pruebas Python y dos Node fueron
verificadas independientemente. Cuatro pruebas nuevas ejercitan `main` con dependencias inyectadas;
no prueban por sí mismas Docker, instalación real, hashing real ni el scanner real.
El host Semgrep (`0975f28`) y el perfil zizmor (`82720de`) también tienen revisiones nativas cerradas.
CLI/workflow inactivo, documentación y wiring de tests se entregan en unidades separadas,
con verificación final del conjunto antes de anunciar el cierre local.
Preparar cada diff contra la unidad anterior, conservar sus pruebas y no inventar una baseline publicada.

## 3. Workflow preparado (no materializar aún)

Fuente: `.github/security-drafts/code-safety.yml`; destino futuro `.github/workflows/code-safety.yml`.
Obtener runner, reglas, política y herramientas desde un SHA revisado que contenga las unidades previas.
Escanear por separado el commit objetivo de PR/push/manual; no ejecutar su checker/configuración.
No usar pull_request_target, secretos ni permisos de escritura; mantener workflows actuales intactos.
El borrador ya cablea checker, provisionador y ambos scanners; `UNPUBLISHED_REVIEW_REQUIRED` bloquea
cualquier ejecución hasta fijar una baseline revisada real. Auditoría zizmor del borrador: cero hallazgos.
Los pins checkout/setup-node son los previamente revisados; Ubuntu hospedado y Node major no son herméticos.
Emitir un nuevo plan bootstrap exacto después de fijar ese SHA, antes de solicitar apply.

## Límites de confianza

Una PR también puede alterar su workflow: sin protección y revisión exigidas no se garantiza anti-bypass.
CODEOWNERS o protecciones no se activan como parte de esta autorización.
La primera PR de bootstrap usa la CI existente y revisión humana; no fingir una baseline ya publicada.
Semgrep real ya analizó 66 JS/TS del commit a23322f con 3 reglas, sin coincidencias ni errores.
Rust/dataflow/exfiltraciones y ausencia general de malware no quedan certificados por esos resultados.

## Estado de entrega

Ninguna unidad publicada; no hay SHA de baseline nuevo ni plan final de activación aprobado.
Checker, inventarios, runtimes, provisionador, normalizadores, auditor zizmor completo y hosts cuentan
con commits locales y revisiones nativas reconocidas. El cierre local exige revisar también integración
y documentación y comprobar el conjunto; no equivale a adopción. El workflow sigue siendo un borrador con hold.
La revisión no autoriza publicación y no certifica ausencia general de malware.
