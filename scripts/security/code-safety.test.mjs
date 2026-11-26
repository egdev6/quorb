// DRAFT — code-safety CLI contract tests. No Docker, no network and no target
// execution: every provision/scan dependency is an injected fake, and the CLI
// child is only ever driven with arguments that fail validation before any
// dependency is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, cli } from './code-safety.mjs';
import { runSemgrep } from './run-semgrep.mjs';

const MODULE = fileURLToPath(new URL('./code-safety.mjs', import.meta.url));
const FAIL = 'code-safety-failed';
const COMMIT = 'a'.repeat(40);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = () => ({ version: '1.180.0', errors: [], skipped_rules: [], paths: { scanned: ['/inputs/000000.ts'] }, results: [] });
const reject = (promise) => assert.rejects(promise, { message: FAIL });
const bump = () => {
  throw new Error('dependency must not run');
};
const deps = () => ({ provisionTools: bump, runSemgrep: bump, runZizmor: bump, readManifest: bump });

test('rejects unsupported or malformed invocations without calling dependencies', async () => {
  for (const argv of [
    undefined,
    null,
    'provision',
    {},
    [],
    ['bogus'],
    ['provision'],
    ['provision', '/a', '/b'],
    ['scan', '/a', COMMIT, '/b'],
    ['scan', '/a', COMMIT, '/b', '/c', '/d'],
  ]) {
    await reject(main(argv, deps()));
  }
});

test('rejects relative, control/format-character paths and bad commit hashes', async () => {
  const cases = [
    ['provision', 'relative/wheels'],
    ['provision', `/tmp/bad${'\u0000'}path`],
    ['provision', `/tmp/bad${'\u200b'}path`],
    ['provision', '/tmp/bad\npath'],
    ['provision', `/tmp/bad${'\u202e'}path`],
    ['scan', 'relative/repo', COMMIT, '/tmp/wheels', '/tmp/parent'],
    ['scan', '/tmp/repo', COMMIT, 'relative/wheels', '/tmp/parent'],
    ['scan', '/tmp/repo', COMMIT, '/tmp/wheels', 'relative/parent'],
    ['scan', '/tmp/repo', COMMIT, `/tmp/bad${'\u200b'}`, '/tmp/parent'],
  ];
  for (const argv of cases) await reject(main(argv, deps()));
  for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), 'f'.repeat(63), `f${'g'.repeat(63)}`, 'f'.repeat(65), '']) {
    await reject(main(['scan', '/tmp/repo', bad, '/tmp/wheels', '/tmp/parent'], deps()));
  }
});

test('scan calls each runner once with identical input and aborts zizmor on semgrep failure', async () => {
  const seen = [];
  const semgrep = { commit: COMMIT, findings: [] };
  const zizmor = { commit: COMMIT, findings: [] };
  const input = { repo: '/repo', commit: COMMIT, wheelhouse: '/wheels', parent: '/parent' };
  const out = await main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
    runSemgrep: (value) => {
      seen.push(['semgrep', value]);
      return semgrep;
    },
    runZizmor: (value) => {
      seen.push(['zizmor', value]);
      return zizmor;
    },
  });
  assert.deepEqual(out, { semgrep, zizmor });
  assert.deepEqual(seen, [
    ['semgrep', input],
    ['zizmor', input],
  ]);
  let zizmorCalls = 0;
  await reject(
    main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
      runSemgrep: () => {
        throw new Error('scanner secret');
      },
      runZizmor: () => {
        zizmorCalls += 1;
        return zizmor;
      },
    }),
  );
  assert.equal(zizmorCalls, 0);
  await reject(
    main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
      runSemgrep: () => semgrep,
      runZizmor: () => {
        throw new Error('scanner secret');
      },
    }),
  );
});

test('provision loads the module-relative trusted manifest and forwards it verbatim', async () => {
  const trusted = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/security-drafts/tool-artifacts.json', import.meta.url)), 'utf8'));
  let seen;
  const out = await main(['provision', '/new/wheels'], {
    provisionTools: async (args) => {
      seen = args;
      return { directory: args.destination, artifacts: 7 };
    },
  });
  assert.deepEqual(seen, { manifest: trusted, destination: '/new/wheels' });
  assert.deepEqual(out, { directory: '/new/wheels', artifacts: 7 });

  const injected = { schemaVersion: 1, artifacts: [] };
  let passed;
  await main(['provision', '/new/wheels'], {
    readManifest: () => injected,
    provisionTools: async (args) => {
      passed = args.manifest;
      return { directory: args.destination, artifacts: 0 };
    },
  });
  assert.equal(passed, injected);
  await reject(
    main(['provision', '/new/wheels'], {
      readManifest: () => {
        throw new Error('boom');
      },
    }),
  );
  await reject(
    main(['provision', '/new/wheels'], {
      readManifest: () => injected,
      provisionTools: async () => {
        throw new Error('boom');
      },
    }),
  );
});

