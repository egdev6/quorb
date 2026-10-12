// DRAFT Unit 2 slice tests — trusted offline Semgrep orchestration.
// Docker is never invoked: tests inject a fake `execute` transport and an injected
// exporter. Real trusted rules/lock/entrypoint are used so production validation
// (pinned lock hash, control hashing, mount policy) is never weakened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSemgrep } from './run-semgrep.mjs';

const IMAGE = 'docker.io/library/python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d';
const COMMIT = 'a'.repeat(40);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = (scanned = ['/inputs/000000.ts'], results = []) => ({ version: '1.180.0', errors: [], skipped_rules: [], paths: { scanned }, results });

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'run-semgrep-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'snapshot'); mkdirSync(root);
  const source = join(root, '000000.ts'); writeFileSync(source, 'void 0;');
  const wheelhouse = join(base, 'wheels'); mkdirSync(wheelhouse);
  const parent = join(base, 'out'); mkdirSync(parent);
  const inventory = {
    commit: COMMIT, root,
    targets: [{ path: source, originalPath: 'src/a.ts', sha256: sha('void 0;') }],
    excluded: [{ path: 'README.md', reason: 'outside-js-ts-scope' }],
  };
  return { base, root, source, wheelhouse, parent, inventory };
}

const input = (f) => ({ repo: '/repo', commit: COMMIT, wheelhouse: f.wheelhouse, parent: f.parent });
const deps = (f, execute, extra = {}) => ({ platform: 'linux', uid: 1000, gid: 1000, exportSnapshot: () => f.inventory, execute, ...extra });

function capture(handler) {
  const calls = [];
  return { calls, execute: (command, daemonArgs, options) => {
    const args = daemonArgs[0] === '--host' ? daemonArgs.slice(2) : daemonArgs;
    calls.push({ command, args, daemonArgs, options }); return handler(args);
  } };
}

