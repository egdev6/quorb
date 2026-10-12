// Node wrapper: run the trusted zizmor entrypoint behavior suite with the system
// Python. The Python tests inject every subprocess, clock and snapshot check, so
// no zizmor binary, network, Docker or target code is executed here. A timeout or
// non-zero exit is a hard failure; the scanner integration runs in the container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('zizmor entrypoint Python behavior suite (Python 3 required)', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const script = fileURLToPath(new URL('./zizmor-entry.test.py', import.meta.url));
  const result = spawnSync(python, ['-B', script], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
