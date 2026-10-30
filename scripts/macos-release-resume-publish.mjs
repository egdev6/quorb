import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightRelease, validateReleaseInputs } from './macos-release-preflight.mjs';
import { repository, positiveId, hex, hash, MAX_DMG } from './macos-notary-checkpoint.mjs';
import { githubClient, validateArtifact, downloadZip, extractZip } from './macos-notary-artifact.mjs';

export async function loadFinalArtifact({ env = process.env, io = fs, fetch = globalThis.fetch } = {}) {
  validateReleaseInputs({ ref: env.GITHUB_REF, version: env.RELEASE_VERSION, sourceSha: env.RELEASE_SOURCE_SHA });
  if (env.GITHUB_REPOSITORY !== repository || !positiveId(env.GITHUB_REPOSITORY_ID) || !positiveId(env.GITHUB_RUN_ID) ||
      !positiveId(env.GITHUB_RUN_ATTEMPT) || !positiveId(env.FINAL_ARTIFACT_ID) || !hex(env.FINAL_ARTIFACT_DIGEST, 64) ||
      !hex(env.FINAL_SHA256, 64) || !hex(env.GITHUB_SHA, 40)) throw new Error('Invalid publication context');
  const api = githubClient({ token: env.GH_TOKEN, fetch });
  const run = await api.json(`/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`);
  if (run.id !== Number(env.GITHUB_RUN_ID) || run.run_attempt !== Number(env.GITHUB_RUN_ATTEMPT) || run.head_sha !== env.GITHUB_SHA ||
      run.head_branch !== 'main' || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/macos-release-resume.yml' ||
      run.repository?.id !== Number(env.GITHUB_REPOSITORY_ID) || run.head_repository?.id !== Number(env.GITHUB_REPOSITORY_ID) ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      !Number.isFinite(Date.parse(run.run_started_at))) throw new Error('Untrusted final artifact run');
  const name = `macos-notary-final-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const found = (await api.artifacts(env.GITHUB_RUN_ID)).filter((artifact) => artifact.name === name);
  if (found.length !== 1 || String(found[0].id) !== env.FINAL_ARTIFACT_ID || found[0].digest !== `sha256:${env.FINAL_ARTIFACT_DIGEST}`) {
    throw new Error('Final artifact ID/digest ambiguity');
  }
  const artifact = validateArtifact(found[0], run, name, { end: Date.now() });
  const dmgName = `Quorb_${env.RELEASE_VERSION}_aarch64.dmg`;
  const files = extractZip(await downloadZip(artifact, { token: env.GH_TOKEN, fetch }), { [dmgName]: MAX_DMG, [`${dmgName}.sha256`]: 1024 });
  if (hash(files.get(dmgName)) !== env.FINAL_SHA256 ||
      files.get(`${dmgName}.sha256`).toString('utf8') !== `${env.FINAL_SHA256}  ${dmgName}\n`) throw new Error('Final DMG/checksum mismatch');
  io.mkdirSync('notary-publish');
  for (const [name, bytes] of files) io.writeFileSync(path.join('notary-publish', name), bytes, { flag: 'wx' });
  return { dmgName, files };
}

const publicationError = (message) => Object.assign(new Error(message), { safePublish: true });

export async function publishFinal({ env = process.env, fetch = globalThis.fetch, load = loadFinalArtifact,
  preflight = preflightRelease } = {}) {
  if (!positiveId(env.RELEASE_ID)) throw new Error('Invalid release identity');
  const { dmgName, files } = await load({ env, fetch });
  // Revalidate the existing release ID, source/tag and both empty asset names
  // immediately before publication. POST never uses clobber or overwrite.
  const release = await preflight({ env, fetch });
  if (String(release.releaseId) !== env.RELEASE_ID) throw new Error('Release identity changed');
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const upload = async (name, type) => {
    const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${env.RELEASE_ID}/assets?name=${name}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { ...headers, 'Content-Type': type }, body: files.get(name),
    });
    if (response.status !== 201) throw new Error();
    const text = await response.text();
    if (text.length > 65536) throw new Error();
    const data = JSON.parse(text);
    if (!Number.isSafeInteger(data.id) || data.id <= 0) throw new Error();
    return data.id;
  };
  let ownedId;
  try { ownedId = await upload(dmgName, 'application/x-apple-diskimage'); }
  catch { throw publicationError('DMG upload failed or ambiguous; deleting nothing, inspect release assets'); }
  try { await upload(`${dmgName}.sha256`, 'text/plain'); }
  catch {
    // Only this invocation's positive asset ID can ever be rolled back.
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${ownedId}`, {
        method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 204) throw new Error();
    } catch { throw publicationError(`Checksum upload failed; rollback failed for owned DMG asset ${ownedId}; manual cleanup required`); }
    throw publicationError(`Checksum upload failed; removed only owned DMG asset ${ownedId}; inspect any ambiguous checksum`);
  }
  return { outcome: 'published', dmgName };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await publishFinal())); }
  catch (error) {
    console.error(error.safePublish ? error.message : 'Publication failed; inspect release assets before recovery');
    process.exitCode = 1;
  }
}
