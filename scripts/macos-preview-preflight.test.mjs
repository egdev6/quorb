import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { preflightPreview } from './macos-preview-preflight.mjs';

const sha = 'a'.repeat(40);
const secret = 'PRIVATE_FIXTURE_MARKER';
const root = path.resolve('fixture-root');
function fixture() {
  const env = { GITHUB_REPOSITORY: 'egdev6/quorb', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha, PREVIEW_SOURCE_SHA: sha, PREVIEW_VERSION: '0.6.0', GH_TOKEN: secret };
  const checks = { total_count: 4, check_runs: [
    'Tests and build (Windows)', 'Tests and bundle (macOS ARM64)', 'Static code safety', 'Secrets scan',
  ].map((name) => ({ name, status: 'completed', conclusion: 'success', head_sha: sha, app: { slug: 'github-actions' } })) };
  const calls = [];
  const options = { root, env,
    readFileSync: (...args) => { calls.push(['read', ...args]); return '{"version":"0.6.0"}'; },
    execFileSync: (...args) => { calls.push(['git', ...args]); return `${sha}\r\n`; },
    fetch: async (...args) => { calls.push(['fetch', ...args]); return new Response(JSON.stringify(checks)); },
  };
  return { env, checks, calls, options, run: (patch = {}) => preflightPreview({ ...options, ...patch }) };
}

