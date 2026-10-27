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

    // Only the tree-hash line may be called hashes-only drift: an edited header prose
    // with identical texts is a real difference, not a mechanical refresh.
    const prose = doc.replace('Do not edit by hand', 'Please do not edit by hand');
    fs.writeFileSync(path.join(dir, out), prose);
    const proseCheck = run(dir, '--check', '--out', out);
    assert.equal(proseCheck.status, 1);
    assert.doesNotMatch(proseCheck.stderr, /hashes only/);
    assert.match(proseCheck.stderr, /regenerate with/);

    // A document without a Summary section is never mistaken for hashes-only drift.
    fs.writeFileSync(path.join(dir, out), 'not an inventory\n');
    const garbage = run(dir, '--check', '--out', out);
    assert.equal(garbage.status, 1);
    assert.doesNotMatch(garbage.stderr, /hashes only/);
    assert.match(garbage.stderr, /regenerate with/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Structural parse of the GitHub Actions workflow subset we rely on: top-level
 * `jobs:` -> job ids -> `steps:` -> step keys. Each step keeps its `run`
 * command as the shell receives it (plain or YAML-quoted inline scalar, `|`
 * block joined by newlines, `>` block folded with spaces) together with the
 * settings that decide whether it runs and whether its failure fails the job:
 * `if`, `continue-on-error` and the effective `shell` (step, else job
 * `defaults`, else workflow `defaults`). Keys of nested maps such as `with:`
 * are not step keys. Returns { [jobId]: { if, continueOnError, steps } } with
 * steps in execution order.
 */
function parseWorkflowRuns(yaml) {
  const jobs = {};
  let workflowShell = null;
  let top = null; // current top-level key
  let job = null;
  let jobKey = null; // current job-level key (steps, defaults, ...)
  let step = null;
  let block = null; // { step, folded, lines, contentIndent } inside a run block scalar

  const endBlock = () => {
    const { lines } = block;
    while (lines.length && lines.at(-1) === '') lines.pop();
    block.step.run = block.folded ? lines.filter(Boolean).join(' ') : lines.join('\n');
    block = null;
  };

  const parseStepKey = (text) => {
    const kv = /^([\w-]+):\s*(.*)$/.exec(text);
    if (!kv) return;
    const [, key, raw] = kv;
    const value = raw.trim();
    if (key === 'run' && BLOCK_SCALAR.test(value)) {
      block = { step, folded: value.startsWith('>'), lines: [], contentIndent: null };
    } else if (key === 'run') {
      step.run = yamlScalar(value);
    } else if (key === 'if') {
      step.if = true;
    } else if (key === 'continue-on-error') {
      step.continueOnError = yamlScalar(value);
    } else if (key === 'shell') {
      step.shell = yamlScalar(value);
    }
  };

  for (const raw of yaml.split('\n')) {
    const stripped = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (block) {
      // Block content is indented past the step keys (column 8); blank lines belong to it.
      if (!stripped || indent > 8) {
        if (stripped && block.contentIndent === null) block.contentIndent = indent;
        block.lines.push(stripped ? raw.slice(Math.min(indent, block.contentIndent)) : '');
        continue;
      }
      endBlock();
    }
    if (!stripped || stripped.startsWith('#')) continue;
    const kv = /^([\w-]+):\s*(.*)$/.exec(stripped);
    if (indent === 0) {
      top = kv ? kv[1] : null;
      job = null;
      step = null;
      continue;
    }
    if (top === 'defaults') {
      if (kv && kv[1] === 'shell') workflowShell = yamlScalar(kv[2].trim());
      continue;
    }
    if (top !== 'jobs') continue;
    if (indent === 2) {
      job = stripped.endsWith(':') ? { if: false, continueOnError: null, shell: null, steps: [] } : null;
      if (job) jobs[stripped.slice(0, -1)] = job;
      jobKey = null;
      step = null;
      continue;
    }
    if (job === null) continue;
    if (indent === 4) {
      step = null;
      jobKey = kv ? kv[1] : null;
      if (jobKey === 'if') job.if = true;
      else if (jobKey === 'continue-on-error') job.continueOnError = yamlScalar(kv[2].trim());
      continue;
    }
    if (jobKey === 'defaults') {
      if (kv && kv[1] === 'shell') job.shell = yamlScalar(kv[2].trim());
      continue;
    }
    if (jobKey !== 'steps') continue;
    if (indent === 6 && stripped.startsWith('- ')) {
      step = { run: null, if: false, continueOnError: null, shell: null };
      job.steps.push(step);
      parseStepKey(stripped.slice(2));
      continue;
    }
    if (indent === 8 && step) parseStepKey(stripped);
  }
  if (block) endBlock();
  for (const j of Object.values(jobs)) {
    for (const s of j.steps) s.shell = s.shell ?? j.shell ?? workflowShell;
  }
  return jobs;
}

/** `|`/`>` block scalar header with optional indentation/chomping indicators. */
const BLOCK_SCALAR = /^[|>](?:[1-9]?[-+]?|[-+][1-9])(?:\s+#.*)?$/;

/** Value of an inline YAML scalar: unquote quoted forms, drop a plain scalar's ` #` comment. */
const yamlScalar = (value) => {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return value.replace(/(^|\s)#.*$/, '').trim();
};

/**
 * Canonical gate contract, narrowed after the #186 review. This is
 * deliberately not a shell parser: it accredits one exact command form as a
 * statement of its own, and anything outside it accredits nothing, so
 * extending the subset needs a fixture proving the new form is real execution.
 *
 * - Operators (`&&`, `||`, `;`, `|`, `&`, newline) count only outside quotes
 *   and comments; `&` inside a redirection (`2>&1`, `&>`) is not an operator.
 * - A run whose syntax leaves the subset accredits nothing: unterminated
 *   quotes, ANSI-C $'...' quoting, line continuations, heredocs, command
 *   substitution, control flow or function definitions, exit/exec/eval/
 *   source/trap/alias, `set +...`.
 * - The check is the literal command `node scripts/i18n-inventory.mjs --check`
 *   — exactly those three words (single-word quoting aside). No other word,
 *   flag or redirection accredits it: `--out --check` makes the CLI consume
 *   `--check` as the output file name, so searching for the word among the
 *   arguments would accredit an invocation that never verifies anything.
 * - The check counts only in statement position: the separator before and
 *   after it must be '', ';' or a newline. Not after `&&`/`||` (execution is
 *   conditional: under GitHub's `bash -e`, a failing left side silently skips
 *   it and later statements can leave the step green) and not before `&&`,
 *   `||`, `|` or `&` (a later operator can mask its failure). Statement
 *   position is what the workflow already uses: a dedicated step running the
 *   canonical command.
 * - The steps run under GitHub's default `bash -e`/`sh -e`, so a step or job
 *   with `if:`, a `continue-on-error` other than `false`, or a shell other
 *   than bash/sh is not a gate either.
 * - The install is the command `npm ci` or `npm install` (leading words), as a
 *   statement of its own under the same rules.
 */
const unwrapQuotes = (word) => word.replace(/^(['"])(.*)\1$/, '$2');

const CONTROL_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select',
  'function', '{', '}', '!', 'exit', 'return', 'exec', 'eval', 'source', '.', 'trap', 'alias',
]);

/**
 * Split a run command into simple commands, each with the operator after it
 * ('' at the end). Returns null when the command leaves the supported subset.
 */
const splitShellCommands = (cmd) => {
  const commands = [];
  let current = '';
  let quote = null;
  let invalid = false;
  const push = (op) => {
    if (current.trim()) commands.push({ text: current, op });
    else if (op !== '\n' && op !== '') invalid = true; // an operator with no command before it
    current = '';
  };
  for (let i = 0; i < cmd.length && !invalid; i += 1) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && next === '(')) return null; // command substitution
    if (ch === '$' && next === "'") return null; // ANSI-C quoting, where \' does not close the quote
    if (ch === '\\') {
      if (next === undefined || next === '\n') return null; // line continuation
      current += ch + next;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '#' && (current === '' || /\s$/.test(current))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i += 1;
    } else if (ch === '<' && next === '<') {
      return null; // heredoc or here-string
    } else if ((ch === '&' || ch === '|') && next === ch) {
      push(ch + ch);
      i += 1;
    } else if (ch === '&' && (next === '>' || current.endsWith('>'))) {
      current += ch; // redirection, not background
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      push(ch);
    } else {
      current += ch;
    }
  }
  if (quote || invalid) return null;
  push('');
  return commands;
};

const commandWords = (text) => text.trim().split(/\s+/).map(unwrapQuotes);

const leavesSubset = ([first, ...args]) =>
  CONTROL_WORDS.has(first) ||
  /^[({]|\)$/.test(first) ||
  (first === 'set' && args.some((a) => a.startsWith('+')));

/** Separators that make a command a statement of its own: unconditional execution, failure not masked. */
const STATEMENT_SEPARATORS = new Set(['', ';', '\n']);

/** The only command the workflow admits as the verification gate. */
const CHECK_COMMAND = ['node', 'scripts/i18n-inventory.mjs', '--check'];

/** Ordered 'install'/'check' events a run command performs as gates. */
const runEvents = (cmd) => {
  const commands = splitShellCommands(cmd);
  if (!commands) return [];
  const parsed = commands.map((c, i) => ({ words: commandWords(c.text), before: i > 0 ? commands[i - 1].op : '', after: c.op }));
  if (parsed.some(({ words }) => leavesSubset(words))) return [];
  return parsed
    .filter(({ before, after }) => STATEMENT_SEPARATORS.has(before) && STATEMENT_SEPARATORS.has(after))
    .map(({ words }) => {
      const isCheck = words.length === CHECK_COMMAND.length && CHECK_COMMAND.every((w, i) => words[i] === w);
      if (isCheck) return 'check';
      if (words[0] === 'npm' && (words[1] === 'ci' || words[1] === 'install')) return 'install';
      return null;
    })
    .filter(Boolean);
};

/** True when a run command executes the check as a gate. */
const runsCheck = (cmd) => runEvents(cmd).includes('check');

const failsTheJob = (continueOnError) => continueOnError === null || continueOnError === 'false';
const isShellStep = (shell) => shell === null || ['bash', 'sh'].includes(shell.split(/\s+/)[0]);

/** A job installs dependencies and runs the inventory check afterwards (command order). */
const runsCheckAfterInstall = (jobs) =>
  Object.values(jobs).some((job) => {
    if (job.if || !failsTheJob(job.continueOnError)) return false;
    const events = job.steps
      .filter((s) => s.run !== null && !s.if && failsTheJob(s.continueOnError) && isShellStep(s.shell))
      .flatMap((s) => runEvents(s.run));
    const install = events.indexOf('install');
    return install >= 0 && events.indexOf('check', install + 1) > install;
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

test('echoing the check command is not executing it (#160)', () => {
  const echoOnly = [
    'name: CI',
    'jobs:',
    '  checks:',
    '    steps:',
    '      - run: npm ci',
    '      - run: echo "node scripts/i18n-inventory.mjs --check"',
    '  ',
  ].join('\n');
  assert.equal(runsCheckAfterInstall(parseWorkflowRuns(echoOnly)), false, 'printing the check cannot accredit its execution');
  // The substring contract accepted exactly this workflow: pin why it had to go.
  assert.ok(
    /\bnode scripts\/i18n-inventory\.mjs --check\b/.test(echoOnly),
    'documentation: the replaced substring regex matched the echo mention',
  );

  const compound = [
    'jobs:',
    '  checks:',
    '    steps:',
    '      - run: npm ci',
    '      - run: echo "inventory gate" && node scripts/i18n-inventory.mjs --check',
    '  ',
  ].join('\n');
  assert.equal(
    runsCheckAfterInstall(parseWorkflowRuns(compound)),
    false,
    'a check after && runs only if echo succeeds: not a gate (#186 review)',
  );
});

test('separators inside quotes or comments do not fabricate a check segment (#160)', () => {
  assert.equal(
    runsCheck('echo "texto; node scripts/i18n-inventory.mjs --check ;fin"'),
    false,
    'a ; inside a quoted echo argument is data, not a separator',
  );
  assert.equal(
    runsCheck("echo 'texto; node scripts/i18n-inventory.mjs --check'"),
    false,
    'a ; inside a single-quoted argument is data, not a separator',
  );
  assert.equal(
    runsCheck('# texto; node scripts/i18n-inventory.mjs --check'),
    false,
    'a ; inside a comment is not a separator',
  );
  assert.equal(
    runsCheck('npm test # then; node scripts/i18n-inventory.mjs --check'),
    false,
    'a trailing comment cannot accredit the check',
  );
  assert.equal(
    runsCheck('echo "texto" && node scripts/i18n-inventory.mjs --check'),
    false,
    'after && the check is conditional execution, quotes closed or not (#186 review)',
  );

  const quotedInWorkflow = [
    'jobs:',
    '  checks:',
    '    steps:',
    '      - run: npm ci',
    '      - run: echo "texto; node scripts/i18n-inventory.mjs --check ;fin"',
    '  ',
  ].join('\n');
  assert.equal(runsCheckAfterInstall(parseWorkflowRuns(quotedInWorkflow)), false, 'the quoted mention is rejected end to end');
});

/** One job that installs and then runs the given step lines (6-space `- ` indent). */
const workflowWith = (...stepLines) =>
  ['jobs:', '  checks:', '    steps:', '      - run: npm ci', ...stepLines, '  '].join('\n');
const accredits = (yaml) => runsCheckAfterInstall(parseWorkflowRuns(yaml));
const CHECK = 'node scripts/i18n-inventory.mjs --check';

test('block runs keep their shell meaning across lines (#160)', () => {
  const quoteAcrossLines = workflowWith('      - run: |', '          echo "inicio', `          ${CHECK}`, '          fin"');
  assert.equal(accredits(quoteAcrossLines), false, 'a quote spanning lines keeps the check as data');
  const continuation = workflowWith('      - run: |', '          echo \\', `          ${CHECK}`);
  assert.equal(accredits(continuation), false, 'a line continuation makes the check an echo argument');
  const heredoc = workflowWith('      - run: |', '          cat <<EOF', `          ${CHECK}`, '          EOF');
  assert.equal(accredits(heredoc), false, 'heredoc content is data');
  const folded = workflowWith('      - run: >', '          npm test', `          ${CHECK}`);
  assert.equal(accredits(folded), false, 'a folded block joins the lines into one npm command');
  const blankLine = workflowWith('      - run: |', '          # gate', '', `          ${CHECK}`);
  assert.equal(accredits(blankLine), true, 'comment and blank lines inside a literal block do not hide a real check');
});

test('control flow that may skip the check does not accredit it (#160)', () => {
  const ifFalse = workflowWith('      - run: |', '          if false; then', `            ${CHECK}`, '          fi');
  assert.equal(accredits(ifFalse), false, 'a check inside an if body may never run');
  const fn = workflowWith('      - run: |', '          gate() {', `            ${CHECK}`, '          }');
  assert.equal(accredits(fn), false, 'a function defined but never called runs nothing');
  const exitFirst = workflowWith('      - run: |', '          exit 0', `          ${CHECK}`);
  assert.equal(accredits(exitFirst), false, 'a check after exit never runs');
  assert.equal(accredits(workflowWith(`      - run: true || ${CHECK}`)), false, 'a check after || runs only when the left side fails');
  assert.equal(accredits(workflowWith('      - run: |', '          true ||', `          ${CHECK}`)), false, '|| continues across a newline');
  assert.equal(accredits(workflowWith(`      - run: echo "$(${CHECK})"`)), false, 'command substitution discards the exit code');
  assert.equal(accredits(workflowWith(`      - run: echo \`${CHECK}\``)), false, 'backtick substitution discards the exit code');
  assert.equal(runsCheck(`echo $'a\\' ; ${CHECK} ; \\'' x`), false, 'ANSI-C quoting keeps an escaped quote open');
});

test('a check after && is conditional execution and accredits nothing (#186 review)', () => {
  // Maintainer repro: under GitHub's default `bash -e`, `false` is exempt from
  // errexit as a non-final `&&` member, node never runs, and the trailing echo
  // leaves the step green. Being after `&&` does not accredit execution.
  assert.equal(runsCheck(`false && ${CHECK}\necho terminado`), false, 'a && guard can skip the check and stay green');
  assert.equal(
    accredits(workflowWith('      - run: |', `          false && ${CHECK}`, '          echo terminado')),
    false,
    'end to end: the guarded check leaves no gate',
  );
});

test('a --check word consumed as the value of --out is not the check (#186 review)', () => {
  // `--out` takes the next token, so `--out --check` writes the document to a
  // file named `--check` instead of verifying anything. Finding the word among
  // the arguments accredits an invocation that never checks.
  assert.equal(runsCheck('node scripts/i18n-inventory.mjs --out --check'), false, 'the flag must be parsed as argv, not searched');
  assert.equal(
    accredits(workflowWith('      - run: node scripts/i18n-inventory.mjs --out --check')),
    false,
    'end to end: only the literal canonical invocation is a gate',
  );
});

test('a check whose failure cannot fail the step does not accredit it (#160)', () => {
  assert.equal(accredits(workflowWith(`      - run: ${CHECK} || true`)), false, '|| true masks the failure');
  assert.equal(accredits(workflowWith(`      - run: ${CHECK} | tee out.txt`)), false, 'a pipe reports the exit code of tee');
  assert.equal(accredits(workflowWith(`      - run: ${CHECK} &`)), false, 'a background check is never awaited');
  assert.equal(accredits(workflowWith('      - run: |', '          set +e', `          ${CHECK}`)), false, 'set +e lets the step pass after a failed check');
  assert.equal(accredits(workflowWith(`      - run: ${CHECK} && echo ok`)), false, 'a check before && can be masked by later statements; only statement position accredits (#186 review)');
  assert.equal(accredits(workflowWith(`      - run: ${CHECK} 2>&1`)), false, 'only the literal canonical command accredits; extra words are not the gate (#186 review)');
  assert.equal(accredits(workflowWith(`      - run: ${CHECK} > report.txt`)), false, 'an output redirection is not the canonical invocation (#186 review)');
});

test('compound runs still accredit the check in statement position (#186 review)', () => {
  assert.equal(accredits(workflowWith(`      - run: npm test; ${CHECK}`)), true, 'a ;-separated check runs unconditionally and fails the step under bash -e');
  assert.equal(accredits(workflowWith('      - run: |', `          ${CHECK}`, '          echo done')), true, 'a failed plain check still fails the step before any later statement');
});

test('step and job settings that skip or tolerate the check do not accredit it (#160)', () => {
  const step = (...keys) => workflowWith(`      - run: ${CHECK}`, ...keys.map((k) => `        ${k}`));
  assert.equal(accredits(step("if: github.event_name == 'push'")), false, 'a conditional step may be skipped');
  assert.equal(accredits(step('continue-on-error: true')), false, 'a step allowed to fail is not a gate');
  assert.equal(accredits(step('continue-on-error: false')), true, 'continue-on-error: false keeps the gate');
  assert.equal(accredits(step('shell: python')), false, 'a python step does not run shell commands');
  assert.equal(accredits(step('shell: bash')), true, 'an explicit bash shell keeps the gate');

  const job = (key) => ['jobs:', '  checks:', `    ${key}`, '    steps:', '      - run: npm ci', `      - run: ${CHECK}`, '  '].join('\n');
  assert.equal(accredits(job('if: false')), false, 'a conditional job may be skipped');
  assert.equal(accredits(job('continue-on-error: true')), false, 'a job allowed to fail is not a gate');

  const jobDefaults = ['jobs:', '  checks:', '    defaults:', '      run:', '        shell: pwsh', '    steps:', '      - run: npm ci', `      - run: ${CHECK}`, '  '].join('\n');
  assert.equal(accredits(jobDefaults), false, 'a job default shell outside bash/sh is not the supported subset');
  const workflowDefaults = ['defaults:', '  run:', '    shell: python', 'jobs:', '  checks:', '    steps:', '      - run: npm ci', `      - run: ${CHECK}`, '  '].join('\n');
  assert.equal(accredits(workflowDefaults), false, 'a workflow default shell outside bash/sh is not the supported subset');

  const actionInput = workflowWith('      - uses: some/action@v1', '        with:', `          run: ${CHECK}`);
  assert.equal(accredits(actionInput), false, 'a run input of an action is not a run step');
});

test('YAML-quoted run scalars are unquoted before the shell sees them (#160)', () => {
  assert.equal(accredits(workflowWith(`      - run: "${CHECK}"`)), true, 'a double-quoted YAML scalar is the plain command');
  assert.equal(accredits(workflowWith(`      - run: "echo 'x; ${CHECK}'"`)), false, 'the shell quotes inside a YAML scalar still hold');
  assert.equal(accredits(workflowWith(`      - run: 'echo "x; ${CHECK}"'`)), false, 'the shell quotes inside a single-quoted YAML scalar still hold');
});

test('mentioning npm ci is not installing (#160)', () => {
  const mentioned = (cmd) => ['jobs:', '  checks:', '    steps:', `      - run: ${cmd}`, `      - run: ${CHECK}`, '  '].join('\n');
  assert.equal(accredits(mentioned('echo "npm ci"')), false, 'echoing npm ci installs nothing');
  assert.equal(accredits(mentioned('npm test # npm ci')), false, 'a commented npm ci installs nothing');
  assert.equal(accredits(mentioned('npm ci')), true, 'a real npm ci before the check counts');
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

test('CLI: --out consumes the next token, so `--out --check` writes, never checks (#186 review)', () => {
  const dir = makeRepo();
  try {
    const res = run(dir, '--out', '--check');
    assert.equal(res.status, 0, 'the invocation writes the document');
    assert.equal(fs.existsSync(path.join(dir, '--check')), true, '--check became the output file name');
    assert.equal(fs.existsSync(path.join(dir, 'docs/i18n-inventory.md')), false, 'the default output was not verified');
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
