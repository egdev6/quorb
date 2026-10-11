// Retirement guard for the removed Dev installer/channel/local feed.
//
// The Dev channel (CI workflow, generated overlay, feed helper, updater endpoint)
// and the local Dev feed (PowerShell wrapper, loopback HTTP overlay) are gone.
// Only `npm run app:dev` (Vite + Tauri hot reload) remains as a developer flow.
//
// This test protects two contracts:
//   1. No Dev identity, endpoint, script or workflow survives in the shipped tree.
//   2. The stable runtime is preserved: identity, defaults, keyring/migration and
//      the `app:dev` script are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const abs = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(abs(rel));

// Artifacts that only ever belonged to the Dev channel / local Dev feed.
const REMOVED_ARTIFACTS = [
  '.github/workflows/dev.yml',
  'scripts/dev-channel.mjs',
  'scripts/dev-channel.test.mjs',
  'scripts/dev-local-update.mjs',
  'scripts/dev-local-update.test.mjs',
  'scripts/build-dev-local.ps1',
  'scripts/build-dev-local.test.mjs',
  'src-tauri/tauri.dev.conf.json',
  'src-tauri/tauri.dev-local.conf.json',
  'docs/dev-local-updates.md',
];

// Tokens that can only describe the removed Dev identity or its endpoints.
const DEV_TOKENS = [
  /es\.egdev\.quorb\.dev/,
  /Quorb Dev/,
  /quorb-dev/i,
  /\bis_dev\b/,
  /dev-channel/,
  /dev-local/,
  /tauri\.dev(?:-local)?\.conf/,
  /\.dev-build/,
  /dev-latest/,
  /127\.0\.0\.1:17431/,
];

// Directories that ship in the app / CI, excluding node_modules, dist and target.
const SCAN_DIRS = ['.github/workflows', 'scripts', 'src', 'src-tauri/src'];
const SCAN_FILES = [
  'package.json',
  '.gitignore',
  'CONTRIBUTING.md',
  'README.md',
  'README.es.md',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.release.conf.json',
  'src-tauri/Cargo.toml',
];
// This file documents the removed tokens on purpose, so it never scans itself.
const SELF = path.resolve(import.meta.filename);

function* filesUnder(relDir) {
  const dir = abs(relDir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(rel);
    else yield rel;
  }
}

function devTokenOffenders(files) {
  const offenders = [];
  for (const rel of files) {
    if (path.resolve(abs(rel)) === SELF || !exists(rel)) continue;
    const text = read(rel);
    for (const token of DEV_TOKENS) {
      if (token.test(text)) offenders.push(`${rel} matches ${token}`);
    }
  }
  return offenders;
}

function scannedFiles() {
  return [...SCAN_DIRS.flatMap((dir) => [...filesUnder(dir)]), ...SCAN_FILES];
}

test('no Dev channel or local feed artifacts remain', () => {
  for (const rel of REMOVED_ARTIFACTS) {
    assert.equal(exists(rel), false, `${rel} must be removed`);
  }
});

test('no Dev identity, endpoint or script token survives the shipped tree', () => {
  const offenders = devTokenOffenders(scannedFiles());
  assert.deepEqual(offenders, [], `Dev tokens still present:\n${offenders.join('\n')}`);
});

test('stable identity and channel abstraction are preserved', () => {
  const channel = read('src-tauri/src/channel.rs');
  assert.match(channel, /identifier:\s*"es\.egdev\.quorb"/);
  assert.match(channel, /name:\s*"Quorb"/);
  assert.match(channel, /home_dir:\s*"\.quorb"/);
  assert.match(channel, /migrate_legacy:\s*true/);
  assert.doesNotMatch(channel, /DEV|is_dev/);

  const build = read('src-tauri/build.rs');
  assert.match(build, /"es\.egdev\.quorb"/);
  assert.match(build, /QUORB_IDENTIFIER/);

  const config = read('src-tauri/src/config.rs');
  assert.doesNotMatch(config, /is_dev/);

  // Keyring service + one-time legacy migration still go through the stable profile.
  const secrets = read('src-tauri/src/secrets.rs');
  assert.match(secrets, /crate::channel::current\(\)\.identifier/);
  assert.match(secrets, /crate::channel::current\(\)\.migrate_legacy/);
  assert.match(secrets, /const LEGACY_SERVICE: &str = "es\.egdev\.ai-usage"/);
});

test('stable Tauri config and its updater feed are untouched', () => {
  const base = readJson('src-tauri/tauri.conf.json');
  assert.equal(base.identifier, 'es.egdev.quorb');
  assert.equal(base.productName, 'Quorb');
  assert.deepEqual(base.plugins.updater.endpoints, [
    'https://github.com/egdev6/quorb/releases/latest/download/latest.json',
  ]);
  assert.ok(base.plugins.updater.pubkey, 'stable updater public key must remain');

  const release = readJson('src-tauri/tauri.release.conf.json');
  assert.equal(release.bundle.createUpdaterArtifacts, true);
});

test('npm scripts keep app:dev and stop referencing the removed Dev helpers', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['app:dev'], 'tauri dev');
  assert.equal(pkg.scripts['app:build'], 'tauri build');
  assert.equal(pkg.scripts['app:release'], 'tauri build --config src-tauri/tauri.release.conf.json');
  assert.equal(pkg.scripts.dev, 'vite');
  assert.equal(pkg.scripts.build, 'tsc --noEmit && vite build');
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit');

  const testScript = pkg.scripts.test;
  assert.ok(testScript.includes('scripts/dev-retirement.test.mjs'), 'npm test must run the retirement guard');
  for (const removed of ['dev-channel.test.mjs', 'build-dev-local.test.mjs', 'dev-local-update.test.mjs']) {
    assert.ok(!testScript.includes(removed), `npm test must not reference ${removed}`);
  }

  assert.doesNotMatch(read('.gitignore'), /\.dev-build/);
});