test('acquires fixed local provenance and one bounded authenticated request; returns only validated fields', async () => {
  const f = fixture();
  f.env.GITHUB_API_URL = 'https://untrusted.invalid';
  assert.deepEqual(await f.run(), { sourceSha: sha, version: '0.6.0' });
  assert.deepEqual(f.calls[0], ['read', path.join(root, 'package.json'), 'utf8']);
  assert.deepEqual(f.calls[1], ['git', 'git', ['rev-parse', 'HEAD'],
    { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }]);
  const [kind, url, options] = f.calls[2];
  assert.equal(kind, 'fetch');
  assert.equal(url, `https://api.github.com/repos/egdev6/quorb/commits/${sha}/check-runs?per_page=100`);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${secret}`, 'X-GitHub-Api-Version': '2022-11-28' });
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.equal(f.calls.length, 3);
});

async function rejected(f, patch, message) {
  await assert.rejects(f.run(patch), (error) => {
    assert.equal(error.message, message);
    assert.ok(!String(error).includes(secret));
    return true;
  });
}

test('rejects invalid environment before any filesystem, Git or HTTP consumption', async () => {
  const cases = [['GITHUB_REPOSITORY', 'other/quorb'], ['GITHUB_REF', 'refs/heads/topic'],
    ['GITHUB_REF', 'refs/heads/main\n'], ['PREVIEW_SOURCE_SHA', 'b'.repeat(40)]];
  for (const key of ['GITHUB_SHA', 'PREVIEW_SOURCE_SHA']) {
    for (const value of [undefined, '', 'A'.repeat(40), `${sha}\n`, `${sha}/..`, sha.slice(1)]) cases.push([key, value]);
  }
  for (const value of [undefined, '', '0.06.0', '0.6.0-rc.1', '0.6.0+build', '../0.6.0', '0.6.0\n']) {
    cases.push(['PREVIEW_VERSION', value]);
  }
  for (const value of [undefined, '', ' ', 123, `${secret}\r`, `${secret}\n`]) cases.push(['GH_TOKEN', value]);
  for (const [key, value] of cases) {
    const f = fixture();
    f.env[key] = value;
    await rejected(f, {}, 'Invalid preview inputs');
    assert.deepEqual(f.calls, []);
  }
});

test('rejects package failures and HEAD mismatch or extra output before HTTP, sanitizing exceptions', async () => {
  for (const value of ['{', 'null', '{}', '{"version":"0.6.1"}', '{"version":"0.06.0"}']) {
    const f = fixture();
    await rejected(f, { readFileSync: () => value }, 'Invalid preview package version');
    assert.deepEqual(f.calls, []);
  }
  for (const key of ['readFileSync', 'execFileSync']) {
    const f = fixture();
    await rejected(f, { [key]: () => { throw new Error(`${secret}/private/path`); } },
      key === 'readFileSync' ? 'Invalid preview package version' : 'Unable to verify preview HEAD');
    assert.ok(!f.calls.some(([kind]) => kind === 'fetch'));
  }
  for (const value of ['b'.repeat(40), `${sha}\nextra`, `${sha}\n\n`, ` ${sha}\n`, `${sha}\r`, 'A'.repeat(40)]) {
    const f = fixture();
    await rejected(f, { execFileSync: () => value }, 'Unable to verify preview HEAD');
    assert.ok(!f.calls.some(([kind]) => kind === 'fetch'));
  }
  for (const suffix of ['', '\n', '\r\n']) {
    assert.deepEqual(await fixture().run({ execFileSync: () => sha + suffix }), { sourceSha: sha, version: '0.6.0' });
  }
});

test('uses module-relative root rather than an environment-supplied root', async () => {
  const f = fixture();
  f.env.GITHUB_WORKSPACE = '/untrusted/root';
  await f.run({ root: undefined });
  assert.equal(f.calls[0][1], fileURLToPath(new URL('../package.json', import.meta.url)));
});

test('rejects HTTP/rate-limit/redirect failures, missing bodies and invalid JSON without retry', async () => {
  for (const response of [new Response(secret, { status: 403 }), new Response(secret, { status: 429 }),
    new Response(secret, { status: 302 }), new Response(secret, { status: 500 }),
    new Response(null), new Response(`${secret}{`), new Response(''), {}]) {
    let calls = 0;
    await rejected(fixture(), { fetch: async () => { calls++; return response; } }, 'Unable to read preview checks');
    assert.equal(calls, 1);
  }
  for (const name of ['TypeError', 'TimeoutError', 'AbortError']) {
    await rejected(fixture(), { fetch: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      throw new DOMException(secret, name);
    } }, 'Unable to read preview checks');
  }
});

test('delegates complete REST check authority to the existing source policy', async () => {
  const mutations = [
    (c) => { c.total_count = 101; },
    (c) => { c.check_runs = null; },
    (c) => { c.check_runs.push(c.check_runs[0]); c.total_count++; },
    (c) => { c.check_runs.pop(); c.total_count--; },
    (c) => { c.check_runs[0].status = 'in_progress'; },
    (c) => { c.check_runs[0].conclusion = 'failure'; },
    (c) => { c.check_runs[0].app.slug = secret; },
    (c) => { c.check_runs[0].head_sha = 'b'.repeat(40); },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f.checks);
    await rejected(f, {}, 'Preview source checks rejected');
  }
  for (const data of ['null', '{}', '[]']) {
    await rejected(fixture(), { fetch: async () => new Response(data) }, 'Preview source checks rejected');
  }
});

test('counts streamed UTF-8 bytes, cancels oversize bodies despite lying Content-Length', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(Buffer.from('é'.repeat(200_000))); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await rejected(fixture(), { fetch: async () => new Response(body, { headers }) }, 'Unable to read preview checks');
    assert.equal(cancelled, true);
    assert.equal(pulls, 3);
  }
  // Exactly the limit is accepted; this is valid JSON padded with whitespace, not a character limit.
  const f = fixture();
  const json = JSON.stringify(f.checks);
  const bytes = Buffer.from(json.padEnd(1024 * 1024));
  assert.deepEqual(await f.run({ fetch: async () => new Response(bytes) }), { sourceSha: sha, version: '0.6.0' });
});

test('rejects read errors and simulated body timeouts without waiting on a real clock', async () => {
  for (const name of ['Error', 'TimeoutError', 'AbortError']) {
    const body = new ReadableStream({ pull(controller) { controller.error(new DOMException(secret, name)); } });
    await rejected(fixture(), { fetch: async () => new Response(body) }, 'Unable to read preview checks');
    assert.equal(body.locked, false);
  }
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue('not byte data'); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await rejected(fixture(), { fetch: async () => new Response(body) }, 'Unable to read preview checks');
  assert.equal(cancelled, true);
});

test('the request deadline also cancels body reading, using a controlled signal rather than real waits', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 10_000);
    return controller.signal;
  });
  let cancelled = false;
  const body = new ReadableStream({
    pull() { controller.abort(new DOMException(secret, 'TimeoutError')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await rejected(fixture(), { fetch: async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    return new Response(body);
  } }, 'Unable to read preview checks');
  assert.equal(cancelled, true);
});

test('import has no provenance I/O; guarded CLI emits only a sanitized error and exits nonzero', () => {
  const target = new URL('./macos-preview-preflight.mjs', import.meta.url).href;
  const setup = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const unexpected = () => { throw new Error('UNEXPECTED_IO'); };
    const read = fs.readFileSync;
    const modules = [${JSON.stringify(target)}, ${JSON.stringify(new URL('./macos-preview-policy.mjs', import.meta.url).href)}];
    fs.readFileSync = (name, ...args) => {
      if (modules.some((url) => String(name) === url || String(name) === fileURLToPath(url))) return read(name, ...args);
      return unexpected();
    };
    cp.execFileSync = globalThis.fetch = unexpected;
    syncBuiltinESMExports();
    process.env = {};
  `;
  const imported = execFileSync(process.execPath, ['--input-type=module', '-e', `${setup}
    await import(${JSON.stringify(target)});
    process.stdout.write('import-only');
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(imported, 'import-only');
  const f = fixture();
  const success = execFileSync(process.execPath, ['--input-type=module', '-e', `${setup}
    const loaderRead = fs.readFileSync;
    fs.readFileSync = (name, ...args) => String(name).endsWith('package.json')
      ? '{"version":"0.6.0"}' : loaderRead(name, ...args);
    cp.execFileSync = () => ${JSON.stringify(`${sha}\r\n`)};
    globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(f.checks))});
    syncBuiltinESMExports();
    process.env = ${JSON.stringify(f.env)};
    process.argv[1] = fileURLToPath(${JSON.stringify(target)});
    await import(${JSON.stringify(target)});
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(success.replace(/\r\n/g, '\n'), `${JSON.stringify({ sourceSha: sha, version: '0.6.0' })}\n`);
  assert.ok(!success.includes(secret));
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', `${setup}
    process.argv[1] = fileURLToPath(${JSON.stringify(target)});
    await import(${JSON.stringify(target)});
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), (error) => {
    assert.equal(error.status, 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr.replace(/\r\n/g, '\n'), 'Invalid preview inputs\n');
    return true;
  });
});
