// DRAFT — code-safety CLI contract tests. No Docker, no network and no target
// execution: every provision/scan dependency is an injected fake, and the CLI
// child is only ever driven with arguments that fail validation before any
// dependency is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from './code-safety.mjs';

const MODULE = fileURLToPath(new URL('./code-safety.mjs', import.meta.url));
const FAIL = 'code-safety-failed';
const COMMIT = 'a'.repeat(40);
const reject = (promise) => assert.rejects(promise, { message: FAIL });
const bump = () => { throw new Error('dependency must not run'); };
const deps = () => ({ provisionTools: bump, runSemgrep: bump, runZizmor: bump, readManifest: bump });

test('rejects unsupported or malformed invocations without calling dependencies', async () => {
  for (const argv of [undefined, null, 'provision', {}, [], ['bogus'], ['provision'],
    ['provision', '/a', '/b'], ['scan', '/a', COMMIT, '/b'], ['scan', '/a', COMMIT, '/b', '/c', '/d']]) {
    await reject(main(argv, deps()));
  }
});

test('rejects relative, control/format-character paths and bad commit hashes', async () => {
  const cases = [
    ['provision', 'relative/wheels'],
    ['provision', `/tmp/bad${'\u0000'}path`],
    ['provision', `/tmp/bad${'\u200b'}path`],
    ['provision', '/tmp/bad\npath'],
    ['provision', `/tmp/bad${'\u202e'}path`],
    ['scan', 'relative/repo', COMMIT, '/tmp/wheels', '/tmp/parent'],
    ['scan', '/tmp/repo', COMMIT, 'relative/wheels', '/tmp/parent'],
    ['scan', '/tmp/repo', COMMIT, '/tmp/wheels', 'relative/parent'],
    ['scan', '/tmp/repo', COMMIT, `/tmp/bad${'\u200b'}`, '/tmp/parent'],
  ];
  for (const argv of cases) await reject(main(argv, deps()));
  for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40),
    'f'.repeat(63), `f${'g'.repeat(63)}`, 'f'.repeat(65), '']) {
    await reject(main(['scan', '/tmp/repo', bad, '/tmp/wheels', '/tmp/parent'], deps()));
  }
});

test('scan calls each runner once with identical input and aborts zizmor on semgrep failure', async () => {
  const seen = [];
  const semgrep = { commit: COMMIT, findings: [] };
  const zizmor = { commit: COMMIT, findings: [] };
  const input = { repo: '/repo', commit: COMMIT, wheelhouse: '/wheels', parent: '/parent' };
  const out = await main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
    runSemgrep: (value) => { seen.push(['semgrep', value]); return semgrep; },
    runZizmor: (value) => { seen.push(['zizmor', value]); return zizmor; },
  });
  assert.deepEqual(out, { semgrep, zizmor });
  assert.deepEqual(seen, [['semgrep', input], ['zizmor', input]]);
  let zizmorCalls = 0;
  await reject(main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
    runSemgrep: () => { throw new Error('scanner secret'); },
    runZizmor: () => { zizmorCalls += 1; return zizmor; },
  }));
  assert.equal(zizmorCalls, 0);
  await reject(main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
    runSemgrep: () => semgrep,
    runZizmor: () => { throw new Error('scanner secret'); },
  }));
});

test('provision loads the module-relative trusted manifest and forwards it verbatim', async () => {
  const trusted = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../.github/security-drafts/tool-artifacts.json', import.meta.url)), 'utf8'));
  let seen;
  const out = await main(['provision', '/new/wheels'], {
    provisionTools: async (args) => { seen = args; return { directory: args.destination, artifacts: 7 }; },
  });
  assert.deepEqual(seen, { manifest: trusted, destination: '/new/wheels' });
  assert.deepEqual(out, { directory: '/new/wheels', artifacts: 7 });

  const injected = { schemaVersion: 1, artifacts: [] };
  let passed;
  await main(['provision', '/new/wheels'], {
    readManifest: () => injected,
    provisionTools: async (args) => { passed = args.manifest; return { directory: args.destination, artifacts: 0 }; },
  });
  assert.equal(passed, injected);
  await reject(main(['provision', '/new/wheels'], { readManifest: () => { throw new Error('boom'); } }));
  await reject(main(['provision', '/new/wheels'],
    { readManifest: () => injected, provisionTools: async () => { throw new Error('boom'); } }));
});

test('CLI child fails closed with a generic label, exit 2, empty stdout and no leaked input', () => {
  const secret = 'LEAK-ME-1234';
  const runs = [
    ['bogus'],
    ['provision', `relative/${secret}`],
    ['scan', '/repo', 'not-a-hash', '/wheels', '/parent'],
    ['scan', '/repo', COMMIT],
  ];
  for (const argv of runs) {
    const result = spawnSync(process.execPath, [MODULE, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 2, argv.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${FAIL}\n`);
    assert.ok(!result.stderr.includes(secret));
  }
});

test('workflow adoption pins the reviewed integrated baseline and keeps target execution separate', () => {
  const source = readFileSync(new URL('../../.github/security-drafts/code-safety.yml', import.meta.url), 'utf8');
  const active = readFileSync(new URL('../../.github/workflows/code-safety.yml', import.meta.url), 'utf8');
  assert.equal(active.replace(/\r\n/g, '\n'), source.replace(/\r\n/g, '\n'), 'active workflow must match the reviewed source');
  for (const eol of ['\n', '\r\n']) {
    const workflow = source.replace(/\r?\n/g, eol);
    assert.match(workflow, /^  TRUSTED_BASELINE: 587fc3a1806b58217881d4c94d8aa2df75ab57e1$/m);
    assert.match(workflow, /ref: \$\{\{ env\.TRUSTED_BASELINE \}\}/);
    assert.match(workflow, /ref: \$\{\{ env\.TARGET_COMMIT \}\}/);
    assert.match(workflow, /node trusted\/scripts\/security\/code-safety\.mjs scan/);
    assert.match(workflow, /permissions:\r?\n  contents: read/);
    assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write/);
  }
});

test('importing the module performs no work and no CLI call', () => {
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(MODULE).href)});`],
    { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
