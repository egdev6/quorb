import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { exportSnapshot } from './export-snapshot.mjs';

function fixture(t, files = { 'src/a.ts': 'export const n = 1;' }) {
  const base = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  mkdirSync(repo); mkdirSync(join(base, 'hooks')); mkdirSync(join(base, 'out'));
  const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${join(base, 'hooks')}`, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: base, GIT_CONFIG_NOSYSTEM: '1' },
  }).toString().trim();
  git('init', '-q');
  for (const [path, bytes] of Object.entries(files)) {
    const dest = join(repo, path); mkdirSync(join(dest, '..'), { recursive: true }); writeFileSync(dest, bytes);
  }
  git('add', '.'); git('commit', '-qm', 'inert fixture');
  const commit = git('rev-parse', 'HEAD');
  return { repo, commit, parent: join(base, 'out'), git };
}

test('exports committed bytes only with independent hashes and explicit exclusions', t => {
  const f = fixture(t, { 'src/a.ts': 'export const n = 1;', '.hidden/b.js': 'void 0;', '.semgrepignore': '**', 'readme.md': 'out of scope' });
  writeFileSync(join(f.repo, 'src/a.ts'), 'DIRTY SECRET');
  const out = exportSnapshot(f);
  assert.equal(out.commit, f.commit);
  assert.equal(out.targets.length, 2);
  assert.equal(out.excluded.length, 2);
  for (const target of out.targets) {
    const bytes = readFileSync(target.path);
    assert.equal(target.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(!bytes.includes('DIRTY SECRET'));
    assert.ok(target.path.startsWith(out.root + sep));
  }
  assert.ok(out.targets.some(x => x.originalPath === '.hidden/b.js'));
  assert.ok(!existsSync(join(out.root, '.semgrepignore')));
});

test('canonicalizes module TypeScript without changing bytes or original identity', t => {
  const files = Object.fromEntries(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].map(ext => [`a.${ext}`, 'const x = 1;\n']));
  const out = exportSnapshot(fixture(t, files));
  assert.equal(out.targets.length, 8);
  for (const target of out.targets) {
    const ext = target.originalPath.split('.').at(-1);
    const expected = ['mts', 'cts'].includes(ext) ? 'ts' : ext;
    assert.ok(target.path.endsWith(`.${expected}`), target.originalPath);
    assert.equal(readFileSync(target.path, 'utf8'), files[target.originalPath]);
    assert.equal(target.sha256, createHash('sha256').update(files[target.originalPath]).digest('hex'));
  }
});

test('workflow scope exports only direct YAML workflows as inert hashed blobs', t => {
  const f = fixture(t, { '.github/workflows/a.yml': 'name: A\n', '.github/workflows/b.yaml': 'name: B\n',
    '.github/workflows/nested/c.yml': 'name: ignored\n', 'src/a.ts': 'void 0;', 'action.yml': 'name: action\n' });
  const out = exportSnapshot({ ...f, scope: 'workflows' });
  assert.equal(out.targets.length, 2);
  assert.deepEqual(out.targets.map(t => t.originalPath), ['.github/workflows/a.yml', '.github/workflows/b.yaml']);
  for (const target of out.targets) {
    assert.match(target.path, /\d{6}\.ya?ml$/);
    assert.equal(target.sha256, createHash('sha256').update(readFileSync(target.path)).digest('hex'));
  }
  assert.equal(out.excluded.length, 3);
  assert.ok(out.excluded.every(e => e.reason === 'outside-workflow-scope'));
  assert.throws(() => exportSnapshot({ ...f, scope: 'anything' }), { message: 'snapshot-export-failed' });
});

test('full commit ids required, not branch names or option strings', t => {
  const f = fixture(t);
  for (const commit of ['HEAD', '--help', f.commit.slice(0, 8), '0'.repeat(40)]) {
    assert.throws(() => exportSnapshot({ ...f, commit }), { message: 'snapshot-export-failed' });
  }
});

test('symlinks and gitlinks are rejected, never dereferenced', t => {
  for (const mode of ['120000', '160000']) {
    const f = fixture(t);
    const oid = mode === '160000' ? f.commit : f.git('rev-parse', `${f.commit}:src/a.ts`);
    f.git('update-index', '--add', '--cacheinfo', `${mode},${oid},linked`);
    f.git('commit', '-qm', 'inert mode');
    assert.throws(() => exportSnapshot({ ...f, commit: f.git('rev-parse', 'HEAD') }), { message: 'snapshot-export-failed' });
  }
});

test('binary and oversized source fail rather than silently disappearing', t => {
  for (const bytes of [Buffer.from([0]), Buffer.from([255]), Buffer.alloc(1024 * 1024 + 1, 65)]) {
    const f = fixture(t, { 'bad.ts': bytes });
    assert.throws(() => exportSnapshot(f), { message: 'snapshot-export-failed' });
  }
});

test('empty scanner scope is an explicit failure', t => {
  assert.throws(() => exportSnapshot(fixture(t, { 'readme.md': 'no source' })), { message: 'snapshot-export-failed' });
});

test('partial exports are cleaned on failure', t => {
  const f = fixture(t, { 'a.ts': 'void 0;', 'z.ts': Buffer.from([0]) });
  assert.throws(() => exportSnapshot(f), { message: 'snapshot-export-failed' });
  assert.deepEqual(readdirSync(f.parent), []);
});

test('ambient Git overrides cannot redirect the snapshot', t => {
  const f = fixture(t);
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.parent, 'missing');
  try { assert.equal(exportSnapshot(f).targets.length, 1); }
  finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
});

test('control-bearing paths fail without exposing their text', t => {
  const f = fixture(t, { 'SECRET\u202e.ts': 'void 0;' });
  assert.throws(() => exportSnapshot(f), { message: 'snapshot-export-failed' });
});
