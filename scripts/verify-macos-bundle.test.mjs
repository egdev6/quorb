import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyMacosBundle } from './verify-macos-bundle.mjs';

const sourceSha = 'a'.repeat(40);
const root = path.resolve('/repo');
const bundle = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const app = path.join(bundle, 'macos', 'Quorb.app');
const dmg = path.join(bundle, 'dmg', 'Quorb.dmg');

function fixture() {
  const files = new Map();
  const dir = (name) => files.set(name, { type: 'directory' });
  const file = (name, data) => files.set(name, { type: 'file', data });
  for (const name of [root, path.join(root, 'src-tauri'), path.join(root, 'src-tauri', 'target'),
    path.join(root, 'src-tauri', 'target', 'release'), bundle, path.join(bundle, 'macos'), path.join(bundle, 'dmg'),
    app, path.join(app, 'Contents'), path.join(app, 'Contents', 'MacOS')]) dir(name);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  file(path.join(root, 'package.json'), JSON.stringify({ version: '0.6.0' }));
  file(path.join(root, 'src-tauri', 'tauri.macos.conf.json'), JSON.stringify({ bundle: { macOS: { minimumSystemVersion: '15.0' } } }));
  file(path.join(app, 'Contents', 'Info.plist'), 'plist');
  file(path.join(app, 'Contents', 'MacOS', 'quorb'), header);
  file(dmg, Buffer.from('disk image'));
  const plist = { CFBundleShortVersionString: '0.6.0', CFBundleIdentifier: 'es.egdev.quorb', CFBundleExecutable: 'quorb', LSMinimumSystemVersion: '15.0' };
  const calls = [];
  const io = {
    lstatSync(name) {
      const entry = files.get(name);
      if (!entry) throw new Error(`Missing: ${name}`);
      return Object.fromEntries(['file', 'directory', 'symbolicLink'].map((type) =>
        [`is${type[0].toUpperCase()}${type.slice(1)}`, () => entry.type === type]));
    },
    readdirSync: (name) => [...files.keys()].filter((key) => key.startsWith(`${name}${path.sep}`) && !key.slice(name.length + 1).includes(path.sep)).map((key) => key.slice(name.length + 1)),
    readFileSync: (name) => files.get(name).data,
  };
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === '/usr/bin/plutil') return JSON.stringify(plist);
    if (command === '/usr/bin/hdiutil') return '';
    throw new Error('Unexpected command');
  };
  return { files, plist, calls, verify: (overrides = {}) => verifyMacosBundle({ root, sourceSha, io, run, ...overrides }) };
}

test('verifies native bundle metadata, DMG integrity and source-linked digest without launching it', () => {
  const f = fixture();
  const report = f.verify();
  assert.equal(report.sourceSha, sourceSha);
  assert.equal(report.arch, 'arm64');
  assert.equal(report.version, '0.6.0');
  assert.equal(report.minimumSystemVersion, '15.0');
  assert.equal(report.dmgSha256, createHash('sha256').update('disk image').digest('hex'));
  assert.deepEqual(f.calls, [
    ['/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')]],
    ['/usr/bin/hdiutil', ['verify', dmg]],
  ]);
});

test('rejects missing, older or incorrect minimum macOS metadata and config', () => {
  for (const value of [undefined, '12.0', '14.0', '15', '16.0', 15, '15.0\n']) {
    const f = fixture();
    f.plist.LSMinimumSystemVersion = value;
    assert.throws(() => f.verify(), /minimum macOS/);
    const config = fixture();
    config.files.get(path.join(root, 'src-tauri', 'tauri.macos.conf.json')).data =
      JSON.stringify({ bundle: { macOS: { minimumSystemVersion: value } } });
    assert.throws(() => config.verify(), /minimum macOS/);
  }
});

test('rejects malformed minimum macOS configuration', () => {
  for (const data of ['{', 'null', '{}', '{"bundle":null}']) {
    const f = fixture();
    f.files.get(path.join(root, 'src-tauri', 'tauri.macos.conf.json')).data = data;
    assert.throws(() => f.verify(), /JSON|minimum macOS/);
  }
});

test('macOS config declares the minimum build target using the Tauri 2 field name', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.macos.conf.json', import.meta.url), 'utf8'));
  assert.equal(config.bundle.macOS?.minimumSystemVersion, '15.0');
});

test('rejects mismatched metadata and unsafe executable names', () => {
  for (const [key, value] of [['CFBundleShortVersionString', '9.0.0'], ['CFBundleIdentifier', 'other'],
    ['CFBundleExecutable', '../quorb'], ['CFBundleExecutable', '/bin/sh'], ['CFBundleExecutable', '..'], ['CFBundleExecutable', 'a;id']]) {
    const f = fixture();
    f.plist[key] = value;
    assert.throws(() => f.verify(), /version|identifier|executable/);
  }
});

test('rejects missing or ambiguous app and DMG bundles', () => {
  for (const target of [app, dmg]) {
    const f = fixture();
    f.files.delete(target);
    assert.throws(() => f.verify(), /exactly one/);
    f.files.set(target, { type: target === app ? 'directory' : 'file' });
    f.files.set(target.replace('Quorb', 'Other'), f.files.get(target));
    assert.throws(() => f.verify(), /exactly one/);
  }
});

test('rejects missing executable, symlinks at every path level and non-native Mach-O', () => {
  const executable = path.join(app, 'Contents', 'MacOS', 'quorb');
  const missing = fixture();
  missing.files.delete(executable);
  assert.throws(() => missing.verify(), /Missing/);
  for (const target of [root, path.join(bundle, 'macos'), app, path.join(app, 'Contents'), path.join(app, 'Contents', 'Info.plist'), executable, dmg]) {
    const f = fixture();
    f.files.set(target, { type: 'symbolicLink' });
    assert.throws(() => f.verify(), /symlink/);
  }
  for (const [offset, value] of [[0, 0xcafebabe], [4, 0x01000007], [12, 6]]) {
    const f = fixture();
    f.files.get(executable).data.writeUInt32LE(value, offset);
    assert.throws(() => f.verify(), /Mach-O/);
  }
});

test('fails closed on invalid plist, command failures, truncated binary and missing source SHA', () => {
  const f = fixture();
  assert.throws(() => f.verify({ run: () => '{' }), /JSON/);
  assert.throws(() => f.verify({ run: (command) => {
    if (command.endsWith('plutil')) return JSON.stringify(f.plist);
    throw new Error('hdiutil exit 1');
  } }), /hdiutil exit 1/);
  f.files.get(path.join(app, 'Contents', 'MacOS', 'quorb')).data = Buffer.alloc(4);
  assert.throws(() => f.verify(), /Mach-O/);
  assert.throws(() => f.verify({ sourceSha: '' }), /SHA/);
});

test('rejects malformed source provenance and propagates plist tool failure', () => {
  for (const sha of ['', 'a'.repeat(39), 'g'.repeat(40), `${sourceSha}\n`, `${sourceSha};id`]) {
    assert.throws(() => fixture().verify({ sourceSha: sha }), /SHA/);
  }
  assert.throws(() => fixture().verify({ run: () => { throw new Error('plutil exit 1'); } }), /plutil exit 1/);
});