test('CLI reports a closed contract diagnostic without leaking invalid input', () => {
  const secret = 'LEAK-ME-1234';
  const runs = [
    { argv: ['bogus'], stage: 'bad-command' },
    { argv: ['provision', `relative/${secret}`], stage: 'input' },
    { argv: ['scan', '/repo', 'not-a-hash', '/wheels', '/parent'], stage: 'input' },
    { argv: ['scan', '/repo', COMMIT], stage: 'argv' },
  ];
  for (const { argv, stage } of runs) {
    const result = spawnSync(process.execPath, [MODULE, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 2, argv.join(' '));
    assert.equal(result.stdout, '');
    const [prefix, ...extra] = result.stderr.trimEnd().split('\n');
    assert.deepEqual(extra, []);
    const separator = prefix.indexOf(' ');
    assert.equal(prefix.slice(0, separator), FAIL);
    const diagnostic = JSON.parse(prefix.slice(separator + 1));
    assert.deepEqual(
      { ...diagnostic, durationMs: 0 },
      {
        label: FAIL,
        scanner: null,
        stage,
        class: 'contract',
        exit: null,
        durationMs: 0,
      },
    );
    assert.ok(Number.isInteger(diagnostic.durationMs) && diagnostic.durationMs >= 0);
    assert.ok(!result.stderr.includes(secret));
  }
});

test('CLI emits closed diagnostics and distinct exit codes for contract and infrastructure', async () => {
  for (const { runner, stage, expectedExit, expectedClass, scanner, internalExit } of [
    {
      runner: 'runSemgrep',
      stage: 'report-normalize',
      expectedExit: 2,
      expectedClass: 'contract',
      scanner: 'semgrep',
      internalExit: null,
    },
    {
      runner: 'runSemgrep',
      stage: 'report-parse',
      expectedExit: 3,
      expectedClass: 'infrastructure',
      scanner: 'semgrep',
      internalExit: null,
    },
    {
      runner: 'runSemgrep',
      stage: 'trusted-lock',
      expectedExit: 2,
      expectedClass: 'contract',
      scanner: 'semgrep',
      internalExit: null,
    },
    {
      // La integridad nunca es reintentable: `tamper` es exit 2 aunque la
      // limpieza también falle.
      runner: 'runSemgrep',
      stage: 'tamper',
      expectedExit: 2,
      expectedClass: 'contract',
      scanner: 'semgrep',
      internalExit: null,
    },
    {
      runner: 'runSemgrep',
      stage: 'docker-create',
      expectedExit: 3,
      expectedClass: 'infrastructure',
      scanner: 'semgrep',
      internalExit: 125,
    },
    {
      runner: 'runZizmor',
      stage: 'scanner',
      expectedExit: 3,
      expectedClass: 'infrastructure',
      scanner: 'zizmor',
      internalExit: 2,
    },
  ]) {
    let stdout = '';
    let stderr = '';
    const deps = {
      runSemgrep: async () => {
        if (runner === 'runSemgrep') {
          throw Object.assign(new Error(`${scanner}-run-failed:${stage}`), {
            scanner,
            internalExit,
            durationMs: 27,
          });
        }
        return { findings: [] };
      },
      runZizmor: async () => {
        if (runner === 'runZizmor') {
          throw Object.assign(new Error(`${scanner}-run-failed:${stage}`), {
            scanner,
            internalExit,
            durationMs: 27,
          });
        }
        return { findings: [] };
      },
    };
    const exit = await cli(['scan', '/repo', COMMIT, '/wheels', '/parent'], deps, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    assert.equal(exit, expectedExit);
    assert.equal(stdout, '');
    const [line, ...extra] = stderr.trimEnd().split('\n');
    assert.deepEqual(extra, []);
    const separator = line.indexOf(' ');
    assert.equal(line.slice(0, separator), FAIL);
    const parsed = JSON.parse(line.slice(separator + 1));
    assert.deepEqual(
      { ...parsed, durationMs: 27 },
      {
        label: FAIL,
        scanner,
        stage,
        class: expectedClass,
        exit: internalExit,
        durationMs: 27,
      },
    );
    assert.ok(Number.isInteger(parsed.durationMs) && parsed.durationMs >= 0);
  }
});

test('classifies contract and infrastructure runner failures by stage', async () => {
  const err = (message, meta) => Object.assign(new Error(message), meta);
  await assert.rejects(
    main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
      runSemgrep: () => {
        throw err('semgrep-run-failed:docker-create', { scanner: 'semgrep', internalExit: 125, durationMs: 12 });
      },
      runZizmor: () => ({ findings: [] }),
    }),
    (error) =>
      error.message === FAIL &&
      error.className === 'infrastructure' &&
      error.stage === 'docker-create' &&
      error.scanner === 'semgrep' &&
      error.exit === 125 &&
      error.durationMs === 12,
  );
  await assert.rejects(
    main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
      runSemgrep: () => {
        throw err('semgrep-run-failed:trusted-lock', { scanner: 'semgrep' });
      },
      runZizmor: () => ({ findings: [] }),
    }),
    (error) => error.message === FAIL && error.className === 'contract' && error.stage === 'trusted-lock',
  );
  await assert.rejects(
    main(['scan', '/repo', COMMIT, '/wheels', '/parent'], {
      runSemgrep: () => ({ findings: [] }),
      runZizmor: () => {
        throw err('zizmor-run-failed:scanner', { scanner: 'zizmor', internalExit: 2, durationMs: 7 });
      },
    }),
    (error) => error.message === FAIL && error.className === 'infrastructure' && error.stage === 'scanner' && error.scanner === 'zizmor',
  );
});

