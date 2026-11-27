// Evidence for the Nexo hub integration (#281): the transcript parser is pure,
// so the cases can be checked without Windows, Docker or the hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, framesOf, parseTranscript, summarize } from './transcript.mjs';

const REGISTER = {
  v: 1,
  type: 'register',
  app: { id: 'quorb', name: 'Quorb', version: '0.9.1' },
  capabilities: ['show', 'quit', 'menu'],
};
const MENU = {
  v: 1,
  type: 'menu',
  items: [
    { id: 'toggle', label: 'Mostrar / ocultar widget', enabled: true },
    { id: 'refresh', label: 'Actualizar ahora', enabled: true },
    { id: 'settings', label: 'Ajustes…', enabled: true },
  ],
};

const transcript = (extra = '') => `
Listening on \\\\.\pipe\nexo-hub-S-1-5-21 (current user only)
Unified at welcome: true
App connected
<- ${JSON.stringify({ v: 1, type: 'hello', protocol: { min: 1, max: 1 } })}
-> ${JSON.stringify({ v: 1, type: 'welcome', protocol: 1, unified: true, heartbeat_interval_ms: 5000 })}
<- ${JSON.stringify(REGISTER)}
Registered app: quorb / Quorb / 0.9.1
-> ${JSON.stringify({ v: 1, type: 'registered' })}
<- ${JSON.stringify(MENU)}
Menu replacement: [...]
Unified: false
-> ${JSON.stringify({ v: 1, type: 'unified', value: false })}
Unified: true
-> ${JSON.stringify({ v: 1, type: 'unified', value: true })}
Dropping connection; waiting for reconnect
Waiting for an app
App connected
<- ${JSON.stringify({ v: 1, type: 'hello', protocol: { min: 1, max: 1 } })}
<- ${JSON.stringify(REGISTER)}
Registered app: quorb / Quorb / 0.9.1
<- ${JSON.stringify({ v: 1, type: 'quit_result', id: 1, accepted: true })}
<- ${JSON.stringify({ v: 1, type: 'bye' })}
App disconnected
${extra}`;

test('parseTranscript reads frames in both directions and the session events', () => {
  const parsed = parseTranscript(transcript());
  assert.equal(parsed.frames.length, 11);
  assert.equal(framesOf(parsed, 'hello').length, 2);
  assert.equal(framesOf(parsed, 'bye').length, 1);
  assert.equal(parsed.frames[0].direction, 'app-to-hub');
  assert.equal(parsed.frames[1].direction, 'hub-to-app');
  assert.equal(parsed.registrations.length, 2);
  assert.equal(parsed.registrations[0].id, 'quorb');
  assert.equal(parsed.menus.length, 1);
  assert.equal(parsed.sessions, 2);
  assert.equal(parsed.drops, 1);
  assert.deepEqual(parsed.unified, [false, true]);
});

test('evaluate passes every case on a complete session', () => {
  const cases = evaluate(parseTranscript(transcript()));
  assert.equal(cases.length, 5);
  for (const entry of cases) assert.equal(entry.ok, true, `${entry.id}: ${entry.detail}`);
  assert.match(summarize(cases), /PASS · registro/);
});

test('evaluate fails the quit case when the hub refuses the exit', () => {
  const refused = transcript().replace(
    '<- {"v":1,"type":"quit_result","id":1,"accepted":true}',
    '<- {"v":1,"type":"quit_result","id":1,"accepted":false,"reason":"Hay cambios sin guardar en Ajustes."}',
  );
  const cases = evaluate(parseTranscript(refused));
  const quit = cases.find((entry) => entry.id === 'quit');
  assert.equal(quit.ok, false);
  assert.match(quit.detail, /accepted=false/);
  assert.match(quit.detail, /Hay cambios sin guardar/);
});

test('evaluate fails the recovery case when the app does not come back', () => {
  const withoutReconnect = transcript().replace(/Dropping connection[^\n]*\n/, '');
  const cases = evaluate(parseTranscript(withoutReconnect));
  assert.equal(cases.find((entry) => entry.id === 'caida').ok, false);
});

test('evaluate fails the menu case when an id is missing', () => {
  const partial = transcript().replace('"id":"settings","label":"Ajustes…","enabled":true', '"id":"otro","label":"Otro","enabled":true');
  const cases = evaluate(parseTranscript(partial));
  assert.equal(cases.find((entry) => entry.id === 'menu').ok, false);
});

test('an empty transcript fails every case instead of passing silently', () => {
  const cases = evaluate(parseTranscript(''));
  assert.equal(cases.length, 5);
  for (const entry of cases) assert.equal(entry.ok, false, entry.id);
});
