// Pruebas del procedimiento de firma (scripts/setup-signing.mjs).
//
// El script antiguo ejecutaba red/claves al cargarse, así que este fichero NO lo
// importa a nivel de módulo. El módulo nuevo está protegido con `isDirectRun`, y
// la regresión estática lee su TEXTO sin ejecutarlo. Las pruebas de comportamiento
// cargan el módulo con import dinámico y solo usan fixtures temporales (texto
// minisign sintético, sin criptografía real ni acceso a ~/.tauri del usuario).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, 'setup-signing.mjs');
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
let modPromise;
const load = () => (modPromise ??= import(pathToFileURL(MODULE_PATH).href));

const REPO = 'egdev6/quorb';
const PAYLOAD = Buffer.alloc(64, 9).toString('base64');
const RAW_KEY = `untrusted comment: minisign encrypted secret key\n${PAYLOAD}\n`;
const WRAPPED_KEY = Buffer.from(RAW_KEY, 'utf8').toString('base64');
const RAW_PUB = `untrusted comment: minisign public key 0123456789ABCDEF\n${PAYLOAD}\n`;
const WRAPPED_PUB = Buffer.from(RAW_PUB, 'utf8').toString('base64');
const RAW_PLAIN_KEY = `untrusted comment: minisign secret key\n${PAYLOAD}\n`;
const keys = (home) => ({ keyPath: path.join(home, '.tauri', 'quorb.key'), pubPath: path.join(home, '.tauri', 'quorb.key.pub') });

