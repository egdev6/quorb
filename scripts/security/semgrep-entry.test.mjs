// Static wiring checks only; behavior lives in Python tests and offline integration runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('checks inventory parse before scan and hashes again before emitting JSON', () => {
  const source = readFileSync(new URL('./semgrep-entry.py', import.meta.url), 'utf8');
  const gate = source.indexOf('paths = check_parse(semgrep, entries)');
  const scan = source.indexOf('scan = run(');
  const verify = source.indexOf('verify_snapshot(entries)', scan);
  const emit = source.indexOf('sys.stdout.buffer.write(scan.stdout)');
  assert.ok(gate > 0 && gate < scan, 'per-target check must precede scan');
  assert.ok(verify > scan && verify < emit, 'integrity check must precede emission');
  assert.ok(source.includes('*paths]'), 'scan must use the checked paths');
});

test('entrypoint keeps findings advisory and installs the locked runtime offline', () => {
  const source = readFileSync(new URL('./semgrep-entry.py', import.meta.url), 'utf8');
  for (const flag of ['--oss-only', '--metrics', '--disable-version-check', '--disable-nosem', '--strict', '--no-git-ignore', '--json', '--config', '/control/rules.yml', '--isolated', '--no-index', '--find-links=/wheels', '--only-binary=:all:', '--require-hashes', '--no-deps', '/control/requirements.lock']) {
    assert.ok(source.includes(flag), flag);
  }
  assert.ok(!source.includes('--scan-unknown-extensions'), 'do not bypass language detection');
  assert.ok(!source.includes('--error'));
  assert.ok(!source.includes('--no-exclude-minified-files'));
});
