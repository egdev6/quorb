// Read-only NSIS handoff guards: inspect source without launching an installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const handoff = '"$APPDATA\\${BUNDLEID}\\installer-locale"';
const directory = '"$APPDATA\\${BUNDLEID}"';

function macro(name) {
  const source = read('src-tauri/installer/hooks.nsh').replace(/\r\n/g, '\n');
  const pattern = new RegExp(`^!macro ${name}[ \\t]*\\n([\\s\\S]*?)^!macroend[ \\t]*$`, 'gm');
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `expected exactly one ${name} macro`);
  return matches[0][1].split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';'));
}

function interactivePostinstall() {
  const lines = macro('NSIS_HOOK_POSTINSTALL');
  // All writes are inside this conjunction; all three other modes take Else.
  assert.deepEqual(lines.slice(0, 3), [
    '${IfNot} ${Silent}',
    '${AndIf} $PassiveMode <> 1',
    '${AndIf} $UpdateMode <> 1',
  ]);
  assert.deepEqual(lines.slice(-3), ['${Else}', `Delete ${handoff}`, '${EndIf}']);
  return lines.slice(3, -3);
}

test('NSIS enables the English and Spanish language selector', () => {
  const nsis = JSON.parse(read('src-tauri/tauri.conf.json')).bundle.windows.nsis;
  assert.deepEqual(nsis.languages, ['English', 'Spanish']);
  assert.equal(nsis.displayLanguageSelector, true);
});

test('locale configuration keeps per-user hooks and all existing bundle targets', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(conf.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(conf.bundle.windows.nsis.installerHooks, 'installer/hooks.nsh');
  assert.deepEqual(conf.bundle.targets, ['nsis', 'msi', 'deb', 'appimage']);
});

test('postinstall writes only interactively and removes stale choices in all other modes', () => {
  const body = interactivePostinstall();
  assert.deepEqual(body.slice(0, 5), [
    `CreateDirectory ${directory}`,
    `Delete ${handoff}`,
    'ClearErrors',
    `FileOpen $0 ${handoff} w`,
    '${IfNot} ${Errors}',
  ]);
  assert.equal(body.filter((line) => /^FileOpen\b/.test(line)).length, 1);
  assert.equal(body.filter((line) => /^FileWrite\b/.test(line)).length, 3);
  assert.equal(body.filter((line) => /^FileClose\b/.test(line)).length, 1);
});

test('postinstall writes Spanish for language 1034 and English otherwise, then the version', () => {
  const body = interactivePostinstall();
  const language = body.indexOf('${If} $LANGUAGE = 1034');
  assert.notEqual(language, -1);
  assert.deepEqual(body.slice(language, language + 7), [
    '${If} $LANGUAGE = 1034',
    'FileWrite $0 "es$\\r$\\n"',
    '${Else}',
    'FileWrite $0 "en$\\r$\\n"',
    '${EndIf}',
    'FileWrite $0 "${VERSION}$\\r$\\n"',
    'FileClose $0',
  ]);
});

test('handoff write errors do not abort installation and remove a partial file', () => {
  const body = interactivePostinstall();
  assert.deepEqual(body.slice(-5), [
    'FileClose $0',
    '${If} ${Errors}',
    `Delete ${handoff}`,
    '${EndIf}',
    '${EndIf}',
  ]);
  assert.doesNotMatch(body.join('\n'), /^(?:Abort|Quit|SetErrorLevel|MessageBox)\b/m);
});

test('preuninstall removes the handoff outside update mode without replacing cleanup', () => {
  const pre = macro('NSIS_HOOK_PREUNINSTALL');
  const guard = pre.indexOf('${If} $UpdateMode <> 1');
  assert.notEqual(guard, -1);
  assert.deepEqual(pre.slice(guard, guard + 3), [
    '${If} $UpdateMode <> 1',
    `Delete ${handoff}`,
    '${EndIf}',
  ]);
  assert.equal(pre.filter((line) => /^Delete\b/.test(line)).length, 1);
  assert.ok(pre.includes('${If} $DeleteAppDataCheckboxState = 1'));
  assert.ok(pre.some((line) => line.includes('--quorb-uninstall-cleanup --delete-data')));
});

test('hooks never rewrite app configuration or add another cleanup command', () => {
  const hook = read('src-tauri/installer/hooks.nsh');
  assert.doesNotMatch(hook, /config\.json/i);
  assert.doesNotMatch(hook, /PowerShell|cmd\.exe|RmDir|DeleteRegKey/);
  assert.equal((hook.match(/ExecWait /g) ?? []).length, 1);
});

test('npm test runs the locale guard next to the existing uninstall guard', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.test, /scripts\/uninstall\.test\.mjs\s+scripts\/installer-locale\.test\.mjs/);
});
