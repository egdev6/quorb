// DRAFT unit tests — bounded wheel provisioning from a parent-trusted manifest.
// Fake fetch streams inert bytes; no network, no execution, no archive extraction.
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionTools } from './provision-tools.mjs';

const FAIL = 'tool-provision-failed';
const manifest = (...artifacts) => ({ schemaVersion: 1, artifacts });
const rejects = (promise) => assert.rejects(promise, { message: FAIL });

function wheel(over = {}) {
  const bytes = over.bytes ?? Buffer.from('wheel-payload');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = over.filename ?? 'pkg-1.0.0-py3-none-any.whl';
  const h = over.pathHash ?? sha256;
  const entry = {
    name: over.name ?? 'pkg',
    version: over.version ?? '1.0.0',
    filename,
    url: over.url ?? `https://files.pythonhosted.org/packages/${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4)}/${filename}`,
    sha256: over.sha256 ?? sha256,
    size: over.size ?? bytes.length,
  };
  return { entry, bytes };
}

// responses[i] drives the i-th fetch call; the last spec is reused.
function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    const i = calls.length;
    calls.push({ url, options });
    const r = responses[i] ?? responses[responses.length - 1];
    if (r?.error) throw new Error('simulated network failure');
    if (r?.ok === false) return { ok: false, status: r.status ?? 500, body: null };
    if (r?.body === false) return { ok: true, status: 200, body: null };
    const list = Array.isArray(r?.chunks) ? r.chunks : [r?.chunks ?? Buffer.alloc(0)];
    return new Response(new ReadableStream({ start(c) { for (const chunk of list) c.enqueue(chunk); c.close(); } }));
  };
  return { fetch, calls };
}

