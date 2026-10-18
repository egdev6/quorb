// Read-only integration guards: never launch the app, NSIS or a real vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('NSIS cleanup is per-user and preserves Linux, MSI and macOS packaging', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(conf.bundle.windows.nsis?.installMode, 'currentUser');
  assert.equal(conf.bundle.windows.nsis.installerHooks, 'installer/hooks.nsh');
  assert.deepEqual(conf.bundle.targets, ['nsis', 'msi', 'deb', 'appimage']);
  assert.equal(conf.plugins.updater.windows.installMode, 'passive');
  const mac = JSON.parse(read('src-tauri/tauri.macos.conf.json'));
  assert.deepEqual(mac.bundle.targets, ['app', 'dmg']);
  assert.equal(mac.bundle.windows, undefined);
});

test('only checked, interactive, non-update uninstall invokes native cleanup', () => {
  const hook = read('src-tauri/installer/hooks.nsh');
  assert.match(hook, /\$DeleteAppDataCheckboxState = 1/);
  assert.doesNotMatch(hook, /StrCpy \$DeleteAppDataCheckboxState 1/);
  assert.match(hook, /!if "\$\{INSTALLMODE\}" != "currentUser"/);
  assert.match(hook, /\$UpdateMode <> 1/);
  assert.match(hook, /\$PassiveMode <> 1/);
  assert.match(hook, /\$\{IfNot\} \$\{Silent\}/);
  assert.ok(hook.indexOf('CheckIfAppIsRunning') < hook.indexOf('ExecWait'));
  assert.match(hook, /--quorb-uninstall-cleanup --delete-data/);
  assert.match(hook, /\$\{BUNDLEID\}/);
  assert.match(hook, /\$\{If\} \$\{Errors\}\s*StrCpy \$0 2/);
  assert.match(hook, /\$\{If\} \$0 <> 0[^]*?MessageBox[^]*?SetErrorLevel 2\s*Abort/);
  assert.doesNotMatch(hook, /PowerShell|cmd\.exe|RmDir|DeleteRegKey/);
});

test('installer-triggered removal and noninteractive modes disarm template deletion', () => {
  const hook = read('src-tauri/installer/hooks.nsh');
  assert.match(hook, /\$\{GetOptions\} \$CMDLINE "_\?="/);
  assert.match(hook, /\$\{IfNot\} \$\{Errors\}[\s\S]*?StrCpy \$DeleteAppDataCheckboxState 0/);
  assert.match(hook, /\$\{If\} \$\{Silent\}[\s\S]*?StrCpy \$DeleteAppDataCheckboxState 0/);
  assert.match(hook, /\$\{If\} \$UpdateMode = 1[\s\S]*?\$\{OrIf\} \$PassiveMode = 1[\s\S]*?StrCpy \$DeleteAppDataCheckboxState 0/);
  assert.equal((hook.match(/ExecWait /g) ?? []).length, 1);
  assert.ok(hook.indexOf('"_?="') < hook.indexOf('ExecWait'));
});

test('helper dispatch happens before Tauri and preserves the macOS updater guard', () => {
  const lib = read('src-tauri/src/lib.rs');
  const dispatch = lib.indexOf('uninstall::dispatch');
  const builder = lib.indexOf('tauri::Builder::default()');
  assert.ok(dispatch !== -1 && builder !== -1 && dispatch < builder);
  assert.match(lib, /mod uninstall;/);
  assert.match(lib, /if let Some\(code\) = uninstall::dispatch[^]*?std::process::exit\(code\)/);
  assert.match(lib, /#\[cfg\(not\(target_os = "macos"\)\)\][\s\S]*?let builder = builder\.plugin\(tauri_plugin_updater/);
});

function assertStableIdentityAllowlist(source) {
  // Normalize only CRLF; keep the tuple comparison exact across checkout styles.
  source = source.replace(/\r\n/g, '\n');
  // The production allowlist has exactly the shipped identity, not a second profile.
  const allowlist = source.match(/if !matches!\(\s*\(profile\.identifier, profile\.home_dir\),\s*([^]*?)\n\s*\)/)?.[1];
  assert.equal(allowlist, '("es.egdev.quorb", ".quorb")');
}

const allowlistFixtureLines = [
  'if !matches!(',
  '    (profile.identifier, profile.home_dir),',
  '    ("es.egdev.quorb", ".quorb")',
  ')',
];
for (const [label, endings] of [
  ['LF', ['\n', '\n', '\n']],
  ['CRLF', ['\r\n', '\r\n', '\r\n']],
  ['mixed LF/CRLF', ['\n', '\n', '\r\n']],
]) {
  const fixture = allowlistFixtureLines.map((line, index) => line + (endings[index] ?? '')).join('');
  test(`stable identity allowlist accepts ${label}`, () => {
    assertStableIdentityAllowlist(fixture);
  });
  test(`stable identity allowlist rejects a foreign identity or extra profile with ${label}`, () => {
    assert.throws(() => assertStableIdentityAllowlist(fixture.replace('es.egdev.quorb', 'org.example.foreign')), assert.AssertionError);
    assert.throws(() => assertStableIdentityAllowlist(fixture.replace('".quorb"', '".foreign"')), assert.AssertionError);
    assert.throws(() => assertStableIdentityAllowlist(fixture.replace(
      '("es.egdev.quorb", ".quorb")',
      '("es.egdev.quorb", ".quorb") | ("org.example.foreign", ".foreign")',
    )), assert.AssertionError);
  });
}

test('cleanup keeps the stable identity allowlist and exact credential ownership', () => {
  const source = read('src-tauri/src/uninstall.rs');
  assertStableIdentityAllowlist(source);
  assert.match(source, /target\.strip_suffix\(&format!\("\.\{identifier\}"\)\)/);
  assert.match(source, /crate::secrets::ALL\.contains\(&base\)/);
  assert.match(source, /account\.is_none_or\(crate::config::is_account_id\)/);
  assert.match(source, /entry\.Type != CRED_TYPE_GENERIC/);
  assert.doesNotMatch(source, /get_password|CredentialBlob\s*[),;=]/);
  assert.match(source, /fn authorized[^]*?args == \[[^]*?"--quorb-uninstall-cleanup",\s*"--delete-data",\s*"--channel",\s*identifier,/);
});

test('Rust safety fixtures never dispatch cleanup or call the real credential backend', () => {
  const source = read('src-tauri/src/uninstall.rs');
  const fixtures = source.slice(source.indexOf('#[cfg(test)]'));
  assert.match(fixtures, /use crate::channel::STABLE;/);
  assert.match(fixtures, /org\.example\.foreign/);
  assert.match(fixtures, /linked_root_child_or_ancestor/);
  assert.match(fixtures, /windows_junction_rejected/);
  assert.doesNotMatch(fixtures, /\bdispatch\s*\(|\bdelete_credentials\s*\(/);
});

test('npm test includes cleanup coverage alongside the existing retirement guard', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.test.includes('scripts/uninstall.test.mjs'));
  assert.ok(pkg.scripts.test.includes('scripts/dev-retirement.test.mjs'));
  const manifest = read('src-tauri/Cargo.toml');
  const windowsOnly = manifest.slice(manifest.indexOf("[target.'cfg(windows)'.dependencies]"));
  assert.match(windowsOnly, /"Win32_Security_Credentials"/);
  assert.match(windowsOnly, /windows-sys = \{ version = "0\.61"/);
});
