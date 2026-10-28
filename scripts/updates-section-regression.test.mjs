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
//
// Desde T2c (issue #66) los textos de UpdatesSection viajan por los catálogos
// tipados (`t(locale, 'settings.updates.*')`): los literales históricos se
// verifican ahora VERBATIM como valores del catálogo `es` en `src/i18n/es.ts`,
// y el cableado por clave se exige en `src/Settings.tsx`. La protección es la
// misma: nadie puede eliminar el early-return ni reescribir los mensajes sin
// que este test falle.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(here, '..', 'src', 'Settings.tsx');
const esCatalogPath = resolve(here, '..', 'src', 'i18n', 'es.ts');
const src = readFileSync(settingsPath, 'utf8');
const esCatalog = readFileSync(esCatalogPath, 'utf8');

test('UpdatesSection conserva el early-return mode !== native (regresión merge)', () => {
  // 1. La función existe con la firma exacta (locale opcional desde T2c).
  if (
    !/function\s+UpdatesSection\s*\(\s*\{\s*auto\s*,\s*onAuto(?:\s*,\s*locale\s*=\s*'es')?\s*\}\s*:\s*\{\s*auto\s*:\s*boolean\s*;\s*onAuto\s*:\s*\(v:\s*boolean\)\s*=>\s*void\s*(?:;\s*locale\?:\s*Locale)?\s*\}\s*\)/.test(
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
        'Restaurar el bloque (macOS modo manual debe mostrar el aviso de actualización manual).'
    );
  }

  // 3. El texto específico del modo manual sigue literal (ahora como valor `es`
  //    del catálogo) y el cableado usa esa clave.
  if (!esCatalog.includes('manualMode: \'Actualización manual en macOS. No se buscan ni se instalan actualizaciones desde la app.\'')) {
    throw new Error(
      'Texto del modo manual modificado. Mantener el valor es literal de settings.updates.manualMode ' +
        'para que el owner apruebe sin preguntas.'
    );
  }
  if (!src.includes("t(locale, 'settings.updates.manualMode')")) {
    throw new Error('UpdatesSection debe pintar el aviso del modo manual con la clave settings.updates.manualMode.');
  }

  // 4. La rama nativa (modo `'native'`) sigue presente, devolviendo la UI completa
  //    con el título "Versión instalada" (no "Versión actual"), por clave de catálogo.
  if (!esCatalog.includes('installedTitle: \'Versión instalada\'')) {
    throw new Error('El valor es de settings.updates.installedTitle debe seguir siendo «Versión instalada».');
  }
  if (!/<Section\s+title=\{t\(locale,\s*'settings\.updates\.installedTitle'\)\}>/.test(src)) {
    throw new Error('La cabecera de la rama nativa debe usar la clave settings.updates.installedTitle.');
  }
});
