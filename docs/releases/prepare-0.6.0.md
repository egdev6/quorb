# Preparación de Quorb 0.6.0

**Estado: preparación local; todavía no lista para ejecutar Release.**

## Fuente y alcance

- Repositorio: `egdev6/quorb`; rama de preparación: `chore/release-0.6.0`.
- Última estable verificada: `v0.5.0`, fuente
  `e07416483b53cd19fed0aafd21fcb5f37755fed4`.
- Base integrada en `main`: `176ae636fdd80ce60d6fffec188ce558c5f6692b`.
- Notas aprobadas para preparar en ES/EN: [v0.6.0.md](./v0.6.0.md).
- El SHA definitivo se verificará después de integrar esta preparación.

Se cambian únicamente las versiones propias de `package.json`,
`package-lock.json` (raíz y paquete raíz), `src-tauri/Cargo.toml` y
`src-tauri/Cargo.lock`, mediante `node scripts/bump.mjs 0.6.0`, más estas notas.
Tauri hereda la versión desde `../package.json`; no se renuevan dependencias.
No hay un cambio de comportamiento que requiera un ciclo RED/GREEN.

No se modifican runtime, workflows, firma, secretos ni visibilidad. Code Safety
permanece inactivo y no es un requisito de esta release. Los cambios locales
ajenos a la base integrada no están incluidos.

## Requisitos y evidencia

| Requisito | Estado de preparación |
| --- | --- |
| Versión y notas | Cinco valores `0.6.0` coherentes; notas ES/EN y enlaces locales comprobados |
| Tests y build local | 219 tests frontend y 146 Node aprobados; TypeScript/Vite y `git diff --check` correctos |
| Rust local | No disponible: `cargo metadata --offline --locked --no-deps` no pudo ejecutarse porque falta `cargo` en PATH; no se instalaron herramientas |
| Dependencias locales | Se reutilizan las existentes; no hubo instalación ni actualización |
| Workflow Release remoto | Activo, manual desde `main`, inputs `version` y `source_sha`; genera borrador estable |
| Runner | Windows, Node 22 y Rust stable configurados; la nueva preparación debe pasar su CI |
| Firma del updater | Nombres de ambos secretos presentes; formato de clave pública y overlay de artefactos comprobados, sin leer valores privados ni acreditar firma futura |
| Colisión de versión | No se observó tag ni release `v0.6.0` en la consulta inicial; revalidar antes de ejecutar |
| Instalador y login | Pendientes de comprobación funcional en Windows; no sustituidos por tests automatizados |

La firma del updater no es Authenticode. No se promete actualización automática
anónima mientras el repositorio sea privado. La apertura pública es posterior
a esta release y necesita su revisión de exposición y confirmación.

## Pendiente antes de ejecutar

- [ ] Entregar la preparación mediante issue/PR autorizadas y completar su revisión.
- [ ] Obtener CI Windows y Security correctas para el candidato entregado.
- [ ] Integrar la preparación y verificar el SHA exacto en `origin/main`.
- [ ] Revalidar colisión de versión y ejecutar el preflight sobre ese SHA final.

Después de esas comprobaciones, la ejecución manual será **Actions → Release**,
ref **`main`**, `version=0.6.0` y `source_sha=<SHA completo verificado tras merge>`.
**No usar el SHA base como fuente de 0.6.0: todavía declara 0.5.0.**
El workflow compilará y firmará los artefactos y creará un borrador para revisar.
No se ha ejecutado Release, creado un tag ni publicado una release desde esta
preparación.
