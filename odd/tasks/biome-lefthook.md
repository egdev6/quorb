# Biome lint/format + Lefthook pre-push + CI gate
Branch: `chore/biome-lefthook`; base: `72f443d`. Delivery: work-unit commits on the branch; push, PR, merge and the Discord announcement after merge remain user decisions.
Risk: item 5 (dev dependencies, git hooks and CI gates); item 6 for lint fixes that touch runtime code (each fix covered by existing tests or justified).

## Specs

- S1: "tenemos metido biome y lefthook para hacer lint en pre-push?" → answer was no; proposal accepted with "si": "¿Querés que lo agregue (Biome con `lint`/`format`, Lefthook en pre-push y el mismo chequeo en CI)?"
- S2: Scope chosen by the user: "lint + format + arreglo de errores + aviso en dicord de que lo hemos añadido avisando de que tienen que sincronizar"
- S3: Baseline measured (Biome 2.6.8, defaults): 106 lint errors, 280 warnings, 32 infos over `src/` and `scripts/`. Formatter with single quotes and lineWidth 160 rewrites 178 files when the vendored `src/ds/egdev/` ("No editar a mano") is excluded.

## Tasks

- T1 | S1-S2 | parent inline | done | `biome.json`, `lefthook.yml` (pre-push: `biome ci` + `cargo fmt --check`), npm scripts (`lint`, `format`, `check`, `prepare`), CI step in `ci.yml` and `linux-pr-ci.yml`, CONTRIBUTING EN/ES. Commit: `7006d90`
- T2 | S2-S3 | parent inline | done | Format-only commit with `biome format --write`, plus `.git-blame-ignore-revs`. CSS formatter disabled (12 tests assert literal theme/styles CSS). Tests 1241/1241, tsc OK. Commits: `81e387f` (config + 2 whitespace-tolerant test regexes), `ef1b86c` (format only), blame-ignore commit. PR must NOT be squash-merged or the ignored SHA is lost.
- T3 | S2-S3 | parent inline | done | Exclude raw-imported `src/assets/logos/*.svg` (vendored brand marks, validated by security tests) from Biome. Commit: `81e387f`
- T3a | S2-S3 | worker | pending | Fix every Biome lint error in test files and scripts: `scripts/**`, `src/**/*.test.ts`, `src/**/*.test.tsx`. Commit: -
- T3b | S2-S3 | worker | pending | Fix every Biome lint error in app source: `src/*.tsx`, `src/components/**` (non-test). Commit: -
- T4 | S1-S2 | parent inline | pending | Verify: `npm test`, `npm run build`, `npx biome ci`, `cargo fmt --check`, lefthook pre-push dry run. Commit: -
- T5 | S2 | parent | pending | Discord announcement draft (sync instructions: `npm install`, hooks, rebase over the format commit); publish after merge to `main`. Commit: n/a

## Log

L1 — User verbatim: "tenemos metido biome y lefthook para hacer lint en pre-push?"
L2 — User verbatim: "si" (accepting: add Biome lint/format, Lefthook pre-push and the same check in CI).
L3 — User verbatim scope answer: "lint + format + arreglo de errores + aviso en dicord de que lo hemos añadido avisando de que tienen que sincronizar"
L5 — Lint fix rules for T3a/T3b: no behavior change. No `<form>` exists in `src/`, so `type="button"` is neutral. `useExhaustiveDependencies`: add or remove a dependency only when provably safe (stable setters/refs, or the effect is idempotent); otherwise keep the deps and add `// biome-ignore lint/correctness/useExhaustiveDependencies: <concrete reason>`. Same for any rule where the fix would change runtime behavior: a justified `biome-ignore` beats a risky rewrite. Never disable a rule globally. `npm test` and `npm run typecheck` must stay green.

L6 — Slice boundary: T1-T2 form the tooling+format slice (format commit is mechanical, ~9.7k lines, reviewed by reproduction: `npx biome format --write` on `81e387f` yields `ef1b86c`). Inventory `docs/i18n-inventory.md` is refreshed once at the end (tree hashes move with every commit).

L4 — Decision: exclude vendored `src/ds/egdev/` from Biome (header says it is a copied bundle, not to be edited by hand). lineWidth 160 chosen because it produced the smallest diff among 100/120/140/160 for the existing code.
