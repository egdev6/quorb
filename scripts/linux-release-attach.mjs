import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateReleaseInputs } from './macos-release-preflight.mjs';
import { linuxAssetNames, preflightRelease } from './linux-release-preflight.mjs';

const repository = 'egdev6/quorb';
const maxBundle = 512 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const positiveId = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) &&
  Number.isSafeInteger(Number(value));
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value === value.trim();
const publicationError = (message) => Object.assign(new Error(message), { safePublish: true });

// The producer hashes the verified bytes before same-run artifact upload. Refuse
// extra files, symlinks, changed bytes and invalid fingerprints before any POST.
export function loadBundles({ env = process.env, io = fs } = {}) {
  validateReleaseInputs({ ref: env.GITHUB_REF, version: env.RELEASE_VERSION, sourceSha: env.RELEASE_SOURCE_SHA });
  if (typeof env.BUNDLE_DIR !== 'string' || !path.isAbsolute(env.BUNDLE_DIR) ||
      !digest(env.DEB_SHA256) || !digest(env.APPIMAGE_SHA256)) throw new Error('Invalid bundle context');
  const [deb, debSum, appimage, appimageSum] = linuxAssetNames(env.RELEASE_VERSION);
  const entries = io.readdirSync(env.BUNDLE_DIR);
  if (entries.length !== 2 || !entries.includes(deb) || !entries.includes(appimage)) throw new Error('Unexpected bundle files');
  const read = (name, expected) => {
    const file = path.join(env.BUNDLE_DIR, name);
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) ||
        stat.size < 1 || stat.size > maxBundle) throw new Error('Invalid bundle file');
    const bytes = io.readFileSync(file);
    if (!Buffer.isBuffer(bytes) || bytes.length !== stat.size || hash(bytes) !== expected) throw new Error('Bundle digest mismatch');
    return bytes;
  };
  const debBytes = read(deb, env.DEB_SHA256);
  const appimageBytes = read(appimage, env.APPIMAGE_SHA256);
  const checksum = (name, bytes) => Buffer.from(`${hash(bytes)}  ${name}\n`);
  return new Map([[deb, debBytes], [debSum, checksum(deb, debBytes)],
    [appimage, appimageBytes], [appimageSum, checksum(appimage, appimageBytes)]]);
}

async function uploadId(response) {
  if (response?.status !== 201 || typeof response.body?.getReader !== 'function') throw new Error();
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error();
      size += value.byteLength;
      if (size > 65_536) throw new Error();
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!Number.isSafeInteger(data.id) || data.id <= 0) throw new Error();
    return data.id;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function attachRelease({ env = process.env, io = fs, fetch = globalThis.fetch,
  preflight = preflightRelease } = {}) {
  if (!positiveId(env.RELEASE_ID)) throw new Error('Invalid release identity');
  const files = loadBundles({ env, io });
  // Recheck release identity, tag and all four absent names immediately before
  // POST. GitHub rejects duplicate names; never use an overwrite/clobber API.
  const release = await preflight({ env, fetch });
  if (String(release.releaseId) !== env.RELEASE_ID) throw new Error('Release identity changed');
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28' };
  const uploaded = [];
  try {
    for (const [name, bytes] of files) {
      const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${env.RELEASE_ID}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { ...headers, 'Content-Type': name.endsWith('.sha256') ? 'text/plain' : 'application/octet-stream' },
        body: bytes,
      });
      const id = await uploadId(response);
      if (uploaded.includes(id)) throw new Error();
      uploaded.push(id);
    }
  } catch {
    const failed = [];
    // A failed/ambiguous POST has no reliable owned ID: never guess by name.
    // Continue rollback even if one deletion fails, and report each failed ID.
    for (const id of uploaded.reverse()) {
      try {
        const response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${id}`, {
          method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(30_000), headers,
        });
        if (response.status !== 204) throw new Error();
      } catch { failed.push(id); }
    }
    if (failed.length) throw publicationError(`Upload failed; rollback failed for owned asset IDs ${failed.join(', ')}; inspect release assets`);
    throw publicationError('Upload failed or ambiguous; removed confirmed uploads only; inspect release assets before retrying');
  }
  return { outcome: 'attached', names: [...files.keys()] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await attachRelease())); }
  catch (error) {
    console.error(error.safePublish ? error.message : 'Attachment failed; inspect release assets before recovery');
    process.exitCode = 1;
  }
}