function mkHome({ pair = 'none', keyFile = WRAPPED_KEY, pubFile = WRAPPED_PUB, dirSymlink = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorb-sign-'));
  const dir = path.join(home, '.tauri');
  if (dirSymlink) {
    fs.mkdirSync(path.join(home, 'real-tauri'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(home, 'real-tauri'), dir);
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const { keyPath, pubPath } = keys(home);
  if (pair === 'complete' || pair === 'partial') fs.writeFileSync(keyPath, keyFile, { mode: 0o600 });
  if (pair === 'complete') fs.writeFileSync(pubPath, pubFile);
  if (pair === 'symlink') {
    const real = path.join(dir, 'real.key');
    fs.writeFileSync(real, keyFile);
    fs.symlinkSync(real, keyPath);
    fs.writeFileSync(pubPath, pubFile);
  }
  return home;
}

function mkCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'quorb-cwd-'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'quorb' }));
  fs.mkdirSync(path.join(cwd, 'src-tauri'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ plugins: { updater: { pubkey: 'PEGA_AQUI_TU_CLAVE_PUBLICA' } } }, null, 2) + '\n',
  );
  fs.mkdirSync(path.join(cwd, 'node_modules', '@tauri-apps', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), '// fake cli\n');
  fs.mkdirSync(path.join(cwd, 'docs', 'mover-a-.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'docs', 'mover-a-.github', 'workflows', 'release.yml'), 'name: rel\n');
  return cwd;
}

function fakeRunner({
  canonical = REPO,
  permission = 'ADMIN',
  secretList = '[]',
  secretListStatus = 0,
  secretStatus = {},
  origin = `https://github.com/${REPO}.git`,
  gitStatus = 0,
  keyFile = WRAPPED_KEY,
  pubFile = WRAPPED_PUB,
  genStatus = 0,
} = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args: [...args], input: opts.input, stdio: opts.stdio, env: opts.env });
    if (cmd === 'git') return { status: gitStatus, stdout: gitStatus === 0 ? `${origin}\n` : '', stderr: '' };
    if (cmd === 'gh' && args[0] === 'repo') {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: canonical, isPrivate: true, viewerPermission: permission }), stderr: '' };
    }
    if (cmd === 'gh' && args[0] === 'secret' && args[1] === 'list') {
      return { status: secretListStatus, stdout: secretListStatus === 0 ? secretList : '', stderr: '' };
    }
    if (cmd === 'gh' && args[0] === 'secret' && args[1] === 'set') {
      return { status: secretStatus[args[2]] ?? 0, stdout: '', stderr: `stderr-privado-${args[2]}` };
    }
    if (cmd === process.execPath) {
      const keyPath = args[args.length - 1];
      fs.writeFileSync(keyPath, keyFile, { mode: 0o600 });
      fs.writeFileSync(`${keyPath}.pub`, pubFile);
      return { status: genStatus, stdout: 'NATIVE-STDOUT-SHOULD-BE-DISCARDED', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function baseDeps(overrides = {}) {
  const cwd = overrides.cwd ?? mkCwd();
  return {
    argv: ['--repo', REPO],
    cwd,
    home: mkHome(),
    gitToplevel: cwd,
    tty: { stdin: { isTTY: true }, stdout: { isTTY: true } },
    env: {},
    setUmask: () => {},
    confirm: async () => true,
    promptHidden: async () => 'clave-de-prueba',
    log: () => {},
    logError: () => {},
    ...overrides,
  };
}

test('restrictPrivateKey endurece permisos laxos sin relajar permisos estrictos', async () => {
  const { restrictPrivateKey } = await load();
  const keyPath = 'fixture.key';
  for (const mode of [0o100644, 0o100666]) {
    const calls = [];
    restrictPrivateKey({
      keyPath,
      fsImpl: {
        statSync: (file) => { assert.equal(file, keyPath); return { mode }; },
        chmodSync: (file, permissions) => calls.push([file, permissions]),
      },
    });
    assert.deepEqual(calls, [[keyPath, 0o600]]);
  }
  for (const mode of [0o100600, 0o100400, 0o100000]) {
    restrictPrivateKey({
      keyPath,
      fsImpl: {
        statSync: () => ({ mode }),
        chmodSync: () => assert.fail('no debe relajar permisos ya estrictos'),
      },
    });
  }
});

test('regresión estática: el helper no conserva los patrones inseguros del script antiguo', () => {
  for (const token of ['--ci', "'-p'", '--password', '--force', '--body', "'auth'", 'mover-a-.github', 'renameSync', 'cpSync']) {
    assert.ok(!SOURCE.includes(token), `el helper no debe contener ${JSON.stringify(token)}`);
  }
  assert.ok(SOURCE.includes('--write-keys'), 'debe usar la generación nativa de la CLI');
});

test('isValidRepo y parseRepoArg exigen un --repo owner/nombre explícito', async () => {
  const { isValidRepo, parseRepoArg } = await load();
  assert.equal(isValidRepo(REPO), true);
  for (const bad of ['quorb', 'a/b/c', 'foo bar/baz', '', 'egdev6/', '/quorb', 'egdev6/qu orb', null, 42]) {
    assert.equal(isValidRepo(bad), false, `no debe aceptar ${JSON.stringify(bad)}`);
  }
  assert.equal(parseRepoArg(['--repo', REPO]), REPO);
  for (const argv of [[], ['--repo'], ['--repo', 'quorb'], ['--repo', REPO, 'extra'], ['--repo', 'a/b', '--repo', 'c/d']]) {
    assert.throws(() => parseRepoArg(argv), /repo|argumento|repositorio/i, `debe rechazar ${JSON.stringify(argv)}`);
  }
});

test('los comandos no exponen contraseñas ni valores en argv', async () => {
  const { generateCommand, secretSetCommand } = await load();
  const gen = generateCommand('/cli/tauri.js', '/o/.tauri/quorb.key');
  assert.deepEqual(gen, ['/cli/tauri.js', 'signer', 'generate', '--write-keys', '/o/.tauri/quorb.key']);
  for (const flag of ['-p', '--password', '--ci', '--force']) assert.ok(!gen.includes(flag), `generación sin ${flag}`);
  const set = secretSetCommand(REPO, 'TAURI_SIGNING_PRIVATE_KEY');
  assert.deepEqual(set, ['secret', 'set', 'TAURI_SIGNING_PRIVATE_KEY', '--repo', REPO]);
  for (const flag of ['-b', '--body']) assert.ok(!set.includes(flag), `secretos por stdin, sin ${flag}`);
});

test('assertOwnerTty exige TTY en stdin y stdout y rechaza CI', async () => {
  const { assertOwnerTty } = await load();
  assert.doesNotThrow(() => assertOwnerTty({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }));
  assert.throws(() => assertOwnerTty({ stdin: {}, stdout: { isTTY: true }, env: {} }), /terminal/i);
  assert.throws(() => assertOwnerTty({ stdin: { isTTY: true }, stdout: {}, env: {} }), /terminal/i);
  assert.throws(() => assertOwnerTty({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CI: 'true' } }), /terminal|CI/i);
});

test('inspectKeyPair distingue none/complete/partial/symlink sin seguir enlaces', async () => {
  const { inspectKeyPair } = await load();
  for (const [pair, expected] of [['none', 'none'], ['complete', 'complete'], ['partial', 'partial'], ['symlink', 'unsafe']]) {
    assert.equal(inspectKeyPair({ fsImpl: fs, ...keys(mkHome({ pair })) }), expected, `estado de ${pair}`);
  }
});

test('lstatOrNull falla cerrado: EACCES lanza y solo ENOENT devuelve none', async () => {
  const { inspectKeyPair } = await load();
  const denied = () => { const error = new Error('permiso denegado'); error.code = 'EACCES'; throw error; };
  assert.throws(() => inspectKeyPair({ fsImpl: { lstatSync: denied }, keyPath: '/x', pubPath: '/y' }), /permiso/);
  const missing = () => { const error = new Error('no existe'); error.code = 'ENOENT'; throw error; };
  assert.equal(inspectKeyPair({ fsImpl: { lstatSync: missing }, keyPath: '/x', pubPath: '/y' }), 'none');
});

test('inspectKeyDir distingue absent/dir/unsafe', async () => {
  const { inspectKeyDir } = await load();
  assert.equal(inspectKeyDir({ fsImpl: fs, dirPath: path.join(mkHome(), '.tauri') }), 'dir');
  assert.equal(inspectKeyDir({ fsImpl: fs, dirPath: path.join(mkHome(), 'no-existe') }), 'absent');
  assert.equal(inspectKeyDir({ fsImpl: fs, dirPath: path.join(mkHome({ dirSymlink: true }), '.tauri') }), 'unsafe');
});

test('normaliza minisign crudo/base64 y rechaza formatos desconocidos', async () => {
  const { normalizeMinisignText, toCanonicalKeySecret, toCanonicalPubkey, isEncryptedSecretKeyText } = await load();
  assert.ok(normalizeMinisignText(RAW_KEY));
  assert.ok(normalizeMinisignText(WRAPPED_KEY));
  for (const bad of ['not base64!!', 'AAAAA', Buffer.from('hola mundo').toString('base64'), '', null, 42]) {
    assert.equal(normalizeMinisignText(bad), null, `no debe normalizar ${JSON.stringify(bad)}`);
  }
  assert.equal(toCanonicalKeySecret(RAW_KEY), WRAPPED_KEY);
  assert.equal(toCanonicalKeySecret(WRAPPED_KEY), WRAPPED_KEY);
  assert.equal(toCanonicalPubkey(RAW_PUB), WRAPPED_PUB);
  assert.equal(toCanonicalPubkey(WRAPPED_PUB), WRAPPED_PUB);
  assert.equal(toCanonicalKeySecret('garbage'), null);
});

test('isEncryptedSecretKeyText: heurística cruda/base64 con payload plausible', async () => {
  const { isEncryptedSecretKeyText } = await load();
  assert.equal(isEncryptedSecretKeyText(RAW_KEY), true);
  assert.equal(isEncryptedSecretKeyText(WRAPPED_KEY), true);
  assert.equal(isEncryptedSecretKeyText(RAW_PLAIN_KEY), false);
  assert.equal(isEncryptedSecretKeyText(Buffer.from(RAW_PLAIN_KEY, 'utf8').toString('base64')), false);
  assert.equal(isEncryptedSecretKeyText(`untrusted comment: minisign encrypted secret key\n${Buffer.alloc(4, 1).toString('base64')}\n`), false);
  assert.equal(isEncryptedSecretKeyText('untrusted comment: minisign encrypted secret key\n'), false);
  assert.equal(isEncryptedSecretKeyText('RWTESTKEYSECRET'), false);
  assert.equal(isEncryptedSecretKeyText(null), false);
});

test('parseGitHubRemote reconoce https/ssh de GitHub y rechaza el resto', async () => {
  const { parseGitHubRemote } = await load();
  assert.equal(parseGitHubRemote('https://github.com/egdev6/quorb.git'), REPO);
  assert.equal(parseGitHubRemote('https://github.com/egdev6/quorb'), REPO);
  assert.equal(parseGitHubRemote('git@github.com:egdev6/quorb.git'), REPO);
  assert.equal(parseGitHubRemote('ssh://git@github.com/egdev6/quorb.git'), REPO);
  assert.equal(parseGitHubRemote('ssh://git@github.com:22/egdev6/quorb.git'), REPO);
  const bad = ['https://gitlab.com/egdev6/quorb.git', 'git@bitbucket.org:egdev6/quorb.git', 'https://x-token-abc@github.com/egdev6/quorb.git', 'github.com/egdev6/quorb', 'weird', '', null, 42];
  for (const value of bad) assert.equal(parseGitHubRemote(value), null, `debe rechazar ${JSON.stringify(value)}`);
});

test('preexistingSecrets aborta con JSON inválido o entradas malformadas', async () => {
  const { preexistingSecrets } = await load();
  assert.deepEqual(preexistingSecrets('[]'), []);
  assert.deepEqual(preexistingSecrets(JSON.stringify([{ name: 'TAURI_SIGNING_PRIVATE_KEY' }])), ['TAURI_SIGNING_PRIVATE_KEY']);
  for (const bad of ['not json', '{"a":1}', '[{"nope":"x"}]', '[null]']) {
    assert.throws(() => preexistingSecrets(bad), /abort|formato|válidas|interpretar/i, `debe abortar con ${bad}`);
  }
});

test('checkPreflight exige raíz git válida, CLI de Tauri y config con plugins.updater', async () => {
  const { checkPreflight } = await load();
  const cwd = mkCwd();
  const cliPath = path.join(cwd, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const confPath = path.join(cwd, 'src-tauri', 'tauri.conf.json');
  assert.deepEqual(checkPreflight({ fsImpl: fs, cwd, cliPath, confPath, gitToplevel: cwd }), []);
  assert.ok(checkPreflight({ fsImpl: fs, cwd, cliPath, confPath, gitToplevel: null }).some((e) => /raíz git/i.test(e)));
  assert.ok(checkPreflight({ fsImpl: fs, cwd, cliPath, confPath, gitToplevel: '/otro/sitio' }).some((e) => /raíz git/i.test(e)));
  assert.ok(checkPreflight({ fsImpl: fs, cwd, cliPath: path.join(cwd, 'no-cli.js'), confPath, gitToplevel: cwd }).some((e) => /CLI de Tauri/i.test(e)));
  fs.writeFileSync(confPath, '{ roto');
  assert.ok(checkPreflight({ fsImpl: fs, cwd, cliPath, confPath, gitToplevel: cwd }).some((e) => /JSON/i.test(e)));
});

test('runSetup rechaza fuera de TTY y sin --repo antes de tocar nada', async () => {
  const { runSetup } = await load();
  const { run, calls } = fakeRunner();
  await assert.rejects(runSetup(baseDeps({ run, tty: { stdin: {}, stdout: { isTTY: true } } })), /terminal/i);
  await assert.rejects(runSetup(baseDeps({ run, argv: [] })), /repo/i);
  assert.equal(calls.length, 0);
});

test('runSetup exige raíz git igual al cwd antes de generar o tocar gh', async () => {
  const { runSetup } = await load();
  const cwd = mkCwd();
  const { run, calls } = fakeRunner();
  await assert.rejects(runSetup(baseDeps({ run, cwd, gitToplevel: null })), /raíz git/i);
  await assert.rejects(runSetup(baseDeps({ run, cwd, gitToplevel: '/otro/sitio' })), /raíz git/i);
  assert.equal(calls.some((c) => c.cmd === process.execPath), false);
  assert.equal(calls.some((c) => c.cmd === 'gh'), false);
});

test('runSetup ata --repo al remoto origin y rechaza desajustes sin subir nada', async () => {
  const { runSetup } = await load();
  const origins = ['https://github.com/otro/repo.git', 'https://gitlab.com/egdev6/quorb.git', 'https://x-token-abc@github.com/egdev6/quorb.git', 'weird'];
  for (const origin of origins) {
    const { run, calls } = fakeRunner({ origin });
    await assert.rejects(runSetup(baseDeps({ run })), /origin|reconocida|coincide/i, `origin ${origin}`);
    assert.equal(calls.some((c) => c.cmd === 'gh'), false, `sin gh para ${origin}`);
    assert.equal(calls.some((c) => c.cmd === process.execPath), false, `sin generar para ${origin}`);
  }
});

test('runSetup no expone un remoto malformado con credenciales incrustadas', async () => {
  const { runSetup } = await load();
  const { run } = fakeRunner({ origin: 'https://x-token-secreto@github.com/egdev6/quorb.git' });
  await assert.rejects(runSetup(baseDeps({ run })), (error) => {
    assert.doesNotMatch(error.message, /x-token-secreto/);
    return true;
  });
});

test('runSetup rechaza repo canónico distinto y sin permiso de escritura', async () => {
  const { runSetup } = await load();
  await assert.rejects(runSetup(baseDeps({ run: fakeRunner({ canonical: 'otro/repo' }).run })), /canónico|coincide/i);
  await assert.rejects(runSetup(baseDeps({ run: fakeRunner({ permission: 'READ' }).run })), /permiso/i);
});

test('runSetup rechaza pares parciales, symlinks y .tauri enlazado sin escribir', async () => {
  const { runSetup } = await load();
  const cases = [
    [mkHome({ pair: 'partial' }), /incompleto|parcial/i],
    [mkHome({ pair: 'symlink' }), /regular|symlink|seguro/i],
    [mkHome({ dirSymlink: true, pair: 'complete' }), /directorio normal|symlink/i],
  ];
  for (const [home, rx] of cases) {
    const cwd = mkCwd();
    const before = fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8');
    const { run, calls } = fakeRunner();
    await assert.rejects(runSetup(baseDeps({ run, home, cwd })), rx);
    assert.equal(calls.some((c) => c.cmd === process.execPath), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8'), before);
  }
});

test('runSetup rechaza un par existente que no parece cifrado', async () => {
  const { runSetup } = await load();
  const home = mkHome({ pair: 'complete', keyFile: RAW_PLAIN_KEY });
  await assert.rejects(runSetup(baseDeps({ run: fakeRunner().run, home })), /cifrad/i);
});

test('runSetup genera, escribe pub canónica y sube el secreto canónico por stdin', async () => {
  const { runSetup, SECRET_KEY, SECRET_PASSWORD } = await load();
  const home = mkHome();
  const cwd = mkCwd();
  const { run, calls } = fakeRunner();
  const result = await runSetup(baseDeps({ run, home, cwd }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.secretsUploaded, [SECRET_KEY, SECRET_PASSWORD]);
  const gen = calls.find((c) => c.cmd === process.execPath);
  assert.ok(gen, 'debe generar con la CLI nativa');
  for (const flag of ['-p', '--password', '--ci', '--force']) assert.ok(!gen.args.includes(flag));
  assert.ok(gen.args.includes('--write-keys'));
  const conf = JSON.parse(fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.plugins.updater.pubkey, WRAPPED_PUB);
  const sets = calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'set');
  assert.equal(sets.length, 2);
  for (const s of sets) {
    assert.ok(!s.args.includes('-b') && !s.args.includes('--body'), 'valor nunca en argv');
    assert.equal(typeof s.input, 'string');
    assert.ok(s.input.length > 0);
  }
  assert.equal(sets.find((s) => s.args[2] === SECRET_KEY).input, WRAPPED_KEY, 'secreto base64 canónico');
  assert.equal(sets.find((s) => s.args[2] === SECRET_PASSWORD).input, 'clave-de-prueba');
  assert.equal(fs.existsSync(path.join(cwd, 'docs', 'mover-a-.github', 'workflows', 'release.yml')), true, 'no mueve docs');
  // Los bits POSIX no representan las ACL de Windows; el contrato de chmod
  // se comprueba en todos los sistemas con fsImpl simulado en la prueba anterior.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keys(home).keyPath).mode & 0o077, 0, 'clave privada sin permisos de grupo/otros (POSIX)');
  }
});

test('runSetup sube base64 canónico aunque el fichero nativo sea crudo', async () => {
  const { runSetup, SECRET_KEY } = await load();
  const cwd = mkCwd();
  const { run, calls } = fakeRunner({ keyFile: RAW_KEY, pubFile: RAW_PUB });
  const result = await runSetup(baseDeps({ run, home: mkHome(), cwd }));
  assert.equal(result.status, 'completed');
  const conf = JSON.parse(fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.plugins.updater.pubkey, WRAPPED_PUB);
  assert.equal(calls.find((c) => c.cmd === 'gh' && c.args[2] === SECRET_KEY).input, WRAPPED_KEY);
});

test('runSetup no reutiliza un par existente sin confirmación explícita', async () => {
  const { runSetup } = await load();
  let n = 0;
  const confirm = async () => { n += 1; return n === 1; };
  const { run, calls } = fakeRunner();
  await assert.rejects(runSetup(baseDeps({ run, home: mkHome({ pair: 'complete' }), confirm })), /reutiliz|cancelad/i);
  assert.equal(calls.some((c) => c.args[1] === 'set'), false);
});

test('runSetup exige contraseña no vacía y no sube nada si está en blanco', async () => {
  const { runSetup } = await load();
  const { run, calls } = fakeRunner();
  await assert.rejects(runSetup(baseDeps({ run, home: mkHome({ pair: 'complete' }), promptHidden: async () => '' })), /contraseña/i);
  assert.equal(calls.some((c) => c.args[1] === 'set'), false);
});

test('runSetup aborta si listar secretos falla y no escribe config ni sube', async () => {
  const { runSetup } = await load();
  const home = mkHome({ pair: 'complete' });
  const cwd = mkCwd();
  const before = fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8');
  const { run, calls } = fakeRunner({ secretListStatus: 1 });
  await assert.rejects(runSetup(baseDeps({ run, home, cwd })), /listar|secretos/i);
  assert.equal(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'set'), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8'), before);
});

test('runSetup aborta si la lista de secretos es inválida y no escribe config', async () => {
  const { runSetup } = await load();
  const home = mkHome({ pair: 'complete' });
  const cwd = mkCwd();
  const before = fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8');
  for (const secretList of ['not json', '{"a":1}', '[{"nope":"x"}]']) {
    const { run, calls } = fakeRunner({ secretList });
    await assert.rejects(runSetup(baseDeps({ run, home, cwd })), /abort|formato|válidas|interpretar/i);
    assert.equal(calls.some((c) => c.cmd === 'gh' && c.args[1] === 'set'), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'src-tauri', 'tauri.conf.json'), 'utf8'), before);
  }
});

