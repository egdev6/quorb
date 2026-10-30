import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflightRelease, validateReleaseInputs } from './macos-release-preflight.mjs';
import { repository, workflowPath, positiveId, uuid, MAX_DMG, validateTrusted, validateManifest, validateDmg, validateReceipt } from './macos-notary-checkpoint.mjs';
import { githubClient, validateRun, selectArtifacts, downloadZip, extractZip } from './macos-notary-artifact.mjs';
import { withNotaryKey, querySubmission } from './macos-notary-submit.mjs';
import { stapleAndVerifyDmg } from './verify-macos-bundle.mjs';

function inputs(env) {
  validateReleaseInputs({ ref: env.GITHUB_REF, version: env.RELEASE_VERSION, sourceSha: env.RELEASE_SOURCE_SHA });
  if (env.GITHUB_REPOSITORY !== repository || !positiveId(env.SOURCE_RUN_ID) || !positiveId(env.SOURCE_RUN_ATTEMPT) ||
      !positiveId(env.RELEASE_ID) || (env.SUBMISSION_ID && !uuid(env.SUBMISSION_ID))) throw new Error('Invalid resume inputs');
}

export async function loadCheckpoint({ env = process.env, io = fs, exec = execFileSync, fetch = globalThis.fetch } = {}) {
  inputs(env);
  const api = githubClient({ token: env.GH_TOKEN, fetch });
  const workflow = await api.json('/actions/workflows/macos-release.yml');
  const run = validateRun(await api.json(`/actions/runs/${env.SOURCE_RUN_ID}/attempts/${env.SOURCE_RUN_ATTEMPT}`), workflow,
    { runId: env.SOURCE_RUN_ID, runAttempt: env.SOURCE_RUN_ATTEMPT });
  try {
    const git = (args) => exec('git', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    // An ancestor alone is insufficient: require the approved producer workflow
    // bytes as well, so old wait/build implementations cannot supply checkpoints.
    git(['merge-base', '--is-ancestor', run.head_sha, env.GITHUB_SHA]);
    git(['merge-base', '--is-ancestor', run.head_sha, 'origin/main']);
    if (git(['show', `${run.head_sha}:${workflowPath}`]) !== io.readFileSync(workflowPath, 'utf8')) throw new Error();
  } catch { throw new Error('Producer workflow SHA/content is not approved'); }
  const latest = await api.json(`/actions/runs/${env.SOURCE_RUN_ID}`);
  if (!Number.isSafeInteger(latest.run_attempt) || latest.run_attempt < run.run_attempt) throw new Error('Invalid producer attempt history');
  let end = Date.parse(run.updated_at);
  if (latest.run_attempt > run.run_attempt) {
    const next = await api.json(`/actions/runs/${env.SOURCE_RUN_ID}/attempts/${run.run_attempt + 1}`);
    if (next.id !== run.id || next.run_attempt !== run.run_attempt + 1 || !Number.isFinite(Date.parse(next.run_started_at))) throw new Error('Invalid producer attempt boundary');
    end = Math.min(end, Date.parse(next.run_started_at) - 1);
  }
  const artifacts = selectArtifacts(await api.artifacts(env.SOURCE_RUN_ID), run, Boolean(env.SUBMISSION_ID), { end });
  const trusted = validateTrusted({ repository, workflowPath, workflowSha: run.head_sha, version: env.RELEASE_VERSION,
    sourceSha: env.RELEASE_SOURCE_SHA, releaseId: env.RELEASE_ID, runId: env.SOURCE_RUN_ID, runAttempt: env.SOURCE_RUN_ATTEMPT });
  const dmgName = `Quorb_${trusted.version}_aarch64.dmg`;
  const files = extractZip(await downloadZip(artifacts.checkpoint, { token: env.GH_TOKEN, fetch }), { 'manifest.json': 65536, [dmgName]: MAX_DMG });
  let manifest;
  try { manifest = validateManifest(JSON.parse(files.get('manifest.json').toString('utf8')), trusted); }
  catch { throw new Error('Invalid checkpoint manifest'); }
  validateDmg(files.get(dmgName), manifest);
  let receipt;
  if (artifacts.receipt) {
    const receiptFiles = extractZip(await downloadZip(artifacts.receipt, { token: env.GH_TOKEN, fetch }), { 'receipt.json': 65536 });
    try { receipt = validateReceipt(JSON.parse(receiptFiles.get('receipt.json').toString('utf8')), trusted, artifacts.checkpoint, manifest); }
    catch { throw new Error('Invalid submission receipt'); }
  }
  const submissionId = env.SUBMISSION_ID || receipt?.submissionId;
  if (!uuid(submissionId)) throw new Error('Missing submission UUID; use diagnostics, never resubmit');
  // An explicit recovery ID can differ from a receipt, but cannot authorize
  // anything until the exact UUID + retained input hash are confirmed in Apple log.
  io.mkdirSync('notary-retained');
  for (const [name, bytes] of files) io.writeFileSync(path.join('notary-retained', name), bytes, { flag: 'wx' });
  return { manifest, dmg: path.resolve('notary-retained', dmgName), submissionId: submissionId.toLowerCase() };
}

export function preparedCheckpoint({ env = process.env, io = fs } = {}) {
  inputs(env);
  const trusted = validateTrusted({ repository, workflowPath, workflowSha: env.PRODUCER_WORKFLOW_SHA, version: env.RELEASE_VERSION,
    sourceSha: env.RELEASE_SOURCE_SHA, releaseId: env.RELEASE_ID, runId: env.SOURCE_RUN_ID, runAttempt: env.SOURCE_RUN_ATTEMPT });
  const manifest = validateManifest(JSON.parse(io.readFileSync('notary-retained/manifest.json', 'utf8')), trusted);
  const dmg = path.resolve('notary-retained', manifest.dmgName);
  for (const target of ['notary-retained', 'notary-retained/manifest.json', dmg]) {
    if (io.lstatSync(target).isSymbolicLink()) throw new Error('Retained checkpoint symlink');
  }
  validateDmg(io.readFileSync(dmg), manifest);
  if (!uuid(env.VALIDATED_SUBMISSION_ID)) throw new Error('Invalid validated submission UUID');
  return { manifest, dmg, submissionId: env.VALIDATED_SUBMISSION_ID };
}

function emit(result, env = process.env, io = fs) {
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Unsafe resume output');
    if (env.GITHUB_OUTPUT) io.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) io.appendFileSync(env.GITHUB_STEP_SUMMARY,
    result.outcome === 'accepted' ? '## Verified DMG ready for separately authorized publication\n' : '## Pending Apple processing — no publication, no resubmit\n');
}

