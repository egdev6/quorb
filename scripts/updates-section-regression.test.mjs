// Test de regresión: el early-return de `UpdatesSection` en `src/Settings.tsx`
// (`if (mode !== 'native') return ...`) DEBE conservarse. El owner de egdev6/quorb
// pidió explícitamente no tocar este comportamiento en PRs Linux: un rebase o
// merge accidental que lo elimine haría que los usuarios de macOS en modo
// "manual" vieran la UI de actualización nativa (botones check/install) que
// no deben operar en ese modo. Estos asserts son de merge-regression, no
// de comportamiento runtime (Settings.tsx no tiene test RTL en este repo).
//
// El PR #122 (feat-linux-l1-106) verificó que el código viene intacto de
// main (commit 1dbc5fb3 de Quique). Estos asserts blindan que ningún PR
// futuro pueda quitarlo sin disparar el test.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(here, '..', 'src', 'Settings.tsx');
const src = readFileSync(settingsPath, 'utf8');

test('UpdatesSection conserva el early-return mode !== native (regresión merge)', () => {
  // 1. La función existe con la firma exacta.
  if (
    !/function\s+UpdatesSection\s*\(\s*\{\s*auto\s*,\s*onAuto\s*\}\s*:\s*\{\s*auto\s*:\s*boolean\s*;\s*onAuto\s*:\s*\(v:\s*boolean\)\s*=>\s*void\s*\}\s*\)/.test(
      src
    )
  ) {
    throw new Error('Firma de UpdatesSection no encontrada — el componente fue refactorizado; revisar manualmente');
  }

  // 2. El early-return está en su sitio. Es el patrón que el owner pidió preservar
  //    y la causa del comentario de revisión.
  const earlyReturnRe = /if\s*\(\s*mode\s*!==\s*'native'\s*\)\s*return\s*\(/;
  if (!earlyReturnRe.test(src)) {
    throw new Error(
      'Early-return `if (mode !== \'native\') return (` no encontrado en UpdatesSection. ' +
        'Restaurar el bloque (macOS modo manual debe mostrar "Actualización manual en macOS. No se buscan ni se instalan actualizaciones desde la app.").'
    );
  }

  // 3. El texto específico del modo manual sigue ahí (cubre el mensaje de macOS).
  if (!src.includes('Actualización manual en macOS. No se buscan ni se instalan actualizaciones desde la app.')) {
    throw new Error(
      'Texto del modo manual en UpdatesSection modificado. Mantener el mensaje literal para que el owner apruebe sin preguntas.'
    );
  }

  // 4. La rama nativa (modo `'native'`) sigue presente, devolviendo la UI completa
  //    con `<Section title="Versión instalada">` (no "Versión actual").
  if (!/<Section\s+title="Versión instalada">/.test(src)) {
    throw new Error(
      'Cabecera "Versión instalada" no encontrada en la rama nativa de UpdatesSection.'
    );
  }
});
