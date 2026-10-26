import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRust, extractTs, isUiText } from './i18n-inventory.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n-inventory.mjs');
const texts = (entries) => entries.map((e) => [e.line, e.text]);

test('isUiText keeps human text and drops identifiers, urls and css', () => {
  for (const s of ['Guardar', 'Guardar cambios', 'sesión', 'Cuenta ${…}', ' · saldo comunicado', 'Quitar',
    'Dónde escucha 9Router (por defecto http://localhost:20128).', 'p. ej. /usage/used_tokens']) {
    assert.equal(isUiText(s), true, s);
  }
  for (const s of ['', '   ', '{}', 'save_config', 'eg-gauge__key', 'top', 'camelCase', 'https://github.com/egdev6/quorb',
    'GET', 'USD', 'Content-Type', './lib/types', 'src/lib/format.ts', '#ff0036', '%APPDATA%', '12px', '--eg-accent']) {
    assert.equal(isUiText(s), false, s);
  }
});

test('extractTs finds JSX text, visible attributes, strings and templates with exact lines', () => {
  const src = [
    "import { invoke } from '@tauri-apps/api/core';", // 1
    "type Edge = 'Arriba' | 'Abajo';", // 2
    'export function View({ count }: { count: number }) {', // 3
    "  const label = count === 1 ? '1 reset disponible' : `${count} resets disponibles`;", // 4
    "  invoke('save_config');", // 5
    "  console.log('Depuración interna');", // 6
    '  // Comentario que no es UI', // 7
    '  return (', // 8
    '    <div className="Panel principal" title="Guardar cambios">', // 9
    '      <b>Hay una versión nueva</b>', // 10
    '      <a href="https://example.com">Ver notas</a>', // 11
    '    </div>', // 12
    '  );', // 13
    '}', // 14
    "listen('usage-updated', () => notify('Sesión caducada', 'Pulsa «Renovar sesión» en su panel.'));", // 15
    "console.error('Fallo interno', () => alert('Aviso visible al usuario'));", // 16
  ].join('\n');
  assert.deepEqual(texts(extractTs(src, 'View.tsx')), [
    [4, '1 reset disponible'],
    [4, '${…} resets disponibles'],
    [9, 'Guardar cambios'],
    [10, 'Hay una versión nueva'],
    [11, 'Ver notas'],
    [15, 'Sesión caducada'],
    [15, 'Pulsa «Renovar sesión» en su panel.'],
    [16, 'Aviso visible al usuario'],
  ]);
});

test('extractRust skips comments, test modules and log macros', () => {
  const src = [
    '//! Módulo de prueba con "comillas" en el doc', // 1
    'use std::fmt; // "No es texto"', // 2
    '/* "Bloque comentado" */', // 3
    "fn lifetime<'a>(s: &'a str) -> char { '\"' }", // 4
    'fn plan(n: usize) -> String {', // 5
    '    format!("{n} proveedor{}", if n == 1 { "" } else { "es" })', // 6
    '}', // 7
    'const MSG: &str = "Sin datos de 9Router";', // 8
    'const RAW: &str = r#"Texto "crudo" visible"#;', // 9
    'const ESC: &str = "Dice \\"hola\\" al usuario";', // 10
    'fn warn() { eprintln!("Fallo interno de depuración"); }', // 11
    '#[cfg(test)]', // 12
    'mod tests {', // 13
    '    const T: &str = "Texto solo de test";', // 14
    '    fn nested() { if true { let _ = "Otro texto"; } }', // 15
    '}', // 16
    'const AFTER: &str = "Después de los tests";', // 17
  ].join('\n');
  assert.deepEqual(texts(extractRust(src)), [
    [6, '{n} proveedor{}'],
    [8, 'Sin datos de 9Router'],
    [9, 'Texto "crudo" visible'],
    [10, 'Dice "hola" al usuario'],
    [17, 'Después de los tests'],
  ]);
});

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorb-i18n-inventory-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src-tauri', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), "export const A = () => <p title=\"Abrir ajustes\">Hola mundo</p>;\n");
  fs.writeFileSync(path.join(dir, 'src', 'App.test.tsx'), "it('Texto de test', () => {});\n");
  fs.writeFileSync(path.join(dir, 'src-tauri', 'src', 'lib.rs'), 'const M: &str = "Salir de Quorb";\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

// A file whose texts appear out of sorted order and repeated across lines, to pin
// the deduplication, the collation and the `path:line` rows of `--sites`.
function makeMultiRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorb-i18n-inventory-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src-tauri', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), [
    'export const A = () => (', // 1
    '  <>', // 2
    '    <p>Zebra</p>', // 3
    '    <p>Alfa</p>', // 4
    '    <p>Zebra</p>', // 5
    '  </>', // 6
    ');', // 7
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'src-tauri', 'src', 'lib.rs'), 'const M: &str = "Uno";\nconst N: &str = "Dos";\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