export async function resumeNotarization({ load = preparedCheckpoint, preflight = preflightRelease, query = querySubmission,
  key = withNotaryKey, verify = stapleAndVerifyDmg, output = emit } = {}) {
  const checkpoint = await load();
  const release = await preflight();
  if (String(release.releaseId) !== checkpoint.manifest.releaseId) throw new Error('Release identity changed');
  const result = key((auth) => query(checkpoint.submissionId, checkpoint.manifest.sha256, auth));
  if (result.outcome === 'pending') { output({ outcome: 'pending' }); return result; }
  if (result.outcome === 'rejected') {
    console.log(JSON.stringify({ outcome: 'rejected', issues: result.issues ?? [] }));
    throw new Error('Rejected notarization; inspect safe issues before correcting source');
  }
  if (result.outcome !== 'accepted') throw new Error('Unexpected notarization outcome');
  const verified = verify({ dmg: checkpoint.dmg, version: checkpoint.manifest.version, inputSha256: checkpoint.manifest.sha256 });
  output({ outcome: 'accepted', finalSha256: verified.finalSha256 });
  return { ...verified, outcome: 'accepted' };
}

export function stageFinal({ env = process.env, io = fs } = {}) {
  // This runs only after complete succeeded; the job output carries the final hash
  // independently of the final artifact and is rechecked by the publish job.
  const name = `Quorb_${env.RELEASE_VERSION}_aarch64.dmg`;
  validateReleaseInputs({ ref: env.GITHUB_REF, version: env.RELEASE_VERSION, sourceSha: env.RELEASE_SOURCE_SHA });
  const bytes = io.readFileSync(path.join('notary-retained', name));
  validateDmg(bytes, { size: bytes.length, sha256: env.FINAL_SHA256 });
  io.mkdirSync('notary-final');
  io.writeFileSync(path.join('notary-final', name), bytes, { flag: 'wx' });
  io.writeFileSync(path.join('notary-final', `${name}.sha256`), `${env.FINAL_SHA256}  ${name}\n`, { flag: 'wx' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'validate') {
      const result = await loadCheckpoint();
      const release = await preflightRelease();
      if (String(release.releaseId) !== result.manifest.releaseId) throw new Error('Release identity changed');
      emit({ producerWorkflowSha: result.manifest.workflowSha, submissionId: result.submissionId });
    } else if (process.argv[2] === 'complete') await resumeNotarization();
    else if (process.argv[2] === 'stage-final') stageFinal();
    else throw new Error('Invalid resume mode');
  } catch (error) {
    // No server, subprocess or filesystem errors/paths are echoed by the CLI.
    console.error(error.safeNotary ? error.message : 'Resume validation/verification failed; no release published');
    process.exitCode = 1;
  }
}
