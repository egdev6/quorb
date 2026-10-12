import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { normalizeSnapshotReport } from './snapshot-report.mjs';
import { exportSnapshot } from './export-snapshot.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve('inert-snapshot');
const inventory = () => ({
  commit: 'a'.repeat(40), root,
  targets: [
    { path: join(root, '000000.ts'), originalPath: 'src/a.ts', sha256: 'b'.repeat(64) },
    { path: join(root, '000001.js'), originalPath: '.hidden/b.js', sha256: 'c'.repeat(64) },
  ],
  excluded: [{ path: 'assets/logo.png', reason: 'outside-js-ts-scope' }],
});
const report = () => ({
  version: '1.180.0', errors: [], skipped_rules: [],
  paths: { scanned: ['/inputs/000000.ts', '/inputs/000001.js'] },
  results: [{ check_id: 'inputs.decoded-text-execution', path: '/inputs/000001.js',
    start: { line: 2 }, extra: { severity: 'WARNING', lines: 'SECRET SOURCE', message: 'SECRET MESSAGE' } }],
});

test('binds findings to original paths and preserves explicit excluded scope', () => {
  const manifest = inventory();
  const raw = report();
  const before = JSON.stringify({ manifest, raw });
  const out = normalizeSnapshotReport(raw, manifest);
  assert.deepEqual(out, {
    commit: manifest.commit, status: 'completed', scannedFiles: 2,
    excluded: manifest.excluded,
    findings: [{ rule: 'decoded-text-execution', path: '.hidden/b.js', line: 2, severity: 'advisory' }],
  });
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.ok(!JSON.stringify(out).includes(root));
  assert.equal(JSON.stringify({ manifest, raw }), before);
});

test('scanner cannot redefine expected coverage by removing or adding files', () => {
  for (const scanned of [[], ['/inputs/000001.js'], ['/inputs/000000.ts', '/inputs/000001.js', '/inputs/extra.js']]) {
    const raw = report(); raw.paths.scanned = scanned;
    assert.throws(() => normalizeSnapshotReport(raw, inventory()), { message: 'invalid-snapshot-report' });
  }
});

test('rejects unsafe, ambiguous or malformed manifest mappings', () => {
  const cases = [null, {}, { ...inventory(), root: '.' }, { ...inventory(), commit: 'HEAD' }];
  for (const patch of [
    { path: join(root, '..', '000000.ts') }, { path: join(root, 'nested', '000000.ts') },
    { originalPath: '../escape.ts' }, { originalPath: 'BAD\u202e.ts' }, { sha256: 'bad' },
  ]) {
    const m = inventory(); Object.assign(m.targets[0], patch); cases.push(m);
  }
  const duplicate = inventory(); duplicate.targets[1] = { ...duplicate.targets[0] }; cases.push(duplicate);
  const overlap = inventory(); overlap.excluded[0].path = 'src/a.ts'; cases.push(overlap);
  const hidden = inventory(); hidden.excluded[0].reason = 'SECRET'; cases.push(hidden);
  for (const m of cases) assert.throws(() => normalizeSnapshotReport(report(), m), { message: 'invalid-snapshot-report' });
});

test('consumes a real Git export with an inert synthetic scanner report', t => {
  const base = mkdtempSync(join(tmpdir(), 'snapshot-binding-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo'); mkdirSync(repo);
  const hooks = join(base, 'hooks'); mkdirSync(hooks);
  const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: base, GIT_CONFIG_NOSYSTEM: '1' },
  }).toString().trim();
  git('init', '-q');
  writeFileSync(join(repo, 'a.ts'), 'void 0;');
  writeFileSync(join(repo, 'README.md'), 'Excluded, not analyzed.');
  git('add', '.'); git('commit', '-qm', 'inert fixture');
  const manifest = exportSnapshot({ repo, commit: git('rev-parse', 'HEAD'), parent: base });
  const raw = { version: '1.180.0', errors: [], skipped_rules: [], paths: { scanned: ['/inputs/000000.ts'] }, results: [] };
  assert.deepEqual(normalizeSnapshotReport(raw, manifest), {
    commit: manifest.commit, status: 'completed', scannedFiles: 1,
    excluded: [{ path: 'README.md', reason: 'outside-js-ts-scope' }], findings: [],
  });
});

test('keeps scanner errors and skipped rules as failures, not empty findings', () => {
  for (const patch of [{ errors: ['SECRET ERROR'] }, { skipped_rules: ['rule'] }]) {
    assert.throws(() => normalizeSnapshotReport({ ...report(), ...patch }, inventory()), { message: 'invalid-snapshot-report' });
  }
});
