import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyMacosBundle, verifyDeveloperSignature } from './verify-macos-bundle.mjs';
import { validateReleaseInputs } from './macos-release-preflight.mjs';

export const repository = 'egdev6/quorb';
export const workflowPath = '.github/workflows/macos-release.yml';
export const MAX_DMG = 512 * 1024 * 1024;
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const positiveId = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
export const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const bindingKeys = ['repository', 'workflowPath', 'workflowSha', 'sourceSha', 'version', 'releaseId', 'runId', 'runAttempt'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function validateTrusted(trusted) {
  validateReleaseInputs({ ref: 'refs/heads/main', version: trusted.version, sourceSha: trusted.sourceSha });
  if (trusted.repository !== repository || trusted.workflowPath !== workflowPath || !hex(trusted.workflowSha, 40) ||
      !['releaseId', 'runId', 'runAttempt'].every((key) => positiveId(trusted[key]))) throw new Error('Invalid checkpoint context');
  return trusted;
}

export function trustedEnvironment(env = process.env) {
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error('Checkpoint requires main');
  return validateTrusted({ repository: env.GITHUB_REPOSITORY, workflowPath, workflowSha: env.GITHUB_SHA,
    sourceSha: env.RELEASE_SOURCE_SHA, version: env.RELEASE_VERSION, releaseId: env.RELEASE_ID,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT });
}

export function validateManifest(value, trusted) {
  validateTrusted(trusted);
  if (!exactKeys(value, ['schema', ...bindingKeys, 'dmgName', 'size', 'sha256']) || value.schema !== 1 ||
      bindingKeys.some((key) => value[key] !== trusted[key]) || value.dmgName !== `Quorb_${trusted.version}_aarch64.dmg` ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_DMG || !hex(value.sha256, 64)) {
    throw new Error('Invalid checkpoint manifest');
  }
  return value;
}

export function validateDmg(bytes, manifest) {
  if (bytes.length !== manifest.size || hash(bytes) !== manifest.sha256) throw new Error('Retained DMG hash/size mismatch');
}

export function validateReceipt(value, trusted, artifact, manifest) {
  if (!exactKeys(value, ['schema', ...bindingKeys, 'checkpointArtifactId', 'checkpointArtifactDigest', 'submissionId', 'dmgSha256']) ||
      value.schema !== 1 || bindingKeys.some((key) => value[key] !== trusted[key]) || !uuid(value.submissionId) ||
      value.checkpointArtifactId !== String(artifact.id) || value.checkpointArtifactDigest !== artifact.digest?.replace(/^sha256:/, '') ||
      !hex(value.checkpointArtifactDigest, 64) || value.dmgSha256 !== manifest.sha256) throw new Error('Invalid submission receipt');
  return value;
}

// Tauri bundler 2.10.1 sign.rs notarize_auth checks both flows. Absent, not empty:
// API key/issuer presence alone can trigger its private_keys directory search.
export function signingEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('APPLE_API_') &&
    !['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'].includes(key)));
}

export function buildSigned({ env = process.env, run = execFileSync } = {}) {
  if (!['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY'].every((key) => env[key]?.trim())) {
    throw new Error('Missing signing credentials');
  }
  try {
    run('npm', ['run', 'app:build:mac'], { cwd: 'source', env: signingEnvironment(env), stdio: 'inherit' });
  } catch { throw new Error('Signed build failed'); }
}

export function createCheckpoint({ env = process.env, io = fs, verify = verifyMacosBundle, signature = verifyDeveloperSignature } = {}) {
  const trusted = trustedEnvironment(env);
  const result = verify({ root: path.resolve('source'), sourceSha: trusted.sourceSha, io });
  if (result.version !== trusted.version || path.basename(result.dmg) !== `Quorb_${trusted.version}_aarch64.dmg`) throw new Error('Unexpected release bundle');
  signature(result.app);
  signature(result.dmg);
  const bytes = io.readFileSync(result.dmg);
  const manifest = validateManifest({ schema: 1, ...trusted, dmgName: path.basename(result.dmg), size: bytes.length, sha256: hash(bytes) }, trusted);
  io.mkdirSync('notary-checkpoint'); // exclusive, no stale files or directory merges
  io.writeFileSync(path.join('notary-checkpoint', manifest.dmgName), bytes, { flag: 'wx' });
  io.writeFileSync('notary-checkpoint/manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'build') buildSigned();
    else if (process.argv[2] === 'stage') createCheckpoint();
    else throw new Error('Expected build or stage');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
