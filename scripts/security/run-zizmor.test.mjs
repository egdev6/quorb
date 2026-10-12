import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as runners from './run-semgrep.mjs';

test('zizmor profile binds YAML inventory and trusted entry/lock to offline runner', t => {
  assert.equal(typeof runners.runZizmor, 'function');
  const base = mkdtempSync(join(tmpdir(), 'zizmor-profile-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'snapshot'), parent = join(base, 'out'), wheelhouse = join(base, 'wheels');
  for (const path of [root, parent, wheelhouse]) mkdirSync(path);
  const bytes = 'name: Inert\n';
  writeFileSync(join(root, '000000.yml'), bytes);
  const commit = 'a'.repeat(40);
  const inventory = { commit, root, targets: [{ path: join(root, '000000.yml'), originalPath: '.github/workflows/ci.yml',
    sha256: createHash('sha256').update(bytes).digest('hex') }], excluded: [] };
  const calls = [];
  const out = runners.runZizmor({ repo: '/repo', commit, parent, wheelhouse }, {
    platform: 'linux', uid: 1000, gid: 1000,
    exportSnapshot: options => { assert.equal(options.scope, 'workflows'); return inventory; },
    execute: (command, args) => {
      assert.equal(command, 'docker'); assert.deepEqual(args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
      calls.push(args[2]);
      if (args[2] === 'create') {
        for (const flag of ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', 'no-new-privileges']) assert.ok(args.includes(flag));
        const mount = args.find(a => a.includes('dst=/control'));
        const control = mount.split('src=')[1].split(',dst=')[0];
        assert.ok(readFileSync(join(control, 'requirements.lock'), 'utf8').includes('zizmor==1.30.1'));
        assert.ok(readFileSync(join(control, 'runner.py'), 'utf8').includes('zizmor'));
      }
      return { status: 0, stderr: '', stdout: args[2] === 'start'
        ? JSON.stringify({ version: '1.30.1', reports: [{ path: '/inputs/000000.yml', findings: [] }] }) : '' };
    },
  });
  assert.equal(out.scannedFiles, 1); assert.deepEqual(out.findings, []);
  assert.deepEqual(calls, ['create', 'start', 'rm']); assert.deepEqual(readdirSync(parent), []);
});
