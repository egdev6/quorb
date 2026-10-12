// DRAFT — bounded, parent-trusted wheel provisioning. The manifest is generated and
// verified elsewhere; this module only streams those exact wheels into a new directory.
// It never executes artifacts, never uses pip or archive extractors, and never overwrites
// or deletes a pre-existing destination. Failures throw a single generic error.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const FAIL = 'tool-provision-failed';
const MAX_ARTIFACTS = 100;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const WHEEL = /^[A-Za-z0-9_.+-]+\.whl$/;
const LABEL = /^[A-Za-z0-9_.+-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMMUTABLE = /^\/packages\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\/[^/]+$/;
const fail = () => { throw new Error(FAIL); };

function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail();
  if (Object.keys(manifest).sort().join(',') !== 'artifacts,schemaVersion' || manifest.schemaVersion !== 1) fail();
  const { artifacts } = manifest;
  if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > MAX_ARTIFACTS) fail();
  const filenames = new Set();
  const urls = new Set();
  let total = 0;
  for (const artifact of artifacts) {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) fail();
    if (Object.keys(artifact).sort().join(',') !== 'filename,name,sha256,size,url,version') fail();
    const { name, version, filename, url, sha256, size } = artifact;
    if (typeof name !== 'string' || !LABEL.test(name)) fail();
    if (typeof version !== 'string' || !LABEL.test(version)) fail();
    if (typeof filename !== 'string' || !WHEEL.test(filename)) fail();
    if (typeof url !== 'string' || !SHA256.test(sha256)) fail();
    if (!Number.isInteger(size) || size <= 0 || size > MAX_ARTIFACT_BYTES) fail();
    let parsed;
    try { parsed = new URL(url); } catch { fail(); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'files.pythonhosted.org') fail();
    if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') fail();
    if (parsed.search !== '' || parsed.hash !== '') fail();
    if (!IMMUTABLE.test(parsed.pathname) || parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1) !== filename) fail();
    if (filenames.has(filename) || urls.has(url)) fail();
    filenames.add(filename);
    urls.add(url);
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) fail();
  return artifacts;
}

// Resolve the destination parent only when the destination is absolute and absent,
// including dangling symlinks (lstat does not follow the final component).
function destinationParent(destination) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) fail();
  let exists = true;
  try { lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') fail(); exists = false; }
  if (exists) fail();
  const parent = dirname(destination);
  const info = statSync(parent, { throwIfNoEntry: false });
  if (!info || !info.isDirectory()) fail();
  return parent;
}

async function install(artifact, stage, fetchImpl) {
  const { filename, url, sha256, size } = artifact;
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  } catch { fail(); }
  if (!response || response.ok !== true || !response.body) fail();
  const digest = createHash('sha256');
  let received = 0;
  const fd = openSync(join(stage, filename), 'wx', 0o400);
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > size) fail();
      digest.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) fail();
        offset += written;
      }
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (received !== size || digest.digest('hex') !== sha256) fail();
}

export async function provisionTools({ manifest, destination }, deps = { fetch: globalThis.fetch }) {
  const fetchImpl = (deps && typeof deps.fetch === 'function') ? deps.fetch : globalThis.fetch;
  let stage;
  let created = false;
  try {
    const artifacts = validateManifest(manifest);
    stage = mkdtempSync(join(destinationParent(destination), '.provision-'));
    for (const artifact of artifacts) await install(artifact, stage, fetchImpl);
    mkdirSync(destination); // atomic guard: fails if the destination appeared meanwhile
    created = true;
    for (const artifact of artifacts) renameSync(join(stage, artifact.filename), join(destination, artifact.filename));
    return { directory: destination, artifacts: artifacts.length };
  } catch {
    if (created) { try { rmSync(destination, { recursive: true, force: true }); } catch { /* own dir only */ } }
    fail();
  } finally {
    if (stage) { try { rmSync(stage, { recursive: true, force: true }); } catch { /* private stage */ } }
  }
}
