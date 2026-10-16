import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stagePreview, readbackPreview } from './macos-preview-artifact.mjs';
import { buildPreviewManifest } from './macos-preview-policy.mjs';

const root = path.resolve('fixture-root');
const sha = 'a'.repeat(40);
const secret = 'SECRET_FIXTURE_MARKER';
const upload = path.join(root, 'src-tauri', 'target', 'macos-preview-upload');
const download = path.join(root, 'src-tauri', 'target', 'macos-preview-download');
const dmg = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'dmg', 'Quorb.dmg');
const readme = path.join(root, 'docs', 'macos-preview-README.md');
const bytes = Buffer.from('simulated DMG, not an artifact');
const digest = createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const files = new Map();
  const put = (name, type, data) => files.set(name, { type, data });
  for (const name of [root, path.dirname(dmg), path.dirname(readme)]) {
    let current = name;
    while (current.startsWith(root)) {
      put(current, 'directory');
      if (current === root) break;
      current = path.dirname(current);
    }
  }
  put(path.join(root, 'package.json'), 'file', Buffer.from('{"version":"0.6.0"}'));
  put(dmg, 'file', bytes);
  put(readme, 'file', Buffer.from('Injected README only; no real preview delivery.'));
  const writes = [], calls = [];
  const io = {
    lstatSync(name) {
      const entry = files.get(name);
      if (!entry) throw new Error(secret);
      return Object.fromEntries(['file', 'directory', 'symbolicLink'].map((type) =>
        [`is${type[0].toUpperCase()}${type.slice(1)}`, () => entry.type === type]));
    },
    readFileSync(name, encoding) {
      if (!files.has(name)) throw new Error(secret);
      return encoding ? files.get(name).data.toString(encoding) : files.get(name).data;
    },
    readdirSync: (name) => [...files.keys()].filter((key) => path.dirname(key) === name).map((key) => path.basename(key)),
    mkdirSync(name, options) {
      writes.push(['mkdir', name]);
      assert.ok(!options?.recursive);
      if (files.has(name)) throw new Error(secret);
      put(name, 'directory');
    },
    writeFileSync(name, data, options) {
      writes.push(['write', name]);
      assert.equal(options.flag, 'wx');
      if (files.has(name)) throw new Error(secret);
      put(name, 'file', Buffer.from(data));
    },
  };
  const env = { GITHUB_REPOSITORY: 'egdev6/quorb', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
    PREVIEW_SOURCE_SHA: sha, PREVIEW_VERSION: '0.6.0', GITHUB_WORKSPACE: secret };
  const report = { sourceSha: sha, version: '0.6.0', arch: 'arm64', minimumSystemVersion: '15.0', dmg, dmgSha256: digest };
  const options = { root, env, io, execFileSync: (...args) => { calls.push(args); return `${sha}\r\n`; },
    verifyBundle: (args) => { calls.push(args); return report; } };
  const stage = (patch = {}) => stagePreview({ ...options, ...patch });
  const readback = (patch = {}) => readbackPreview({ ...options, ...patch });
  function copied() {
    stage();
    for (const [name, entry] of [...files]) {
      if (name === upload || path.dirname(name) === upload) files.set(path.join(download, path.relative(upload, name)), { ...entry });
    }
    writes.length = 0;
    calls.length = 0;
  }
  return { files, put, writes, calls, io, env, report, options, stage, readback, copied };
}
function rejected(f, invoke = () => f.stage(), beforeWrites = true) {
  assert.throws(invoke, (error) => {
    assert.equal(error.message, 'Preview artifact rejected');
    assert.equal(error.cause, undefined);
    return true;
  });
  if (beforeWrites) assert.deepEqual(f.writes, []);
}
test('stages three exclusive files with canonical basename/source manifest; simulated readback never writes', () => {
  const f = fixture();
  f.copied();
  const expected = buildPreviewManifest({ version: '0.6.0', sourceSha: sha, dmgName: 'Quorb.dmg', sha256: digest, size: bytes.length });
  assert.deepEqual(JSON.parse(f.io.readFileSync(path.join(upload, 'manifest.json'), 'utf8')), expected);
  assert.deepEqual(f.io.readdirSync(upload).sort(), ['Quorb.dmg', 'README.md', 'manifest.json']);
  assert.deepEqual(f.io.readFileSync(path.join(upload, 'README.md')), f.io.readFileSync(readme));
  assert.deepEqual(f.io.readFileSync(path.join(upload, 'Quorb.dmg')), bytes);
  assert.deepEqual(f.readback(), { sourceSha: sha, version: '0.6.0' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, [['git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
  }]]);
});
test('rejects environment, package and HEAD mismatches before writes', () => {
  for (const key of Object.keys(fixture().env).filter((key) => key !== 'GITHUB_WORKSPACE')) {
    for (const value of [undefined, secret, `${fixture().env[key]}\n`]) {
      const f = fixture();
      f.env[key] = value;
      rejected(f);
      assert.deepEqual(f.calls, []);
    }
  }
  for (const version of ['0.6.1', '0.06.0', '0.6.0-rc.1', '0.6.0+build', null]) {
    const f = fixture();
    f.put(path.join(root, 'package.json'), 'file', Buffer.from(JSON.stringify({ version })));
    rejected(f);
  }
  for (const output of ['b'.repeat(40), 'A'.repeat(40), `${sha}\nextra`, `${sha}\n\n`]) {
    const f = fixture();
    rejected(f, () => f.stage({ execFileSync: () => output }));
  }
});
test('checks verifier metadata, safe subtree and final DMG hash before writing', () => {
  for (const [key, value] of [['sourceSha', 'b'.repeat(40)], ['version', '0.6.1'], ['arch', 'x64'],
    ['minimumSystemVersion', '14.0'], ['dmgSha256', 'b'.repeat(64)], ['dmg', path.join(`${root}-sibling`, 'Quorb.dmg')],
    ['dmg', path.join(root, 'elsewhere.dmg')], ['dmg', path.join(path.dirname(dmg), 'a:b.dmg')],
    ['dmg', path.join(path.dirname(dmg), 'a\\b.dmg')]]) {
    const f = fixture();
    f.report[key] = value;
    rejected(f);
  }
  const f = fixture();
  f.put(dmg, 'file', Buffer.from('changed final bytes'));
  rejected(f);
});
test('rejects symlinks, missing entries and wrong kinds at every consumed level', () => {
  for (const name of fixture().files.keys()) {
    for (const type of ['symbolicLink', 'missing', name.endsWith('.dmg') || name.endsWith('.md') || name.endsWith('.json') ? 'directory' : 'file']) {
      const f = fixture();
      if (type === 'missing') f.files.delete(name);
      else f.put(name, type);
      rejected(f);
    }
  }
  for (const type of ['directory', 'file', 'symbolicLink']) {
    const f = fixture();
    f.put(upload, type);
    const before = [...f.files];
    rejected(f, () => f.stage(), false);
    assert.deepEqual([...f.files], before);
  }
});
test('readback rejects tampering, unsafe manifest names, extra entries and nonregular files on either side', () => {
  for (const directory of [upload, download]) {
    for (const [key, value] of [['delivery', 'signed'], ['sourceSha', 'b'.repeat(40)], ['version', '0.6.1'],
      ['dmg', { name: '../escape.dmg', sha256: digest, size: bytes.length }],
      ['dmg', { name: 'a:b.dmg', sha256: digest, size: bytes.length }],
      ['dmg', { name: 'a\\b.dmg', sha256: digest, size: bytes.length }],
      ['dmg', { name: 'Other.dmg', sha256: digest, size: bytes.length }],
      ['dmg', { name: 'Quorb.dmg', sha256: 'b'.repeat(64), size: bytes.length }],
      ['dmg', { name: 'Quorb.dmg', sha256: digest, size: bytes.length + 1 }],
      ['notarized', true], ['retentionDays', 90], ['arch', 'x64'], ['updater', 'automatic']]) {
      const f = fixture();
      f.copied();
      const name = path.join(directory, 'manifest.json');
      f.put(name, 'file', Buffer.from(JSON.stringify({ ...JSON.parse(f.io.readFileSync(name, 'utf8')), [key]: value })));
      rejected(f, () => f.readback());
    }
    for (const name of ['', 'manifest.json', 'README.md', 'Quorb.dmg', '.extra', 'unknown']) {
      for (const type of ['missing', 'symbolicLink', 'directory', 'file']) {
        if (!name && type === 'directory') continue;
        const f = fixture();
        f.copied();
        const target = path.join(directory, name);
        if (type === 'missing') { if (!f.files.delete(target)) continue; }
        else f.put(target, type, Buffer.from(secret));
        rejected(f, () => f.readback());
      }
    }
  }
  for (const key of ['sourceSha', 'version']) {
    const f = fixture();
    f.copied();
    for (const directory of [upload, download]) {
      const name = path.join(directory, 'manifest.json');
      const manifest = JSON.parse(f.io.readFileSync(name, 'utf8'));
      manifest[key] = key === 'sourceSha' ? 'b'.repeat(40) : '0.6.1';
      f.put(name, 'file', Buffer.from(JSON.stringify(manifest)));
    }
    rejected(f, () => f.readback());
  }
});
test('sanitizes filesystem, verifier and command errors without raw causes', () => {
  for (const key of ['execFileSync', 'verifyBundle']) {
    const f = fixture();
    rejected(f, () => f.stage({ [key]: () => { throw new Error(secret); } }));
  }
  for (const key of ['lstatSync', 'readFileSync', 'mkdirSync', 'writeFileSync', 'readdirSync']) {
    const f = fixture();
    f.io[key] = () => { throw new Error(secret); };
    if (key === 'readdirSync') f.copied();
    rejected(f, () => key === 'readdirSync' ? f.readback() : f.stage(), key !== 'writeFileSync');
  }
});
test('module-relative default ignores workspace; verifier commands capture stderr with a finite timeout', () => {
  const f = fixture();
  const seen = [];
  rejected(f, () => f.stage({ root: undefined, io: { lstatSync: (name) => { seen.push(name); throw new Error(secret); } } }));
  assert.deepEqual(seen, [path.resolve(fileURLToPath(new URL('../', import.meta.url)))]);
  assert.deepEqual(f.stage({ verifyBundle: ({ run }) => { run('/usr/bin/plutil', ['fixed']); return f.report; } }),
    { sourceSha: sha, version: '0.6.0' });
  assert.deepEqual(f.calls.at(-1), ['/usr/bin/plutil', ['fixed'], {
    cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  }]);
});
test('import is inert; CLI guards native paths/modes and emits sanitized JSON without touching real artifacts', () => {
  const target = new URL('./macos-preview-artifact.mjs', import.meta.url).href;
  const modules = ['macos-preview-artifact.mjs', 'macos-preview-policy.mjs', 'verify-macos-bundle.mjs']
    .map((name) => new URL(name, import.meta.url).href);
  const f = fixture();
  f.copied();
  const entries = [...f.files].map(([name, entry]) => [path.relative(root, name), entry.type, entry.data?.toString('base64')]);
  const setup = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    const unexpected = () => { process.stdout.write('${secret}'); throw new Error('${secret}'); };
    const allowed = ${JSON.stringify(modules)}.flatMap(url => [url, fileURLToPath(url)]);
    fs.readFileSync = (name, ...args) => allowed.includes(String(name)) ? read(name, ...args) : unexpected();
    fs.lstatSync = fs.readdirSync = fs.mkdirSync = fs.writeFileSync = cp.execFileSync = unexpected;
    process.env = {};
  `;
  const child = (code) => execFileSync(process.execPath, ['--input-type=module', '-e', setup + code],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(child(`syncBuiltinESMExports(); await import('${target}'); process.stdout.write('inert');`), 'inert');
  for (const args of [[], ['unknown'], ['stage', '--root=elsewhere'], ['stage'], ['readback']]) {
    assert.throws(() => child(`process.argv = [process.execPath, fileURLToPath('${target}'), ...${JSON.stringify(args)}];
      syncBuiltinESMExports(); await import('${target}');`), (error) => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr.replace(/\r\n/g, '\n'), 'Preview artifact rejected\n');
      return true;
    });
  }
  const runtime = `
    const root = fileURLToPath(new URL('../', '${target}'));
    const files = new Map(${JSON.stringify(entries)}.map(([name, type, data]) => [path.resolve(root, name), { type, data }]));
    const loaderRead = fs.readFileSync;
    fs.readFileSync = (name, ...args) => files.has(name) ? Buffer.from(files.get(name).data, 'base64') : loaderRead(name, ...args);
    fs.lstatSync = name => {
      const entry = files.get(name);
      if (!entry) throw new Error('${secret}');
      return { isFile: () => entry.type === 'file', isDirectory: () => entry.type === 'directory', isSymbolicLink: () => false };
    };
    fs.readdirSync = name => [...files.keys()].filter(key => path.dirname(key) === name).map(key => path.basename(key));
    cp.execFileSync = () => '${sha}\\n';
    process.env = ${JSON.stringify(f.env)};
    process.argv = [process.execPath, fileURLToPath('${target}'), 'readback'];
  `;
  const invoke = `syncBuiltinESMExports(); await import('${target}');`;
  const output = child(runtime + invoke);
  assert.equal(output.replace(/\r\n/g, '\n'), JSON.stringify({ sourceSha: sha, version: '0.6.0' }) + '\n');
  for (const fault of [
    `cp.execFileSync = () => { throw new Error('${secret}'); };`,
    `fs.lstatSync = () => { throw new Error('${secret}'); };`,
    `process.argv[2] = 'stage';`,
  ]) {
    assert.throws(() => child(runtime + fault + invoke), (error) => {
      assert.equal(error.status, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr.replace(/\r\n/g, '\n'), 'Preview artifact rejected\n');
      return true;
    });
  }
});
