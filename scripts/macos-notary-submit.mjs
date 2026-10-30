import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trustedEnvironment, validateManifest, validateDmg, positiveId, hex, uuid } from './macos-notary-checkpoint.mjs';

const execute = (command, args) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

export function withNotaryKey(callback, { env = process.env, io = fs } = {}) {
  if (!positiveId(env.GITHUB_RUN_ID) || !positiveId(env.GITHUB_RUN_ATTEMPT) || !path.isAbsolute(env.RUNNER_TEMP ?? '') ||
      !['APPLE_API_KEY_P8', 'APPLE_API_KEY', 'APPLE_API_ISSUER'].every((key) => typeof env[key] === 'string' && env[key].trim())) {
    throw new Error('Missing notarization credentials/context');
  }
  const keyPath = path.join(env.RUNNER_TEMP, `quorb-notary-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.p8`);
  let written = false;
  try {
    io.writeFileSync(keyPath, env.APPLE_API_KEY_P8, { mode: 0o600, flag: 'wx' });
    written = true;
    return callback(['--key', keyPath, '--key-id', env.APPLE_API_KEY, '--issuer', env.APPLE_API_ISSUER]);
  } catch (error) {
    // Only our closed diagnostics survive. Never print execFileSync errors/args.
    if (error?.safeNotary === true) throw error;
    throw new Error('Notarization operation failed');
  } finally {
    if (written) {
      try { io.unlinkSync(keyPath); }
      catch { throw new Error('Notarization private key cleanup failed'); }
    }
  }
}

function safeError(message) {
  return Object.assign(new Error(message), { safeNotary: true });
}

export function submitDmg(dmg, auth, run = execute) {
  try {
    const response = JSON.parse(run('xcrun', ['notarytool', 'submit', dmg, ...auth, '--output-format', 'json']));
    if (!uuid(response.id)) throw new Error();
    return response.id.toLowerCase();
  } catch {
    throw safeError('Submission ambiguous: use diagnostics/history/info/log recovery; never retry submit');
  }
}

const safeText = (value) => typeof value === 'string' ? value.slice(0, 500).replace(/[^a-zA-Z0-9 ._/@()\-]/g, '?') : '';
export function querySubmission(id, sha256, auth, run = execute) {
  if (!uuid(id) || !hex(sha256, 64)) throw safeError('Invalid submission UUID/hash');
  id = id.toLowerCase();
  let info;
  try { info = JSON.parse(run('xcrun', ['notarytool', 'info', id, ...auth, '--output-format', 'json'])); }
  catch { throw safeError('Unable to query submission info'); }
  if (!uuid(info.id) || info.id.toLowerCase() !== id) throw safeError('Submission identity mismatch');
  if (info.status === 'In Progress') return { outcome: 'pending' };
  if (!['Accepted', 'Invalid', 'Rejected'].includes(info.status)) throw safeError('Unknown submission status');
  let log;
  try {
    // log is already JSON; --output-format is NOT supported by this subcommand.
    log = JSON.parse(run('xcrun', ['notarytool', 'log', id, ...auth]));
  } catch {
    if (info.status === 'Accepted') return { outcome: 'pending' }; // service has not made log available yet
    throw safeError('Unable to retrieve rejection log');
  }
  if (info.status !== 'Accepted') {
    return { outcome: 'rejected', issues: Array.isArray(log.issues) ? log.issues.slice(0, 50).map((issue) => ({
      severity: safeText(issue?.severity), path: safeText(issue?.path), message: safeText(issue?.message),
    })) : [] };
  }
  // Synthetic tests exercise sha256; availability in a real Apple log remains an
  // explicit runtime prerequisite. Absence must never silently weaken this gate.
  if (!uuid(log.jobId) || log.jobId.toLowerCase() !== id || typeof log.sha256 !== 'string' ||
      log.sha256.toLowerCase() !== sha256 || log.status !== 'Accepted') throw safeError('Apple log UUID/hash/status binding failed');
  return { outcome: 'accepted', submissionId: id };
}

export function submitCheckpoint({ env = process.env, io = fs, run = execute, key = withNotaryKey } = {}) {
  const trusted = trustedEnvironment(env);
  if (!positiveId(env.CHECKPOINT_ARTIFACT_ID) || !hex(env.CHECKPOINT_ARTIFACT_DIGEST, 64)) throw new Error('Checkpoint upload must succeed before submit');
  const manifest = validateManifest(JSON.parse(io.readFileSync('notary-checkpoint/manifest.json', 'utf8')), trusted);
  const dmg = path.join('notary-checkpoint', manifest.dmgName);
  validateDmg(io.readFileSync(dmg), manifest);
  // Directory exists before submit, so a later local setup failure cannot lose UUID.
  io.mkdirSync('notary-receipt');
  const submissionId = key((auth) => submitDmg(dmg, auth, run), { env, io });
  console.log(`Submission ID: ${submissionId}`);
  const receipt = { schema: 1, ...trusted, checkpointArtifactId: env.CHECKPOINT_ARTIFACT_ID,
    checkpointArtifactDigest: env.CHECKPOINT_ARTIFACT_DIGEST, submissionId, dmgSha256: manifest.sha256 };
  io.writeFileSync('notary-receipt/receipt.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  if (env.GITHUB_STEP_SUMMARY) io.appendFileSync(env.GITHUB_STEP_SUMMARY,
    `## Submitted; not a completed release\nSubmission: \`${submissionId}\`\nSource run: ${trusted.runId}, attempt: ${trusted.runAttempt}\nCheckpoint artifact: ${env.CHECKPOINT_ARTIFACT_ID}\nResume manually after Apple processing. Do not resubmit.\n`);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { submitCheckpoint(); }
  catch (error) {
    console.error(error.safeNotary ? error.message : 'Checkpoint submit failed; inspect receipt/diagnostics before any recovery; never auto-resubmit');
    process.exitCode = 1;
  }
}
