// DRAFT Unit 2 slice tests — trusted normalizer for inert Semgrep JSON.
// Findings are advisory evidence, never a malware/secret verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSemgrep } from './semgrep-report.mjs';

const ROOT = '/snapshot';
const TARGETS = ['/snapshot/a.js', '/snapshot/b.ts'];
const report = (results = [], scanned = TARGETS) => ({
  version: '1.180.0',
  errors: [],
  skipped_rules: [],
  paths: { scanned },
  results,
});
const result = (o = {}) => ({
  check_id: 'inputs.decoded-text-execution',
  path: '/snapshot/a.js',
  start: { line: 1 },
  extra: { severity: 'WARNING', message: 'SECRET-MESSAGE', lines: 'SECRET-SNIPPET', metadata: { secret: 'SECRET-META' } },
  ...o,
});
const call = (r, expected = TARGETS, root = ROOT) => normalizeSemgrep(r, expected, { root });

test('valid zero-finding report completes with scanned count', () => {
  assert.deepEqual(call(report()), { status: 'completed', scannedFiles: 2, findings: [] });
});

test('known rules map to advisory findings with canonical rule ids', () => {
  const out = call(report([
    result({ start: { line: 3 } }),
    result({ check_id: 'inputs.dynamic-function-construction', path: '/snapshot/b.ts', start: { line: 5 } }),
    result({ check_id: 'inputs.shell-command-execution', start: { line: 7 }, extra: {} }),
  ]));
  assert.equal(out.status, 'completed');
  assert.equal(out.scannedFiles, 2);
  assert.deepEqual(out.findings, [
    { rule: 'decoded-text-execution', path: '/snapshot/a.js', line: 3, severity: 'advisory' },
    { rule: 'dynamic-function-construction', path: '/snapshot/b.ts', line: 5, severity: 'advisory' },
    { rule: 'shell-command-execution', path: '/snapshot/a.js', line: 7, severity: 'advisory' },
  ]);
});

test('raw scanner messages, snippets, metadata and extra fields never reach output', () => {
  const text = JSON.stringify(call(report([result()])));
  for (const needle of ['SECRET-MESSAGE', 'SECRET-SNIPPET', 'SECRET-META', 'message', 'lines', 'metadata', 'fingerprint']) {
    assert.ok(!text.includes(needle), `leaked ${needle}`);
  }
});

test('all findings are preserved without truncation', () => {
  const results = Array.from({ length: 50 }, (_, i) => result({
    path: i % 2 ? '/snapshot/b.ts' : '/snapshot/a.js',
    start: { line: i + 1 },
  }));
  assert.equal(call(report(results)).findings.length, 50);
});

test('scanner errors are an operational rejection', () => {
  assert.throws(() => call({ ...report(), errors: [{ message: 'boom' }] }), /invalid-semgrep-report/);
});

test('skipped rules and missing or malformed rule-coverage evidence are rejected', () => {
  for (const skipped_rules of [[{ rule_id: 'decoded-text-execution' }], undefined, null, {}, '']) {
    assert.throws(() => call({ ...report(), skipped_rules }), { message: 'invalid-semgrep-report' });
  }
});

test('empty or duplicate expected target sets are rejected', () => {
  assert.throws(() => normalizeSemgrep(report(), [], { root: ROOT }), /invalid-semgrep-report/);
  assert.throws(() => normalizeSemgrep(report(), ['/snapshot/a.js', '/snapshot/a.js'], { root: ROOT }), /invalid-semgrep-report/);
});

test('scanned set must match expected exactly: no missing, unexpected or duplicate', () => {
  assert.throws(() => normalizeSemgrep(report(), ['/snapshot/a.js', '/snapshot/missing.js'], { root: ROOT }), /invalid-semgrep-report/);
  assert.throws(() => normalizeSemgrep(report([], ['/snapshot/a.js', '/snapshot/b.ts', '/snapshot/extra.js']), TARGETS, { root: ROOT }), /invalid-semgrep-report/);
  assert.throws(() => normalizeSemgrep(report([], ['/snapshot/a.js', '/snapshot/a.js']), ['/snapshot/a.js'], { root: ROOT }), /invalid-semgrep-report/);
});

test('paths outside root, traversal aliases or control bytes are rejected', () => {
  assert.throws(() => call(report(), TARGETS, '/snapshot/sub'), /invalid-semgrep-report/);
  assert.throws(() => normalizeSemgrep(report(), ['/snapshot/a.js', '/snapshot/../snapshot/b.ts'], { root: ROOT }), /invalid-semgrep-report/);
  assert.throws(() => normalizeSemgrep(report(), ['/snapshot/a.js', '/snapshot/b\u0000.ts'], { root: ROOT }), /invalid-semgrep-report/);
  assert.throws(() => normalizeSemgrep(report(), ['/snapshot/a.js', '/snapshot/b\u202e.ts'], { root: ROOT }), /invalid-semgrep-report/);
  assert.throws(() => normalizeSemgrep(report(), TARGETS), /invalid-semgrep-report/);
});

test('finding path must be one of the scanned targets', () => {
  assert.throws(() => call(report([result({ path: '/snapshot/other.js' })])), /invalid-semgrep-report/);
});

test('finding line must be a positive integer', () => {
  for (const line of [0, -1, 1.5, '1', null, undefined]) {
    assert.throws(() => call(report([result({ start: { line } })])), /invalid-semgrep-report/, `line ${line}`);
  }
});

test('only the selected 1.180.0 scanner version is accepted', () => {
  assert.throws(() => call({ ...report(), version: '1.179.0' }), /invalid-semgrep-report/);
  assert.throws(() => call({ ...report(), version: '1.180.0-extra' }), /invalid-semgrep-report/);
  assert.throws(() => call({ ...report(), version: 1.18 }), /invalid-semgrep-report/);
});

test('unknown rule terminals and non-WARNING severities are rejected', () => {
  assert.throws(() => call(report([result({ check_id: 'inputs.unknown-rule' })])), /invalid-semgrep-report/);
  assert.throws(() => call(report([result({ check_id: 'inputs.decoded-text-execution\n' })])), /invalid-semgrep-report/);
  assert.throws(() => call(report([result({ extra: { severity: 'ERROR' } })])), /invalid-semgrep-report/);
});

test('malformed top-level and result shapes are rejected', () => {
  const cases = [null, [], {}, { ...report(), results: 'nope' }, { ...report(), errors: 'x' }, { ...report(), paths: {} }, { ...report(), paths: { scanned: 'x' } }, report([null]), report([[]]), report([{ check_id: 7 }]), report([result({ start: {} })]), report([result({ extra: 'x' })])];
  for (const bad of cases) assert.throws(() => call(bad), /invalid-semgrep-report/);
});
