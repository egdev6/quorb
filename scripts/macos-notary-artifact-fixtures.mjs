// Synthetic offline fixtures, NOT Apple/macOS runtime evidence.
import { execFileSync } from 'node:child_process';
import { hash } from './macos-notary-checkpoint.mjs';

export function zipFiles(files) {
  return execFileSync('python3', ['-c', `import io,json,zipfile,sys,base64
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_STORED) as z:
 for name,value in json.loads(sys.stdin.read()).items(): z.writestr(name,base64.b64decode(value))
sys.stdout.buffer.write(b.getvalue())`], {
    input: JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, Buffer.from(data).toString('base64')]))),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function fileFixture(entries = []) {
  // Canonical fixture keys only: do not resolve traversal or change manifest/ZIP names.
  const key = (name) => name.replaceAll('\\', '/');
  const files = new Map(entries.map(([name, bytes]) => [key(name), bytes]));
  const io = {
    readFileSync: (name) => files.get(key(name)),
    mkdirSync: (name) => { name = key(name); if (files.has(name)) throw new Error('exists'); files.set(name, null); },
    writeFileSync: (name, bytes, opts) => { name = key(name); if (files.has(name) || opts.flag !== 'wx') throw new Error('overwrite'); files.set(name, bytes); },
  };
  return { files, io };
}

export function producerFixture() {
  const workflowSha = 'a'.repeat(40);
  const sourceSha = 'b'.repeat(40);
  const submissionId = '12345678-1234-1234-1234-123456789abc';
  const trusted = { repository: 'egdev6/quorb', workflowPath: '.github/workflows/macos-release.yml', workflowSha, sourceSha, version: '0.8.0', releaseId: '42', runId: '123', runAttempt: '2' };
  const bytes = Buffer.from('synthetic signed DMG bytes');
  const manifest = { schema: 1, ...trusted, dmgName: 'Quorb_0.8.0_aarch64.dmg', size: bytes.length, sha256: hash(bytes) };
  const run = { id: 123, run_attempt: 2, repository: { id: 10, full_name: 'egdev6/quorb' }, head_repository: { id: 10, full_name: 'egdev6/quorb' },
    head_branch: 'main', event: 'workflow_dispatch', path: trusted.workflowPath, workflow_id: 99, head_sha: workflowSha, status: 'completed', conclusion: 'cancelled',
    run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z' };
  const archives = new Map();
  const artifact = (name, id, files) => {
    const zip = zipFiles(files); archives.set(id, zip);
    return { id, name, expired: false, digest: `sha256:${hash(zip)}`, size_in_bytes: zip.length,
      created_at: '2026-01-01T00:01:00Z', expires_at: '2099-01-01T00:00:00Z',
      workflow_run: { id: 123, repository_id: 10, head_repository_id: 10, head_branch: 'main', head_sha: workflowSha } };
  };
  const checkpoint = artifact('macos-notary-checkpoint-123-2', 456, { 'manifest.json': JSON.stringify(manifest), [manifest.dmgName]: bytes });
  const receipt = { schema: 1, ...trusted, checkpointArtifactId: '456', checkpointArtifactDigest: checkpoint.digest.slice(7), submissionId, dmgSha256: manifest.sha256 };
  const receiptArtifact = artifact('macos-notary-receipt-123-2', 457, { 'receipt.json': JSON.stringify(receipt) });
  const artifacts = [checkpoint, receiptArtifact];
  const { files, io } = fileFixture([[trusted.workflowPath, 'reviewed workflow bytes']]);
  const calls = [];
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: trusted.repository, GITHUB_SHA: 'd'.repeat(40),
    RELEASE_VERSION: trusted.version, RELEASE_SOURCE_SHA: sourceSha, RELEASE_ID: '42', SOURCE_RUN_ID: '123', SOURCE_RUN_ATTEMPT: '2', GH_TOKEN: 'synthetic' };
  const exec = (command, args) => {
    calls.push([command, args]);
    if (command !== 'git') throw new Error('Unexpected command');
    return args[0] === 'show' ? files.get(trusted.workflowPath) : '';
  };
  const fetch = async (url, options) => {
    calls.push([url, options]);
    const route = url.replace('https://api.github.com/repos/egdev6/quorb', '');
    if (route === '/actions/workflows/macos-release.yml') return Response.json({ id: 99, path: trusted.workflowPath });
    if (route === '/actions/runs/123/attempts/2' || route === '/actions/runs/123') return Response.json(run);
    if (route.startsWith('/actions/runs/123/artifacts?')) return Response.json({ artifacts });
    const id = route.match(/^\/actions\/artifacts\/([0-9]+)\/zip$/)?.[1];
    if (id && archives.has(Number(id))) return new Response(archives.get(Number(id)));
    throw new Error('Unexpected route SECRET');
  };
  return { env, io, exec, fetch, calls, files, run, artifacts, archives, manifest, receipt, checkpoint, receiptArtifact, bytes, submissionId };
}