test('runSetup no reporta éxito si solo sube uno de los dos secretos', async () => {
  const { runSetup, SECRET_KEY, SECRET_PASSWORD } = await load();
  const { run, calls } = fakeRunner({ secretStatus: { [SECRET_PASSWORD]: 1 } });
  await assert.rejects(runSetup(baseDeps({ run, home: mkHome({ pair: 'complete' }) })), (error) => {
    assert.match(error.message, new RegExp(SECRET_KEY));
    assert.match(error.message, /subidos|ninguno/i);
    assert.doesNotMatch(error.message, /stderr-privado/);
    return true;
  });
  const sets = calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'set');
  assert.deepEqual(sets.map((s) => s.args[2]), [SECRET_KEY, SECRET_PASSWORD], 'un intento por secreto, sin reintentos');
});

test('runSetup exige confirmación para reemplazar secretos existentes', async () => {
  const { runSetup } = await load();
  let n = 0;
  const confirm = async () => { n += 1; return n <= 2; }; // plan + reutilizar sí; reemplazar no
  const { run, calls } = fakeRunner({ secretList: JSON.stringify([{ name: 'TAURI_SIGNING_PRIVATE_KEY' }]) });
  await assert.rejects(runSetup(baseDeps({ run, home: mkHome({ pair: 'complete' }), confirm })), /reemplaz|rotan/i);
  assert.equal(calls.some((c) => c.args[1] === 'set'), false);
});

test('runSetup sanea el entorno del generador, descarta stdout y no filtra valores', async () => {
  const { runSetup } = await load();
  const logs = [];
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/o',
    TAURI_SIGNING_PRIVATE_KEY: 'VALOR-SECRETO-1',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'VALOR-SECRETO-2',
  };
  const { run, calls } = fakeRunner();
  const result = await runSetup(baseDeps({ run, home: mkHome(), env, log: (line) => logs.push(String(line)) }));
  assert.equal(result.status, 'completed');
  const gen = calls.find((c) => c.cmd === process.execPath);
  assert.deepEqual(gen.stdio, ['inherit', 'pipe', 'inherit']);
  assert.deepEqual(Object.keys(gen.env).sort(), ['HOME', 'PATH']);
  for (const line of logs) assert.doesNotMatch(line, /VALOR-SECRETO/);
  assert.ok(!logs.some((line) => line.includes('NATIVE-STDOUT-SHOULD-BE-DISCARDED')));
});
