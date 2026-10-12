// Run behavior tests without importing/executing repository fixture sources or a scanner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Python parse gate behavior suite (Python 3 required)', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const script = fileURLToPath(new URL('./semgrep-parse-gate.test.py', import.meta.url));
  const result = spawnSync(python, ['-B', script], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
