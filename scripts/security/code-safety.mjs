// DRAFT — trusted code-safety CLI (library + single-shot entrypoint).
// It orchestrates only module-local trusted runners: the parent-trusted wheel
// provisioner and the offline semgrep/zizmor host runners. It never reads or
// executes target-repository code, never touches Docker/network itself, and never
// invokes the existing check-repository CLI (that stays a separate workflow step).
// The manifest is resolved relative to this module — never from argv, environment
// or the target checkout. Every failure collapses to one generic error so no
// scanner stdout/stderr, path, commit or dependency detail can leak; findings are
// advisory and a resolved run always exits 0.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provisionTools as defaultProvisionTools } from './provision-tools.mjs';
import { runSemgrep as defaultRunSemgrep, runZizmor as defaultRunZizmor } from './run-semgrep.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Trusted manifest identity: fixed path relative to this module, never injected
// from the target repository or the environment.
const MANIFEST_PATH = resolve(HERE, '../../.github/security-drafts/tool-artifacts.json');
const FAIL = 'code-safety-failed';
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UNSAFE = /[\p{Cc}\p{Cf}]/u;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

const fail = () => { throw new Error(FAIL); };
const defaultReadManifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

function safePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || UNSAFE.test(value)) fail();
  return value;
}

async function runProvision(argv, deps) {
  if (argv.length !== 2) fail();
  const destination = safePath(argv[1]);
  const provisionTools = deps.provisionTools ?? defaultProvisionTools;
  const readManifest = deps.readManifest ?? defaultReadManifest;
  let manifest;
  try { manifest = await readManifest(); } catch { return fail(); }
  let result;
  try { result = await provisionTools({ manifest, destination }); } catch { return fail(); }
  if (result === null || typeof result !== 'object') fail();
  return { directory: result.directory, artifacts: result.artifacts };
}

async function runScan(argv, deps) {
  if (argv.length !== 5) fail();
  const repo = safePath(argv[1]);
  const commit = argv[2];
  if (typeof commit !== 'string' || !COMMIT_SHA.test(commit)) fail();
  const wheelhouse = safePath(argv[3]);
  const parent = safePath(argv[4]);
  const runSemgrep = deps.runSemgrep ?? defaultRunSemgrep;
  const runZizmor = deps.runZizmor ?? defaultRunZizmor;
  const input = { repo, commit, wheelhouse, parent };
  // A semgrep failure aborts the remaining scanner: no partial, no green result.
  let semgrep;
  try { semgrep = await runSemgrep(input); } catch { return fail(); }
  let zizmor;
  try { zizmor = await runZizmor(input); } catch { return fail(); }
  return { semgrep, zizmor };
}

// Returns the report object so tests can assert on it; the CLI wrapper below owns
// stdout. Strict argv length and shape are validated per command.
export async function main(argv, deps = {}) {
  if (!Array.isArray(argv) || argv.length === 0) fail();
  if (argv[0] === 'provision') return runProvision(argv, deps);
  if (argv[0] === 'scan') return runScan(argv, deps);
  fail();
}

function serialize(report) {
  let json;
  try { json = JSON.stringify(report); } catch { fail(); }
  if (Buffer.byteLength(json) > MAX_REPORT_BYTES) fail();
  return `${json}\n`;
}

async function cli(argv) {
  try {
    process.stdout.write(serialize(await main(argv)));
    return 0;
  } catch {
    process.stderr.write(`${FAIL}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
