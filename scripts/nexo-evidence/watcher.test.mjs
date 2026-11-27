// The driver waits on the `sim_hub` transcript; a wait that matches output from
// before its cursor races ahead of the app. That is exactly how the first
// version of #281's evidence driver sent its `q` during the reconnection gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher } from './watcher.mjs';

test('a line from before the cursor does not satisfy a later wait', async () => {
  const watcher = createWatcher({ timeout: 20 });
  watcher.push('Registered app: quorb / Quorb / 0.9.1\n');
  // El cursor es posterior al primer registro: la espera del re-registro no
  // puede darse por satisfecha con él.
  await assert.rejects(watcher.waitFor(/^Registered app: /, 'el re-registro', { from: watcher.mark() }), /Timeout esperando el re-registro/);
});

test('a line after the cursor satisfies the wait', async () => {
  const watcher = createWatcher();
  watcher.push('Registered app: quorb / Quorb / 0.9.1\n');
  const from = watcher.mark();
  watcher.push('Registered app: quorb / Quorb / 0.9.1\n');
  await watcher.waitFor(/^Registered app: /, 'el re-registro', { from });
});

test('a line split across chunks is assembled before matching', async () => {
  const watcher = createWatcher();
  const from = watcher.mark();
  watcher.push('Menu replace');
  assert.equal(watcher.lines.length, 0);
  assert.equal(watcher.pending(), 'Menu replace');
  const waiting = watcher.waitFor(/^Menu replacement: /, 'el menú', { from });
  watcher.push('ment: []\n');
  await waiting;
  assert.deepEqual(watcher.lines, ['Menu replacement: []']);
});

test('carriage returns are stripped so CRLF transcripts match too', () => {
  const watcher = createWatcher();
  watcher.push('Unified: false\r\nUnified: true\r\n');
  assert.deepEqual(watcher.lines, ['Unified: false', 'Unified: true']);
});

test('without an explicit cursor the wait only looks at new output', async () => {
  const watcher = createWatcher({ timeout: 20 });
  watcher.push('Unified: false\n');
  await assert.rejects(watcher.waitFor(/^Unified: false$/, 'la alternancia'), /Timeout esperando la alternancia/);
});

test('the timeout reports the label and the transcript seen so far', async () => {
  const watcher = createWatcher({ timeout: 10 });
  watcher.push('App connected\n');
  await assert.rejects(watcher.waitFor(/^bye$/, 'la despedida'), (error) => {
    assert.match(error.message, /la despedida/);
    assert.match(error.message, /App connected/);
    return true;
  });
});
