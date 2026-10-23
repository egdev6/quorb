import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tc = path.join(here, '..', '.testcontainer');
const deb = path.join(tc, 'verify-deb.sh');
const appimage = path.join(tc, 'verify-appimage.sh');
const verify = path.join(tc, 'verify.sh');

// Los tres scripts son bash puro y fallan en el `find` antes de instalar o
// lanzar nada, así que el caso "falta un bundle" se puede ejercitar sin
// contenedor, sin root y sin dpkg/xvfb: basta con ARTIFACTS_DIR temporal.
function run(script, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'quorb-bundles-'));
  try {
    for (const name of files) writeFileSync(path.join(dir, name), '');
    const r = spawnSync('bash', [script], {
      // verify.sh invoca los sub-scripts por nombre (PATH); en el contenedor
      // resuelven por el working dir del ENTRYPOINT. Aquí los ponemos en PATH.
      env: { ...process.env, ARTIFACTS_DIR: dir, PATH: `${tc}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    return { code: r.status, stderr: r.stderr, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DEB = 'Quorb_0.7.0_amd64.deb';
const APPIMAGE = 'Quorb_0.7.0_amd64.AppImage';

test('verify-deb.sh falla si falta su propio bundle .deb', () => {
  const r = run(deb, []);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No hay ningún \.deb/);
});

test('verify-appimage.sh falla si falta su propio bundle .AppImage', () => {
  const r = run(appimage, []);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No hay ningún \.AppImage/);
});

test('el gate falla con el set vacío, sin bundles', () => {
  const r = run(verify, []);
  assert.equal(r.code, 1);
});

test('el gate falla si falta el .deb y solo llega el .AppImage', () => {
  const r = run(verify, [APPIMAGE]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No hay ningún \.deb/);
});