function tempBase(t) {
  const base = mkdtempSync(join(tmpdir(), 'provision-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test('provisions multiple verified wheels into a new directory', async (t) => {
  const base = tempBase(t);
  const a = wheel({ bytes: Buffer.from('alpha') });
  const b = wheel({ name: 'dep', version: '2.0.0', filename: 'dep-2.0.0-py3-none-any.whl', bytes: Buffer.from('beta-payload') });
  const destination = join(base, 'out');
  const { fetch, calls } = fakeFetch([{ chunks: [a.bytes] }, { chunks: [b.bytes] }]);
  const result = await provisionTools({ manifest: manifest(a.entry, b.entry), destination }, { fetch });
  assert.deepEqual(result, { directory: destination, artifacts: 2 });
  assert.deepEqual(readFileSync(join(destination, a.entry.filename)), a.bytes);
  assert.deepEqual(readFileSync(join(destination, b.entry.filename)), b.bytes);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, a.entry.url);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('accepts the actual PyPI 2/2/60 hexadecimal URL layout', async (t) => {
  const base = tempBase(t);
  const a = wheel();
  const h = a.entry.sha256;
  a.entry.url = `https://files.pythonhosted.org/packages/${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4)}/${a.entry.filename}`;
  const result = await provisionTools({ manifest: manifest(a.entry), destination: join(base, 'out') },
    { fetch: fakeFetch([{ chunks: [a.bytes] }]).fetch });
  assert.equal(result.artifacts, 1);
});

test('never publishes bytes lost by a short filesystem write', async (t) => {
  const base = tempBase(t);
  const a = wheel();
  const original = fs.writeSync;
  fs.writeSync = (fd, bytes, offset = 0, length = bytes.length - offset) =>
    original(fd, bytes, offset, Math.min(length, 2));
  syncBuiltinESMExports();
  try {
    const destination = join(base, 'out');
    await provisionTools({ manifest: manifest(a.entry), destination },
      { fetch: fakeFetch([{ chunks: [a.bytes] }]).fetch });
    assert.deepEqual(readFileSync(join(destination, a.entry.filename)), a.bytes);
  } finally { fs.writeSync = original; syncBuiltinESMExports(); }
});

test('rejects malformed manifests before any fetch', async (t) => {
  const base = tempBase(t);
  const good = wheel();
  const tooMany = Array.from({ length: 101 }, () => good.entry);
  const big = (filename) => ({ ...wheel({ filename }).entry, size: 100 * 1024 * 1024 });
  const cases = [
    null,
    { schemaVersion: 1, artifacts: [] },
    { schemaVersion: 2, artifacts: [good.entry] },
    { schemaVersion: 1, artifacts: 'nope' },
    { schemaVersion: 1, artifacts: [good.entry], extra: 1 },
    manifest({ ...good.entry, extra: 1 }),
    manifest({ ...good.entry, name: '' }),
    manifest({ ...good.entry, size: 0 }),
    manifest({ ...good.entry, size: 100 * 1024 * 1024 + 1 }),
    manifest({ ...good.entry, size: 1.5 }),
    manifest({ ...good.entry, sha256: 'ABC' }),
    manifest({ ...good.entry, filename: '../evil.whl' }),
    manifest({ ...good.entry, filename: 'evil.whl/../../x.whl' }),
    { schemaVersion: 1, artifacts: tooMany },
    manifest(big('a-1.0.0-py3-none-any.whl'), big('b-1.0.0-py3-none-any.whl'), big('c-1.0.0-py3-none-any.whl')),
  ];
  for (const [i, m] of cases.entries()) {
    const { fetch, calls } = fakeFetch([]);
    await rejects(provisionTools({ manifest: m, destination: join(base, 'out' + i) }, { fetch }));
    assert.equal(calls.length, 0);
    assert.ok(!existsSync(join(base, 'out' + i)));
  }
});

test('rejects mutable, credentialed, ported, queried and fragment URLs', async (t) => {
  const base = tempBase(t);
  const a = wheel();
  const { filename, sha256: h } = a.entry;
  const p = `/packages/${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4)}`;
  const urls = [
    `http://files.pythonhosted.org${p}/${filename}`,
    `https://evil.example${p}/${filename}`,
    `https://user:pass@files.pythonhosted.org${p}/${filename}`,
    `https://files.pythonhosted.org:8443${p}/${filename}`,
    `https://files.pythonhosted.org${p}/${filename}?x=1`,
    `https://files.pythonhosted.org${p}/${filename}#x`,
    `https://files.pythonhosted.org${p}/other-1.0.0-py3-none-any.whl`,
    `https://files.pythonhosted.org/simple/${filename}`,
    `https://files.pythonhosted.org/packages/zz/zz/${h}/${filename}`,
    `https://files.pythonhosted.org/packages/${h.slice(0, 2)}/${h.slice(2, 4)}/${filename}`,
  ];
  for (const [i, url] of urls.entries()) {
    const { fetch, calls } = fakeFetch([]);
    await rejects(provisionTools({ manifest: manifest({ ...a.entry, url }), destination: join(base, 'out' + i) }, { fetch }));
    assert.equal(calls.length, 0);
  }
});

test('rejects duplicate filenames and duplicate URLs', async (t) => {
  const base = tempBase(t);
  const a = wheel();
  const b = wheel({ name: 'dep', version: '2.0.0', bytes: Buffer.from('other') });
  const dupName = manifest(a.entry, { ...b.entry, filename: a.entry.filename });
  const dupUrl = manifest(a.entry, { ...b.entry, url: a.entry.url });
  await rejects(provisionTools({ manifest: dupName, destination: join(base, 'n') }, { fetch: fakeFetch([]).fetch }));
  await rejects(provisionTools({ manifest: dupUrl, destination: join(base, 'u') }, { fetch: fakeFetch([]).fetch }));
  assert.deepEqual(readdirSync(base), []);
});

test('rejects hash and size mismatches and removes its staging directory', async (t) => {
  const base = tempBase(t);
  const a = wheel({ bytes: Buffer.from('abc') });
  const wrongHash = { ...a.entry, sha256: 'a'.repeat(64) };
  await rejects(provisionTools({ manifest: manifest(wrongHash), destination: join(base, 'h') }, { fetch: fakeFetch([{ chunks: [a.bytes] }]).fetch }));
  const wrongSize = { ...a.entry, size: a.bytes.length + 1 };
  await rejects(provisionTools({ manifest: manifest(wrongSize), destination: join(base, 's') }, { fetch: fakeFetch([{ chunks: [a.bytes] }]).fetch }));
  assert.deepEqual(readdirSync(base), []);
});

test('rejects a response larger than the declared size', async (t) => {
  const base = tempBase(t);
  const a = wheel({ bytes: Buffer.from('abc') });
  const destination = join(base, 'out');
  await rejects(provisionTools({ manifest: manifest(a.entry), destination }, { fetch: fakeFetch([{ chunks: [a.bytes, Buffer.from('overflow')] }]).fetch }));
  assert.ok(!existsSync(destination));
  assert.deepEqual(readdirSync(base), []);
});

test('rejects missing bodies, non-2xx responses and network failures', async (t) => {
  const base = tempBase(t);
  const a = wheel();
  const cases = [{ body: false }, { ok: false, status: 500 }, { error: true }];
  for (const [i, spec] of cases.entries()) {
    await rejects(provisionTools({ manifest: manifest(a.entry), destination: join(base, 'out' + i) }, { fetch: fakeFetch([spec]).fetch }));
  }
  assert.deepEqual(readdirSync(base), []);
});

test('never touches or clobbers an existing destination', async (t) => {
  const base = tempBase(t);
  const a = wheel();
  const file = join(base, 'file');
  writeFileSync(file, 'keep-me');
  const { fetch, calls } = fakeFetch([]);
  await rejects(provisionTools({ manifest: manifest(a.entry), destination: file }, { fetch }));
  assert.equal(readFileSync(file, 'utf8'), 'keep-me');
  assert.equal(calls.length, 0);

  const dir = join(base, 'dir');
  mkdirSync(dir);
  await rejects(provisionTools({ manifest: manifest(a.entry), destination: dir }, { fetch: fakeFetch([]).fetch }));
  assert.ok(existsSync(dir));

  const link = join(base, 'dangling');
  symlinkSync(join(base, 'missing'), link);
  await rejects(provisionTools({ manifest: manifest(a.entry), destination: link }, { fetch: fakeFetch([]).fetch }));
  assert.doesNotThrow(() => lstatSync(link));

  await rejects(provisionTools({ manifest: manifest(a.entry), destination: 'relative/out' }, { fetch: fakeFetch([]).fetch }));
});