test('workflow adoption pins the reviewed integrated baseline and keeps target execution separate', () => {
  const source = readFileSync(new URL('../../.github/security-drafts/code-safety.yml', import.meta.url), 'utf8');
  const active = readFileSync(new URL('../../.github/workflows/code-safety.yml', import.meta.url), 'utf8');
  assert.equal(active.replace(/\r\n/g, '\n'), source.replace(/\r\n/g, '\n'), 'active workflow must match the reviewed source');
  for (const eol of ['\n', '\r\n']) {
    const workflow = source.replace(/\r?\n/g, eol);
    assert.match(workflow, /^  TRUSTED_BASELINE: 246dcf77653a69ef0a7735d735d861876faeaf54$/m);
    assert.match(workflow, /ref: \$\{\{ env\.TRUSTED_BASELINE \}\}/);
    assert.match(workflow, /ref: \$\{\{ env\.TARGET_COMMIT \}\}/);
    assert.match(workflow, /node trusted\/scripts\/security\/code-safety\.mjs scan/);
    assert.match(workflow, /\$GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /permissions:\r?\n  contents: read/);
    assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|actions\/upload-artifact/);
  }
});

test('importing the module performs no work and no CLI call', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(MODULE).href)});`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('a cleanup failure does not downgrade an integrity failure to infrastructure', async () => {
  // La combinación que faltaba: el scanner detecta una modificación del snapshot
  // (integridad) y además la limpieza del contenedor falla. El diagnóstico tiene
  // que seguir siendo `tamper` —contrato, exit 2, nunca reintentable— y no
  // `cleanup` —infraestructura, exit 3—. Se recorre el runner real con un
  // transporte simulado, como en la reproducción.
  const base = mkdtempSync(join(tmpdir(), 'code-safety-'));
  try {
    const root = join(base, 'snapshot');
    mkdirSync(root);
    const source = join(root, '000000.ts');
    writeFileSync(source, 'void 0;');
    const wheelhouse = join(base, 'wheels');
    mkdirSync(wheelhouse);
    const parent = join(base, 'out');
    mkdirSync(parent);
    const inventory = {
      commit: COMMIT,
      root,
      targets: [{ path: source, originalPath: 'src/a.ts', sha256: sha256('void 0;') }],
      excluded: [],
    };
    const execute = (_command, daemonArgs) => {
      const args = daemonArgs[0] === '--host' ? daemonArgs.slice(2) : daemonArgs;
      if (args[0] === 'create') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'start') {
        // El snapshot cambia mientras el scanner corre: es un fallo de integridad.
        chmodSync(source, 0o600);
        writeFileSync(source, 'tampered');
        return { status: 0, stdout: JSON.stringify(report()), stderr: '' };
      }
      // La limpieza falla: el contenedor se queda.
      return { status: 1, stdout: '', stderr: 'permission denied' };
    };
    let stdout = '';
    let stderr = '';
    const exit = await cli(
      ['scan', '/repo', COMMIT, wheelhouse, parent],
      {
        runSemgrep: (input) => runSemgrep(input, { uid: 1000, gid: 1000, exportSnapshot: () => inventory, execute }),
        runZizmor: bump,
      },
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.equal(exit, 2);
    assert.equal(stdout, '');
    const separator = stderr.indexOf(' ');
    assert.equal(stderr.slice(0, separator), FAIL);
    const parsed = JSON.parse(stderr.slice(separator + 1));
    assert.equal(parsed.stage, 'tamper');
    assert.equal(parsed.class, 'contract');
    assert.equal(parsed.scanner, 'semgrep');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
