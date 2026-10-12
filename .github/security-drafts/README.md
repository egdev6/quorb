# Seguridad estática — preparada localmente, no activada

Esta capa analiza blobs Git como datos, sin ejecutar el código objetivo. La preparación y las pruebas
locales no autorizan publicar ni instalar el workflow. CI, Security/Gitleaks y Release actuales no se modifican.
El checkout original con cambios UI permanece intacto; todo este candidato vive en el worktree aislado.
**Revisión por unidades:** la revisión agregada se detuvo por `lens_context_budget_exceeded`, sin crear autoridad.
Los commits locales encadenados fueron autorizados; checker, inventarios, runtimes, provisionador,
normalizadores y hosts tienen revisiones nativas cerradas. El auditor zizmor completo se reagrupó
con excepción de tamaño autorizada y recuperación auditada. El cierre local requiere revisión de cada
unidad y comprobaciones del conjunto; nunca autoriza por sí mismo publicación o activación.

## Qué bloquea y qué informa

| Control | Resultado |
| --- | --- |
| Política de Git, Unicode, manifests y cobertura | Infracciones y errores bloquean |
| Imágenes binarias | Solo 18 rutas y hashes aprobados, modo regular no ejecutable |
| Semgrep CE 1.180.0 | Tres reglas JS/TS; hallazgos contextuales, no veredictos |
| Precheck de parseo | Cada archivo debe pasar el parser coincidente; error, timeout o integridad desconocida bloquean |
| zizmor 1.30.1 offline | Workflows directos de `.github/workflows`; hallazgos advisory, errores operativos bloquean |

Rust, dataflow, exfiltración, auditorías remotas de zizmor, historial de secretos y ausencia general de malware
**no** quedan certificados. Los hooks transitivos esbuild/fsevents tampoco son hooks raíz de la política.
Una PR puede editar su workflow: las protecciones y la revisión obligatoria siguen siendo requisitos externos.

## Ejecutar desde una baseline confiable

Requisitos: Linux x86_64, usuario no-root, Docker local en `unix:///var/run/docker.sock`, Node 24 y
la imagen fijada ya descargada. Para los tests locales, además Python 3; no instalar los wheels en el Python del host.
Los comandos siguientes pertenecen a la copia **confiable**, nunca al checkout objetivo:

```sh
# Preparación con red: solo artefactos fijados, tamaño y SHA-256 verificados.
node scripts/security/code-safety.mjs provision /ruta/privada/nueva/wheels
# La política lee HEAD; comprobar previamente que coincide con el commit esperado.
node scripts/security/check-repository.mjs --repo /ruta/target --policy /ruta/trusted/.github/security/policy.json
# Análisis: commit completo de 40/64 hex; directorio padre existente y privado.
node scripts/security/code-safety.mjs scan /ruta/target COMMIT_COMPLETO /ruta/privada/nueva/wheels /ruta/privada
```

El provisionador rechaza destinos existentes. Los scanners usan mounts readonly, red deshabilitada,
capabilities eliminadas, no-new-privileges, límites de CPU/memoria/procesos y tmpfs efímero.
El runner elimina sus temporales y contenedores; el operador elimina el wheelhouse cuando termine.
Una creación Docker que termine tarde tras un timeout no tiene garantía absoluta de ausencia de residuos.

## Cobertura e integridad

- Inventario independiente desde Git: rutas originales, bytes, SHA-256 y exclusiones explícitas.
- Semgrep: `.js/.jsx/.mjs/.cjs` usan JavaScript; `.ts/.tsx` usan TypeScript, conservando TSX.
  `.mts/.cts` se exportan con sufijo `.ts`, sin modificar bytes, hashes ni identidad original.
  No se usa `--scan-unknown-extensions`; el precheck y el scan comparten selección de analizador.
- Los nombres planos evitan configuración e ignores del target; `.min.js` y `.d.ts` también se analizan.
- Cada workflow se pasa explícitamente a zizmor con `--strict-collection --no-config --no-ignores`.
  `--no-exit-codes` conserva los fallos operativos; comentarios de supresión no eliminan avisos.
- Versiones, locks, fuentes y cinco archivos de control se comprueban; el resultado se liga al inventario.
  Solo salen regla, ruta, línea, advisory y cobertura: no AST, mensajes, snippets ni stderr del scanner.
- Un repositorio sin JS/TS o sin workflows falla por alcance vacío; no se presenta como análisis completo.

## Artefactos y pruebas

`tool-artifacts.json` fija las 67 URLs, tamaños y SHA-256 (66 wheels Semgrep y uno zizmor).
`semgrep-linux-py312.lock` y `zizmor-linux.lock` exigen instalación offline, hashes, wheels-only y sin resolución.
Runtime: `docker.io/library/python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d`.
La procedencia y los límites originales están en `tool-distributions.json`, `semgrep-resolution.json` y
[la investigación del parser](parser-investigation-report.md). Integridad no significa benignidad ni build attestation.

Resultados locales de esta preparación:

- Matriz real Semgrep: ocho extensiones válidas, ocho rechazos malformados y ocho avisos positivos esperados.
- Cinco fixtures: once avisos exactos, incluidos archivo oculto, `nosemgrep` y `.semgrepignore` hostiles.
- Baseline ajustada: 66 fuentes, 101 exclusiones, cero hallazgos. Candidato de borradores: 87 fuentes,
  122 exclusiones, cero hallazgos en ese snapshot temporal.
- `ProviderLogo.tsx` recibió únicamente el cambio equivalente de regexp autorizado por el usuario;
  su literal original disparaba un rechazo del parser. Pruebas de equivalencia y re-scan correctos.
- CLI E2E real del candidato: 87 fuentes Semgrep y tres workflows zizmor, cero hallazgos y limpieza comprobada.
- zizmor aislado: tres workflows actuales sin hallazgos; fixture positivo conservado pese a supresión;
  sintaxis incorrecta, esquema inválido y archivo vacío rechazados. Workflow candidato: cero hallazgos.
- CLI real de provisionado: 67 descargas HTTPS verificadas de nuevo desde disco, sin ejecutar artefactos.
- Frontend: 219 tests; suite Node y build correctos en las comprobaciones registradas. Verificar nuevamente
  cualquier candidato posterior. Las pruebas no equivalen a una ejecución de este workflow en GitHub.

El entrypoint zizmor tiene pruebas funcionales, pero su autor escribió implementación y tests juntos;
la sustitución temporal por un stub **no** se acredita como TDD. Las correcciones posteriores sí conservan
RED→GREEN observado. No se recortan pruebas para reducir el tamaño de revisión.

## Adopción pendiente

1. Revisar y publicar las unidades del [plan de integración](integration-plan.md), con sus tests y docs.
2. Elegir el SHA completo e inmutable que contiene el runner/política/herramientas revisados.
3. Sustituir `UNPUBLISHED_REVIEW_REQUIRED` en `code-safety.yml`, volver a verificar y regenerar el plan bootstrap.
4. Obtener aprobación aparte para push/PR y para el apply exacto; los commits locales ya están autorizados. No auto-merge.

`code-safety.yml` está fuera de `.github/workflows` y falla con exit 2 sin una baseline revisada.
`bootstrap.json` únicamente declara la copia futura con `ensure`; no ejecutarlo con apply ahora.
Los pins de checkout/setup-node son los previamente revisados. El runner hospedado y el major Node son
plataforma administrada, no pins herméticos. Rollback futuro: retirar solo esta capa mediante cambio revisado.
