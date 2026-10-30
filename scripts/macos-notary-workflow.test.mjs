import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const draft = '.github/security-drafts/macos-notary-diagnostics.yml';
const active = '.github/workflows/macos-notary-diagnostics.yml';
const id = '12345678-1234-1234-1234-123456789abc';
// Pin all reviewed steps and secret references, not only the selected assertions.
const reviewedHash = '04cc19197a20b4fb11a65ef44fc9b8a140268e535f6d29a7c30e95f9281a6cb0';
const normalize = (text) => text.replaceAll('\r\n', '\n');
const digest = (text) => createHash('sha256').update(normalize(text)).digest('hex');

function script(text = read(active)) {
  const body = normalize(text).split("          python3 <<'PY'\n")[1]?.split('\n          PY')[0];
  assert.ok(body, 'Expected inline Python diagnostics');
  return body.split('\n').map((line) => line.slice(10)).join('\n');
}

function execute(submission = '', status = 'In Progress', fail = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'quorb-notary-test-'));
  const calls = path.join(dir, 'calls.jsonl');
  const key = path.join(dir, 'quorb-notary-diagnostics-42-1.p8');
  const fake = `import json, os, subprocess
from types import SimpleNamespace
def fake_run(args, **kwargs):
    assert args[0:2] == ['xcrun', 'notarytool']
    if args[2] == 'log':
        assert '--output-format' not in args, 'notarytool log does not support --output-format'
    else:
        assert args[-2:] == ['--output-format', 'json']
    assert kwargs['timeout'] == 120
    assert kwargs['capture_output'] and kwargs['text']
    with open(os.environ['CALLS'], 'a') as file:
        file.write(json.dumps(args[1:]) + '\\n')
    if args[2] == os.environ['FAIL']:
        return SimpleNamespace(returncode=1, stdout='', stderr='secret-value-must-not-leak')
    if args[2] == 'history':
        data = {'history': [{'id': '${id}', 'name': 'Quorb.zip', 'status': os.environ['STATUS'], 'createdDate': 'today'}]}
    else:
        data = {'id': '${id}', 'status': os.environ['STATUS'], 'issues': []}
    return SimpleNamespace(returncode=0, stdout=json.dumps(data), stderr='')
subprocess.run = fake_run
`;
  try {
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', fake + script()], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, RUNNER_TEMP: dir,
        GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', SUBMISSION_ID: submission,
        APPLE_API_KEY_P8: 'synthetic-private-key', APPLE_API_KEY: 'synthetic-key-id',
        APPLE_API_ISSUER: 'synthetic-issuer', CALLS: calls, STATUS: status, FAIL: fail },
    });
    assert.ifError(result.error);
    return { ...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [], keyExists: existsSync(key) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('manual diagnostics is read-only, protected, mirrored and wired into npm test', () => {
  const raw = read(active);
  assert.equal(raw, read(draft));
  const text = normalize(raw);
  assert.equal(digest(text), reviewedHash);
  assert.match(text, /on:\n  workflow_dispatch:/);
  assert.match(text, /permissions:\n  contents: read/);
  assert.match(text, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(text, /environment: macos-signing/);
  assert.match(text, /runs-on: macos-15/);
  assert.match(text, /timeout-minutes: 10/);
  assert.match(text, /if: always\(\)/);
  assert.match(text, /SUBMISSION_ID: \$\{\{ inputs.submission_id \}\}/);
  assert.doesNotMatch(text, /contents: write|uses:|pull_request|continue-on-error|APPLE_CERTIFICATE|GH_TOKEN|notarytool submit|npm |stapler|gh release/);
  assert.equal((text.match(/\$\{\{ secrets\./g) || []).length, 3);
  assert.ok(JSON.parse(read('package.json')).scripts.test.includes('scripts/macos-notary-workflow.test.mjs'));
});

test('inline Python extraction supports LF and CRLF workflows', () => {
  const lf = read(active).replaceAll('\r\n', '\n');
  const crlf = lf.replaceAll('\n', '\r\n');
  assert.equal(script(crlf), script(lf));
  assert.match(script(lf), /^import json, os, re, subprocess\n/);
});

test('reviewed digest rejects changes to every nonempty line', () => {
  const lines = normalize(read(draft)).split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    assert.notEqual(digest(lines.filter((_, i) => i !== index).join('\n')), reviewedHash);
  }
});

test('history only lists IDs without resubmitting or retaining the key', () => {
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((call) => call[1]), ['history']);
  assert.match(result.stdout, new RegExp(id));
  assert.equal(result.keyExists, false);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-key/);
});

test('pending ID queries info but does not request an unavailable log', () => {
  const result = execute(id);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map((call) => call[1]), ['history', 'info']);
  assert.match(result.stdout, /In Progress/);
  assert.equal(result.keyExists, false);
});

for (const status of ['Accepted', 'Invalid', 'Rejected']) {
  test(`terminal ${status} fetches log for the exact requested ID`, () => {
    const result = execute(id, status);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map((call) => call[1]), ['history', 'info', 'log']);
    for (const call of result.calls.slice(1)) assert.equal(call[2], id);
    for (const call of result.calls) {
      if (call[1] === 'log') assert.ok(!call.includes('--output-format'));
      else assert.deepEqual(call.slice(-2), ['--output-format', 'json']);
      assert.ok(call.includes('--key'));
    }
    assert.equal(result.keyExists, false);
  });
}

test('malformed or injected ID fails before contacting Apple', () => {
  for (const value of ['--help', `${id}; echo injected`, 'not-a-uuid']) {
    const result = execute(value);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.equal(result.keyExists, false);
  }
});

test('command failure is nonzero, cleans the key and does not print raw stderr', () => {
  for (const command of ['history', 'info', 'log']) {
    const result = execute(id, 'Invalid', command);
    assert.notEqual(result.status, 0);
    assert.equal(result.keyExists, false);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-value-must-not-leak|synthetic-private-key/);
  }
});
