# Preparación de Quorb 0.7.0

**Estado: preparación local; todavía no lista para ejecutar Release.**

## Fuente y alcance

- Repositorio: `egdev6/quorb`; rama de preparación: `chore/release-0.7.0`.
- Última estable verificada: `v0.6.0`, fuente
  `176ae636fdd80ce60d6fffec188ce558c5f6692b` (tag `v0.6.0`).
- Base integrada en `main`: `54a4dc2` (`docs(linux): W0 Wayland evidence…`, #151).
- Notas aprobadas para preparar en ES/EN: [v0.7.0.md](./v0.7.0.md).
- El SHA definitivo se verificará después de integrar esta preparación.

Se cambian únicamente las versiones propias de `package.json`,
`package-lock.json` (raíz y paquete raíz), `src-tauri/Cargo.toml` y
`src-tauri/Cargo.lock`, mediante `node scripts/bump.mjs 0.7.0`, más estas notas.
Tauri hereda la versión desde `../package.json`; no se renuevan dependencias.
No hay un cambio de comportamiento que requiera un ciclo RED/GREEN.

**Alcance de plataforma: Windows x64.** Las notas anuncian EXE/MSI Windows y
declaran explícitamente que no hay descargas públicas macOS/Linux. El workflow
Release sigue siendo Windows-only; no se modifica. Las decisiones de #118
(macOS) y #108 (Linux) siguen pendientes y no se cierran con esta release.

## Contenido de la versión (v0.6.0..main, 33 commits)

- feat: 9Router aggregator provider (#104); validez declarada y créditos de
  reset de Codex (#138/#139); limpieza NSIS con consentimiento (#137).
- ui: secciones de detalle persistentes (#142), paleta de anillos (#140),
  disclosures accesibles (#141), personalización y estados visuales (#102).
- widget: recuperación de posición/tamaño nativos (#148), contorno de arrastre
  y colores (#100).
- fix: enlace de uso de Codex (#110); iconos transparentes regenerados
  (#145/#146).
- Interno multiplataforma sin artefactos públicos: base Linux
  (#114/#122/#127/#128/#129/#131/#150/#151) y port macOS (#112/#119–#125).

## Requisitos y evidencia

| Requisito | Estado de preparación |
| --- | --- |
| Versión y notas | Cuatro manifiestos a `0.7.0` (Tauri hereda el quinto valor); notas ES/EN con enlaces locales |
| Tests y build local | Pendiente de ejecutar en esta preparación (ver abajo) |
| CI del candidato | Pendiente: Windows/macOS/Security/Code safety sobre la PR |
| Workflow Release remoto | Activo, manual desde `main`, inputs `version` y `source_sha`; genera borrador estable |
| Firma del updater | Nombres de secretos presentes (sin leer valores); misma configuración que 0.6.0 |
| Colisión de versión | No existe tag ni release `v0.7.0` en la consulta inicial; revalidar antes de ejecutar |
| Instalador y smoke Windows | Pendiente: ningún binario de esta rama ha corrido en un escritorio Windows real; comprobar el borrador antes de publicar |

Créditos verificados sobre commits, PRs y reviews del rango
(v0.6.0..`54a4dc2`): sosan (#114/#122/#127/#128/#129/#151), barbatdev (#112),
Pacoaldev (#104), ludevdot (#110), Rafaeldelinares (#131).

## Pendiente antes de ejecutar

- [ ] Entregar la preparación mediante PR y completar su revisión.
- [ ] Obtener CI correcta (Windows, macOS, Security, Code safety) para el candidato.
- [ ] Integrar la preparación y verificar el SHA exacto en `origin/main`.
- [ ] Smoke manual rápido del instalador borrador en Windows real (widget,
      bandeja, login CLI, desinstalación con limpieza).
- [ ] Revalidar colisión de versión y ejecutar el preflight sobre ese SHA final.

Después de esas comprobaciones, la ejecución manual será **Actions → Release**,
ref **`main`**, `version=0.7.0` y `source_sha=<SHA completo verificado tras merge>`.
**No usar el SHA base como fuente de 0.7.0: todavía declara 0.6.0.**
El workflow compilará y firmará los artefactos y creará un borrador para revisar.
No se ha ejecutado Release, creado un tag ni publicado una release desde esta
preparación.