const startedReport = (stdout) => {
  const calls = [];
  return {
    calls,
    execute: (command, daemonArgs, options) => {
      const args = daemonArgs[0] === '--host' ? daemonArgs.slice(2) : daemonArgs;
      calls.push({ command, args, daemonArgs, options });
      if (args[0] === 'create') return { status: 0, stdout: 'container-id\n', stderr: '' };
      if (args[0] === 'start') return { status: 0, stdout, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  };
};

test('hardened create argv with read-only mounts and normalized advisory findings', (t) => {
  const f = fixture(t);
  const stdout = JSON.stringify(report(['/inputs/000000.ts'], [{ check_id: 'inputs.decoded-text-execution', path: '/inputs/000000.ts', start: { line: 4 }, extra: { severity: 'WARNING' } }]));
  const { calls, execute } = startedReport(stdout);
  const out = runSemgrep(input(f), deps(f, execute));
  const create = calls.find((c) => c.args[0] === 'create').args;
  for (const control of ['--pull=never', '--platform', 'linux/amd64', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--log-driver=none', '--workdir', '/tmp', IMAGE]) {
    assert.ok(create.includes(control), control);
  }
  assert.ok(create.includes('--user') && create.includes('1000:1000'));
  assert.ok(create.includes('/tmp:rw,exec,nosuid,nodev,size=1073741824,mode=1777'));
  assert.deepEqual(create.slice(-2), ['python', '/control/runner.py']);
  const mounts = create.filter((_value, i) => create[i - 1] === '--mount');
  assert.equal(mounts.length, 3);
  assert.ok(mounts.every((m) => m.endsWith(',readonly')));
  for (const dst of ['/wheels', '/inputs', '/control']) assert.ok(mounts.some((m) => m.includes(`dst=${dst},readonly`)), dst);
  assert.ok(!create.includes('--rm'));
  assert.deepEqual(calls.map((c) => c.args[0]), ['create', 'start', 'rm']);
  assert.deepEqual(out, {
    commit: COMMIT, status: 'completed', scannedFiles: 1, excluded: f.inventory.excluded,
    findings: [{ rule: 'decoded-text-execution', path: 'src/a.ts', line: 4, severity: 'advisory' }],
  });
});

test('pins all daemon calls to the local socket', t => {
  const f = fixture(t);
  const { calls, execute } = startedReport(JSON.stringify(report()));
  runSemgrep(input(f), deps(f, execute));
  for (const call of calls) assert.deepEqual(call.daemonArgs.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
});

test('fails closed off Linux, for root uid and for unsafe mount paths before any daemon call', (t) => {
  const f = fixture(t);
  const { calls, execute } = startedReport(JSON.stringify(report()));
  assert.throws(() => runSemgrep(input(f), deps(f, execute, { platform: 'win32' })), /semgrep-run-failed:platform/);
  assert.throws(() => runSemgrep(input(f), deps(f, execute, { uid: 0 })), /semgrep-run-failed:uid/);
  assert.throws(() => runSemgrep(input(f), deps(f, execute, { gid: 0 })), /semgrep-run-failed:uid/);
  assert.throws(() => runSemgrep({ ...input(f), wheelhouse: join(f.base, 'a,b') }, deps(f, execute)), /semgrep-run-failed:mount-path/);
  assert.throws(() => runSemgrep({ ...input(f), wheelhouse: join(f.base, 'missing-wheels') }, deps(f, execute)), /semgrep-run-failed:wheelhouse/);
  assert.equal(calls.length, 0);
});

test('rejects untrusted lock bytes and missing trusted files', (t) => {
  const f = fixture(t);
  const { calls, execute } = startedReport(JSON.stringify(report()));
  const badLock = join(f.base, 'bad.lock'); writeFileSync(badLock, 'semgrep==1.180.0\n');
  assert.throws(() => runSemgrep(input(f), deps(f, execute, { lockPath: badLock })), /semgrep-run-failed:trusted-lock/);
  assert.throws(() => runSemgrep(input(f), deps(f, execute, { entrypointPath: join(f.base, 'missing.py') })), /semgrep-run-failed:trusted-files/);
  assert.equal(calls.length, 0);
});

test('docker create and scanner failures are operational with host cleanup', (t) => {
  const f1 = fixture(t);
  const { calls: createCalls, execute: createFail } = capture((a) => (a[0] === 'rm' ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'boom' }));
  assert.throws(() => runSemgrep(input(f1), deps(f1, createFail)), /semgrep-run-failed:docker-create/);
  assert.deepEqual(createCalls.map(c => c.args[0]), ['create', 'rm']);
  assert.equal(createCalls[0].args[2], createCalls[1].args[2]);
  assert.deepEqual(readdirSync(f1.parent), []);
  assert.ok(!existsSync(f1.root));
  const f2 = fixture(t);
  const { execute: scanFail } = capture((a) => (a[0] === 'create' ? { status: 0, stdout: '', stderr: '' } : a[0] === 'start' ? { status: 2, stdout: '', stderr: 'boom' } : { status: 0, stdout: '', stderr: '' }));
  assert.throws(() => runSemgrep(input(f2), deps(f2, scanFail)), /semgrep-run-failed:scanner/);
});

test('unparseable or incomplete reports are operational', (t) => {
  for (const stdout of ['not json', JSON.stringify(report(['/inputs/other.ts']))]) {
    const f = fixture(t);
    const { execute } = startedReport(stdout);
    assert.throws(() => runSemgrep(input(f), deps(f, execute)), /semgrep-run-failed:report/);
    assert.deepEqual(readdirSync(f.parent), []);
  }
});

test('removes container and host temp dirs on success and on start timeout', (t) => {
  for (const timedOut of [false, true]) {
    const f = fixture(t);
    const { calls, execute } = capture((args) => {
      if (args[0] === 'create') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'start') return timedOut ? { error: new Error('timeout'), status: null, stdout: '', stderr: '' } : { status: 0, stdout: JSON.stringify(report()), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const invoke = () => runSemgrep(input(f), deps(f, execute));
    if (timedOut) assert.throws(invoke, /semgrep-run-failed:scanner/); else invoke();
    assert.deepEqual(calls.map((c) => c.args[0]), ['create', 'start', 'rm']);
    assert.deepEqual(readdirSync(f.parent), []);
    assert.ok(!existsSync(f.root));
  }
});

test('uncertain create still attempts named cleanup and never returns success', t => {
  const f = fixture(t);
  const { calls, execute } = capture(args => args[0] === 'create'
    ? { error: new Error('timeout'), status: null }
    : { status: 1, stderr: 'No such container' });
  assert.throws(() => runSemgrep(input(f), deps(f, execute)), /semgrep-run-failed:docker-create/);
  assert.deepEqual(calls.map(c => c.args[0]), ['create', 'rm']);
  assert.equal(calls[0].args[2], calls[1].args[2]);
  assert.deepEqual(readdirSync(f.parent), []);
  assert.ok(!existsSync(f.root));
});

test('cleanup failure is operational, never green', (t) => {
  const f = fixture(t);
  const { execute } = capture((args) => (args[0] === 'create' ? { status: 0, stdout: '', stderr: '' }
    : args[0] === 'start' ? { status: 0, stdout: JSON.stringify(report()), stderr: '' }
      : { status: 1, stdout: '', stderr: 'permission denied' }));
  assert.throws(() => runSemgrep(input(f), deps(f, execute)), /semgrep-run-failed:cleanup/);
});

test('never echoes raw scanner output or secrets in errors', (t) => {
  const f = fixture(t);
  const secret = 'SECRET-TOKEN-VALUE';
  const { execute } = capture((args) => (args[0] === 'create' ? { status: 0, stdout: '', stderr: '' }
    : args[0] === 'start' ? { status: 1, stdout: `{"leak":"${secret}"`, stderr: `boom ${secret}` }
      : { status: 0, stdout: '', stderr: '' }));
  assert.throws(() => runSemgrep(input(f), deps(f, execute)), (error) => {
    assert.ok(!error.message.includes(secret));
    return /semgrep-run-failed:scanner/.test(error.message);
  });
});

test('detects snapshot and control mutation around the scanner', (t) => {
  for (const which of ['snapshot', 'rules.yml', 'requirements.lock', 'runner.py', 'targets.json', 'parse_gate.py']) {
    const f = fixture(t);
    let control;
    const { execute } = capture((args) => {
      if (args[0] === 'create') { control = args.find((a) => a.includes('dst=/control')).split('src=')[1].split(',dst=')[0]; return { status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'start') {
        const file = which === 'snapshot' ? f.source : join(control, which);
        chmodSync(file, 0o600); writeFileSync(file, 'tampered');
        return { status: 0, stdout: JSON.stringify(report()), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    assert.throws(() => runSemgrep(input(f), deps(f, execute)), /semgrep-run-failed:tamper/, which);
  }
});
