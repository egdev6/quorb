import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkRelease, createGit, isValidSha, isValidUpdaterPubkey } from './release-check.mjs';

const SHA = 'a'.repeat(40);
const REAL_PUBKEY = Buffer.from('untrusted comment: minisign public key ABCDEF\nRWTESTKEY\n').toString('base64');
const NOT_MINISIGN = Buffer.from('this is not a minisign public key at all').toString('base64');

function manifest(version) {
  return {
    'package.json': JSON.stringify({ name: 'quorb', version }),
    'package-lock.json': JSON.stringify({ name: 'quorb', version, lockfileVersion: 3, packages: { '': { version } } }),
    'src-tauri/Cargo.toml': `[package]\nname = "quorb"\nversion = "${version}"\n`,
    'src-tauri/Cargo.lock': `[[package]]\nname = "quorb"\nversion = "${version}"\n`,
    'src-tauri/tauri.conf.json': JSON.stringify({ plugins: { updater: { pubkey: REAL_PUBKEY } } }),
    'docs/releases/v0.1.1.md': '# Quorb 0.1.1\n',
  };
}

function fakeGit(files, { ancestor = true, tag = false } = {}) {
  return { fileAt: (_sha, file) => files[file] ?? null, isAncestor: () => ancestor, tagExists: () => tag };
}

const run = (overrides = {}, opts = {}) => checkRelease({ version: '0.1.1', sourceSha: SHA, git: fakeGit({ ...manifest('0.1.1'), ...overrides }, opts) });

test('acepta una fuente coherente, anclada en origin/main y con notas', () => {
  assert.deepEqual(run(), []);
});

test('rechaza versiones inválidas o con inyección de shell', () => {
  for (const version of ['0.1', '0.1.1; touch pwned', '0.1.1$(id)', '0.1.1\nfoo', '../0.1.1']) {
    const errors = checkRelease({ version, sourceSha: SHA, git: fakeGit(manifest('0.1.1')) });
    assert.ok(
      errors.some((e) => /version inválida/i.test(e)),
      `esperaba error para ${JSON.stringify(version)}`,
    );
  }
});

test('rechaza SHA incompleto, no hexadecimal o alterado', () => {
  assert.equal(isValidSha(SHA), true);
  assert.equal(isValidSha('a'.repeat(39)), false);
  assert.equal(isValidSha('Z'.repeat(40)), false);
  for (const sha of ['a'.repeat(39), 'Z'.repeat(40), `${SHA}; id`, `${SHA}\n`]) {
    const errors = checkRelease({ version: '0.1.1', sourceSha: sha, git: fakeGit(manifest('0.1.1')) });
    assert.ok(
      errors.some((e) => /source_sha/i.test(e)),
      `esperaba error para ${JSON.stringify(sha)}`,
    );
  }
});

test('rechaza una fuente que no es ancestro de origin/main', () => {
  const errors = run({}, { ancestor: false });
  assert.ok(errors.some((e) => /origin\/main/.test(e)));
});

test('rechaza manifiestos cuya versión no coincide con la solicitada', () => {
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const errors = run({ [file]: manifest('0.1.1')[file].replaceAll('0.1.1', '0.1.0') });
    assert.ok(
      errors.some((e) => e.includes(file)),
      `esperaba error para ${file}`,
    );
  }
});

test('exige notas de la versión no vacías dentro del commit fuente', () => {
  const errors = run({ 'docs/releases/v0.1.1.md': null });
  assert.ok(errors.some((e) => /docs\/releases\/v0\.1\.1\.md/.test(e)));
  for (const notes of ['', '   \n  ', '\r\n']) {
    const blank = run({ 'docs/releases/v0.1.1.md': notes });
    assert.ok(
      blank.some((e) => /docs\/releases\/v0\.1\.1\.md/.test(e)),
      `esperaba error para notas ${JSON.stringify(notes)}`,
    );
  }
});

test('exige una clave pública de updater minisign real, no placeholder ni basura', () => {
  const bad = [
    'PEGA_AQUI_TU_CLAVE_PUBLICA',
    '  pega_aqui_tu_clave_publica  ',
    'PEGA-AQUI-TU-CLAVE-PUBLICA',
    '',
    '   ',
    NOT_MINISIGN,
    'not-base64!!',
    123,
    null,
  ];
  for (const pubkey of bad) {
    const errors = run({ 'src-tauri/tauri.conf.json': JSON.stringify({ plugins: { updater: { pubkey } } }) });
    assert.ok(
      errors.some((e) => /clave pública/.test(e)),
      `esperaba error para ${JSON.stringify(pubkey)}`,
    );
  }
  assert.equal(isValidUpdaterPubkey(REAL_PUBKEY), true);
});

test('rechaza el tag de la versión si ya existe', () => {
  const errors = run({}, { tag: true });
  assert.ok(errors.some((e) => /tag v0\.1\.1 ya existe/i.test(e)));
});

test('rechaza preestrenos: este flujo solo publica versiones estables', () => {
  const version = '0.1.1-rc.1';
  const errors = checkRelease({ version, sourceSha: SHA, git: fakeGit(manifest(version)) });
  assert.ok(errors.some((e) => /estable/i.test(e)));
});

test('createGit lee ficheros del commit y detecta ancestros reales', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'quorb-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'contenido\n');
  git('add', 'file.txt');
  git('commit', '-q', '-m', 'uno');
  const head = git('rev-parse', 'HEAD').trim();

  const api = createGit(repo);
  assert.equal(api.fileAt(head, 'file.txt'), 'contenido');
  assert.equal(api.isAncestor(head, 'HEAD'), true);
  assert.equal(api.isAncestor('b'.repeat(40), 'HEAD'), false);
  assert.equal(api.fileAt(head, 'no-existe.txt'), null);
  assert.equal(api.tagExists('v1.0.0'), false);
  git('tag', 'v1.0.0');
  assert.equal(api.tagExists('v1.0.0'), true);
});
