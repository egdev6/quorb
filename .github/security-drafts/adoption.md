# Adopción del análisis estático

Estado: **publicado en la PR #101; pendiente de integración, sin cambios de protecciones**.

## Ancla de confianza

- Repositorio: `github.com/egdev6/quorb`.
- Baseline: `176ae636fdd80ce60d6fffec188ce558c5f6692b`, integración revisada de la PR #86.
- Objetivo comprobado: `3087a171812d6d52a54d6873359e106623ebdf02` (`main` tras la PR #100).
- La baseline es antecesora del objetivo. Los directorios `scripts/security`, `.github/security`
  y `.github/security-drafts` no difieren entre ambos commits antes de esta preparación.
- Herramientas, reglas y política se obtienen de la baseline, nunca del objetivo de la PR.
  El objetivo se exporta como blobs de datos; sus scripts, instalaciones y hooks no se ejecutan.
- Se conservan los pins de actions, imagen y 67 wheels revisados en esa baseline, sin actualizarlos.
  La validación de hashes prueba integridad, no ausencia de vulnerabilidades o malware del proveedor.

## Cambio propuesto

| Recurso | Estado | Operación | Autorización |
| --- | --- | --- | --- |
| `.github/security-drafts/code-safety.yml` | Fuente preparada | Fijar baseline completa | Preparación local autorizada |
| `.github/workflows/code-safety.yml` | Publicado en PR #101, aún no integrado | `files` / `ensure` aplicado | Plan y publicación aprobados por el mantenedor |
| CI Windows y Secrets scan | Existentes | Conservar | Ninguna modificación |
| Protecciones y rulesets | API: main sin protección; lista de rulesets vacía | No modificar | Fuera del permiso actual |

El plan no incorpora labels, milestones, templates, Projects, secretos, firma, versión ni release.

## Comportamiento y coste

- Eventos propuestos: pull request, push a `main` y ejecución manual.
- Check: `Static code safety`, Ubuntu hospedado, límite de 20 minutos; cancelar runs anteriores del mismo ref.
- Checker: infracciones objetivas y cobertura desconocida bloquean.
- Semgrep (JS/TS) y zizmor (workflows): hallazgos son avisos para revisión humana;
  errores operativos, parseo rechazado o cobertura incompleta bloquean, no equivalen a malware.
- Descargas de wheels e imagen verificadas por hashes/digest; scanners instalados solo en contenedores
  efímeros sin red, con snapshot de solo lectura. No se instalan herramientas globales.
- Cada run provisiona herramientas: hay coste de red, instalación y minutos CI;
  no se inventa un tiempo promedio antes de observar GitHub Actions.

## Evidencia de validación

- Contrato de adopción: RED (6 correctos, 1 fallo por placeholder) → GREEN (7 correctos).
- Suite local `node --test scripts/security/*.test.mjs`: 95 tests correctos, sin fallos ni omisiones.
- Ejecución real offline con las herramientas de la baseline: 67 wheels verificados por tamaño y SHA256,
  imagen fija Linux/amd64 reutilizada, sin nuevas descargas. Directorios temporales eliminados al terminar.
- Semgrep: 5 fuentes de fixture, 11 hallazgos exactos; controles negativos sin coincidencias y
  supresiones `nosemgrep`/`.semgrepignore` no eluden el análisis. Código de fixture nunca ejecutado.
- Parse gate: ocho extensiones válidas aceptadas y ocho fuentes malformadas rechazadas operativamente.
- Zizmor: detecta action flotante pese al comentario de supresión; YAML malformado bloquea.
  La fuente preparada del workflow se auditó como datos en un Git temporal: un archivo, cero avisos.
- Objetivo `3087a171812d6d52a54d6873359e106623ebdf02`: checker exit 0;
  Semgrep 88 fuentes y zizmor 3 workflows, ambos sin avisos. El objetivo es un commit, no el árbol dirty.
- Estas fixtures reales se ejecutaron con un harness temporal, no están añadidas como otro job CI
  ni incorporadas automáticamente a `npm test`; los contratos unitarios son una evidencia distinta.
- Verificación independiente del candidato: PASS; confirmó baseline, separación trusted/target,
  pins heredados, destino ausente, evidencia E2E y límites; repitió 7 y 95 tests, todos correctos.
  Leyó el resultado E2E y su harness; no volvió a ejecutar Docker ni consultó GitHub.
- Materialización: executor `apply` terminó correctamente, creó solo el workflow autorizado y no
  modificó recursos remotos. Fuente y destino son byte-idénticos (SHA256
  `697c5cce1e0fd2486daeee80b119495a7d08e430e9b2dd46ff20f03aedb84708`).
- Primera ejecución GitHub Actions de `Code safety`: run `38335575489`, SUCCESS;
  analizó el merge candidato `30833e0d55c6679b1172ec4d6ee23fd96df8dbbf`, 88 fuentes y 4 workflows,
  sin avisos. Secrets scan también pasó. Esta evidencia no corresponde al posterior commit correctivo.
- Windows falló inicialmente por una regexp LF-only del nuevo test. La regresión se reproduce con
  LF/CRLF sin modificar archivos del objetivo: RED → GREEN (7 tests), suite de seguridad 95 correctos.
  Solo se amplía la tolerancia al separador CRLF, no los permisos ni la baseline; nueva CI pendiente.
- Abrir la PR o pasar el scanner no integra el workflow ni lo convierte en check requerido.

## Límites y siguiente aprobación

No es un detector universal de scripts maliciosos: estas reglas no cubren Rust, toda exfiltración,
ni cualquier combinación de ofuscación. Los tests positivos y negativos prueban casos concretos.
Sin protección y revisión exigidas, una PR puede alterar el propio workflow: no prometer anti-bypass.
La modificación de protecciones necesita una decisión aparte y no la gestiona este executor.

Regenerar el plan con el executor instalado tras cualquier cambio de fuente, destino o configuración.
Aprobar su valor exacto antes de `apply`. Commit, push, PR y merge necesitan sus propias autorizaciones.
Rollback de una adopción futura: propuesta revisada de revert del workflow; nunca eliminación automática
por bootstrap, que no implementa borrado. La baseline no se mueve silenciosamente con `main`.