test('CLI writes a reproducible inventory and --check detects drift', () => {
  const dir = makeRepo();
  try {
    const out = 'docs/i18n-inventory.md';
    const gen = run(dir, '--out', out);
    assert.equal(gen.status, 0, gen.stderr);
    const doc = fs.readFileSync(path.join(dir, out), 'utf8');
    const sha = git(dir, 'rev-parse', 'HEAD');
    // Anchored to content-addressed source trees, not to a commit id.
    assert.match(doc, new RegExp(`\`src/\` = \`${git(dir, 'rev-parse', 'HEAD:src')}\``));
    assert.match(doc, new RegExp(`\`src-tauri/src/\` = \`${git(dir, 'rev-parse', 'HEAD:src-tauri/src')}\``));
    assert.doesNotMatch(doc, new RegExp(sha));
    // One section per file with the distinct texts; no per-row line numbers anywhere.
    assert.match(doc, /## src\/App\.tsx/);
    assert.match(doc, /- Abrir ajustes/);
    assert.match(doc, /- Hola mundo/);
    assert.match(doc, /## src-tauri\/src\/lib\.rs/);
    assert.match(doc, /- Salir de Quorb/);
    assert.doesNotMatch(doc, /Texto de test/);
    assert.doesNotMatch(doc, /Line \|/);
    assert.doesNotMatch(doc, /^\| \d+ \|/m);
    assert.match(doc, /React \(`src\/`\) \| 2 \| 2/);
    assert.match(doc, /Rust \(`src-tauri\/src\/`\) \| 1 \| 1/);

    // Re-running on the same ref is byte-identical.
    assert.equal(run(dir, '--out', out, '--ref', sha).status, 0);
    assert.equal(fs.readFileSync(path.join(dir, out), 'utf8'), doc);

    const ok = run(dir, '--check', '--out', out, '--ref', sha);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stderr, '');

    // A Windows checkout with core.autocrlf=true holds the same document with CRLF.
    fs.writeFileSync(path.join(dir, out), doc.replace(/\n/g, '\r\n'));
    const crlf = run(dir, '--check', '--out', out, '--ref', sha);
    assert.equal(crlf.status, 0, crlf.stderr);
    fs.writeFileSync(path.join(dir, out), doc);

    // Squash/rebase rewrite commit ids but not source trees: --check still passes.
    git(dir, 'commit', '-q', '--amend', '-m', 'squashed elsewhere');
    assert.notEqual(git(dir, 'rev-parse', 'HEAD'), sha);
    const squashed = run(dir, '--check', '--out', out);
    assert.equal(squashed.status, 0, squashed.stderr);

    // A pure line shift changes the src tree, so the header hash line moves and --check
    // asks to regenerate; the body of distinct texts is byte-identical, so the diff is
    // the hash line only, not per-row churn.
    fs.writeFileSync(path.join(dir, 'src-tauri', 'src', 'lib.rs'), '\nconst M: &str = "Salir de Quorb";\n');
    git(dir, 'commit', '-q', '-am', 'shift');
    const shifted = run(dir, '--check', '--out', out);
    assert.equal(shifted.status, 1);
    assert.match(shifted.stderr, /docs\/i18n-inventory\.md is out of date/);
    assert.match(shifted.stderr, /header tree hashes only/);
    assert.match(shifted.stderr, /the listed texts still match/);
    assert.equal(run(dir, '--out', out).status, 0);
    const next = fs.readFileSync(path.join(dir, out), 'utf8');
    const body = (s) => s.slice(s.indexOf('## Summary'));
    assert.equal(body(next), body(doc));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sections deduplicate and sort texts; --sites prints path:line rows; --check rejects a doctored doc', () => {
  const dir = makeMultiRepo();
  try {
    const out = 'docs/i18n-inventory.md';
    const gen = run(dir, '--out', out);
    assert.equal(gen.status, 0, gen.stderr);
    const doc = fs.readFileSync(path.join(dir, out), 'utf8');
    // App.tsx holds Zebra, Alfa, Zebra across lines 3-5: one deduplicated, sorted section.
    assert.match(doc, /## src\/App\.tsx\n\n- Alfa\n- Zebra\n/);
    assert.match(doc, /## src-tauri\/src\/lib\.rs\n\n- Dos\n- Uno\n/);

    // --sites keeps every occurrence with its line, in path order then line order.
    const sites = run(dir, '--sites');
    assert.equal(sites.status, 0, sites.stderr);
    assert.equal(sites.stdout, [
      'src-tauri/src/lib.rs:1 | Uno',
      'src-tauri/src/lib.rs:2 | Dos',
      'src/App.tsx:3 | Zebra',
      'src/App.tsx:4 | Alfa',
      'src/App.tsx:5 | Zebra',
      '',
    ].join('\n'));
    // --sites works against any ref.
    const refSites = run(dir, '--sites', '--ref', git(dir, 'rev-parse', 'HEAD'));
    assert.equal(refSites.status, 0, refSites.stderr);
    assert.equal(refSites.stdout, sites.stdout);

    // --sites is a mode: it neither writes nor checks the document.
    const clash = run(dir, '--sites', '--check');
    assert.equal(clash.status, 2);
    assert.match(clash.stderr, /--sites/);

    // --check rejects a hand-edited document without rewriting it.
    const doctored = doc.replace('- Alfa', '- Alfa editada');
    fs.writeFileSync(path.join(dir, out), doctored);
    const bad = run(dir, '--check', '--out', out);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /docs\/i18n-inventory\.md is out of date/);
    assert.match(bad.stderr, /regenerate with/);
    assert.match(bad.stderr, /merge main/);
    assert.equal(fs.readFileSync(path.join(dir, out), 'utf8'), doctored, '--check must not rewrite the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Structural parse of the GitHub Actions workflow subset we rely on: top-level
 * `jobs:` -> job ids -> `steps:` -> step keys, capturing `run` commands both
 * inline (`run: npm ci`) and as block scalars (`run: |` followed by deeper
 * indented lines). Returns { [jobId]: string[] } with the job's run commands
 * in execution order (steps flattened).
 */
function parseWorkflowRuns(yaml) {
  const jobs = {};
  let inJobs = false;
  let job = null;
  let step = null;
  let block = null; // { cmds, keyIndent } while inside a `run: |` block scalar

  const parseStepKey = (text, keyIndent) => {
    const run = /^run:\s*(.*)$/.exec(text);
    if (!run) return; // name/uses/with/working-directory: irrelevant to the command sequence
    const value = run[1].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      block = { cmds: step.cmds, keyIndent };
    } else if (value) {
      step.cmds.push(value);
    }
  };

  for (const raw of yaml.split('\n')) {
    const stripped = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (block) {
      if (indent > block.keyIndent) {
        if (stripped && !stripped.startsWith('#')) block.cmds.push(stripped);
        continue;
      }
      block = null; // this line is less indented: the block ended
    }
    if (!stripped || stripped.startsWith('#')) continue;
    if (indent === 0) {
      inJobs = stripped === 'jobs:';
      job = null;
      step = null;
      continue;
    }
    if (indent === 2 && stripped.endsWith(':')) {
      job = inJobs ? stripped.slice(0, -1) : null;
      if (job) jobs[job] = [];
      step = null;
      continue;
    }
    if (job === null) continue;
    if (indent === 4) {
      step = null; // job-level keys (steps:, runs-on:, timeout-minutes:...)
      continue;
    }
    if (indent === 6 && stripped.startsWith('- ')) {
      step = { cmds: [] };
      jobs[job].push(step);
      parseStepKey(stripped.slice(2), 8);
      continue;
    }
    if (indent >= 8 && step) parseStepKey(stripped, 8);
  }
  return Object.fromEntries(Object.entries(jobs).map(([id, steps]) => [id, steps.flatMap((s) => s.cmds)]));
}

const INSTALL_CMD = /^npm (ci|install)(\s|$)/;
const CHECK_CMD = /\bnode scripts\/i18n-inventory\.mjs --check\b/;

/** A job installs dependencies and runs the inventory check afterwards (command order). */
const runsCheckAfterInstall = (jobs) =>
  Object.values(jobs).some((cmds) => {
    const install = cmds.findIndex((c) => INSTALL_CMD.test(c));
    const check = cmds.findIndex((c) => CHECK_CMD.test(c));
    return install >= 0 && check > install;
  });

test('CI checks the committed inventory after installing dependencies (#155, structural since #160)', () => {
  const root = path.resolve(path.dirname(SCRIPT), '..');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const jobs = parseWorkflowRuns(workflow);
  assert.ok(Object.keys(jobs).length > 0, 'ci.yml has jobs');
  assert.ok(runsCheckAfterInstall(jobs), 'a job runs npm ci and, later in command order, the inventory --check');
});

test('the structural contract survives cosmetic reorders and block runs', () => {
  const blockRun = [
    'name: CI',
    'jobs:',
    '  checks:',
    '    steps:',
    '      - name: Everything',
    '        run: |',
    '          npm ci',
    '          node scripts/i18n-inventory.mjs --check',
    '  ',
  ].join('\n');
  assert.equal(runsCheckAfterInstall(parseWorkflowRuns(blockRun)), true, 'same-step block run in order counts');

  const reorderedKeys = [
    'jobs:',
    '  checks:',
    '    timeout-minutes: 30',
    '    steps:',
    '      - run: npm test',
    '        name: Tests first',
    '      - run: node scripts/i18n-inventory.mjs --check',
    '      - run: npm ci',
    '  ',
  ].join('\n');
  assert.equal(
    runsCheckAfterInstall(parseWorkflowRuns(reorderedKeys)),
    false,
    'check before install in command order is rejected even with keys cosmetically reordered',
  );
});

test('the structural contract rejects cross-job and non-run false positives that indexOf accepted', () => {
  const crossJob = [
    'name: CI',
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: npm ci',
    '  audit:',
    '    steps:',
    '      - run: node scripts/i18n-inventory.mjs --check',
    '  ',
  ].join('\n');
  assert.equal(runsCheckAfterInstall(parseWorkflowRuns(crossJob)), false, 'check in a different job than npm ci is rejected');
  // The legacy indexOf contract accepted exactly this broken workflow: pin why it had to go.
  assert.ok(
    crossJob.indexOf('run: npm ci') >= 0 && crossJob.indexOf('run: node scripts/i18n-inventory.mjs --check') > crossJob.indexOf('run: npm ci'),
    'documentation: the replaced indexOf assertion would have passed this workflow',
  );

  const commentOnly = [
    'name: CI',
    'jobs:',
    '  checks:',
    '    steps:',
    '      - run: npm ci',
    '      - name: node scripts/i18n-inventory.mjs --check',
    '        run: npm test',
    '  ',
  ].join('\n');
  assert.equal(runsCheckAfterInstall(parseWorkflowRuns(commentOnly)), false, 'the check named but never run is rejected');
});

test('CLI rejects unknown arguments without writing', () => {
  const dir = makeRepo();
  try {
    const res = run(dir, '--nope');
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown argument: --nope/);
    assert.equal(fs.existsSync(path.join(dir, 'docs')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R1 extractTs keeps any JSX text with a letter, even a single lowercase or underscore word', () => {
  const src = [
    'export const V = () => (', // 1
    '  <div>', // 2
    '    <option>nan_member</option>', // 3
    '    <span>min</span>', // 4
    '    <i>·</i>', // 5
    '    <b>{count}</b>', // 6
    '  </div>', // 7
    ');', // 8
  ].join('\n');
  assert.deepEqual(texts(extractTs(src, 'V.tsx')), [
    [3, 'nan_member'],
    [4, 'min'],
  ]);
});

test('R2 extractTs always keeps string/template values of placeholder, title, alt, label, hint and text aria-* (not state aria-*)', () => {
  const src = [
    'export const V = ({ n, on }) => (', // 1
    '  <div>', // 2
    '    <input placeholder="tu@correo.com" title={`min ${n}`} alt={\'logo\'} />', // 3
    '    <Field label="user_name" hint={on ? \'sí\' : \'no_hay\'} aria-label="close" />', // 4
    '    <a title="https://example.com/x" placeholder="1234" aria-valuenow={5} />', // 5
    '    <a name="top_x" id="main_id" aria-current={n} aria-hidden="true" aria-live="polite" />', // 6
    '  </div>', // 7
    ');', // 8
  ].join('\n');
  assert.deepEqual(texts(extractTs(src, 'V.tsx')), [
    [3, 'tu@correo.com'],
    [3, 'min ${…}'],
    [3, 'logo'],
    [4, 'user_name'],
    [4, 'sí'],
    [4, 'no_hay'],
    [4, 'close'],
  ]);
});

test('R3 extractRust always keeps the string of `unit: Some("…")`', () => {
  const src = [
    'fn a() -> Meter {', // 1
    '    Meter { unit: Some("peticiones"), v: 1 }', // 2
    '}', // 3
    'fn b() -> Meter {', // 4
    '    Meter {', // 5
    '        unit: Some( "req" ),', // 6
    '        other: Some("req_x"),', // 7
    '        unit: Some("USD"),', // 8
    '        unit: None,', // 9
    '    }', // 10
    '}', // 11
  ].join('\n');
  assert.deepEqual(texts(extractRust(src)), [
    [2, 'peticiones'],
    [6, 'req'],
    [8, 'USD'],
  ]);
});

test('R4 extractRust skips literals that are arguments of .expect, .header, diagnostic and checked', () => {
  const src = [
    'fn f(c: &Client) {', // 1
    '    let v = lock.lock().expect("mutex envenenado en la caché");', // 2
    '    let r = c.get(url).header("Content-Type", "application/json").send();', // 3
    '    let d = diagnostic("Falló la consulta de uso", 3);', // 4
    '    let k = checked("Valor fuera de rango");', // 5
    '    let m = format!("Texto visible");', // 6
    '    let e = res.expect_err("Texto con expect_err");', // 7
    '    let q = is_checked("Texto tras is_checked");', // 8
    '    let after = lock.expect("dentro");', // 9
    '    let z = "Después de las llamadas";', // 10
    '}', // 11
  ].join('\n');
  assert.deepEqual(texts(extractRust(src)), [
    [6, 'Texto visible'],
    [7, 'Texto con expect_err'],
    [8, 'Texto tras is_checked'],
    [10, 'Después de las llamadas'],
  ]);
});

test('R5 extractTs skips string operands of === / !== and case clauses', () => {
  const src = [
    'export function f(s: string, k: string) {', // 1
    "  if (s === 'Started' || 'Finished' !== s) return 'Resultado visible';", // 2
    '  switch (k) {', // 3
    "    case 'Escape': return 'Cerrar ventana';", // 4
    "    case 'Enter':", // 5
    '  }', // 6
    "  return s == 'Dos iguales';", // 7
    '}', // 8
  ].join('\n');
  assert.deepEqual(texts(extractTs(src, 'f.ts')), [
    [2, 'Resultado visible'],
    [4, 'Cerrar ventana'],
    [7, 'Dos iguales'],
  ]);
});

test('R6 extractTs skips string literals inside new Set([...]) but keeps other arrays and object keys', () => {
  const src = [
    "const MODS = new Set(['Control', 'Shift', 'Alt gr']);", // 1
    "const LIST = ['Control', 'Shift'];", // 2
    "const LABELS: Record<string, number> = { 'Semana · todos': 1, 'Mes': 2 };", // 3
  ].join('\n');
  assert.deepEqual(texts(extractTs(src, 'k.ts')), [
    [2, 'Control'],
    [2, 'Shift'],
    [3, 'Semana · todos'],
    [3, 'Mes'],
  ]);
});
