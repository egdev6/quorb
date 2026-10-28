//! Instalación asistida del CLI de Codex y detección de su presencia.
//!
//! En Windows, Quorb puede instalar el CLI oficial de Codex en una carpeta
//! gestionada propia (`~/.quorb/tools/codex-0.162.1`) sin tocar el registro
//! global de npm, el PATH del sistema ni las credenciales del usuario.
//!
//! Toda la política es inyectable (plataforma, par Node/npm, entorno base y
//! ejecutor de procesos) para poder probarla en cualquier sistema con un
//! ejecutor falso y carpetas temporales. Nada de este módulo instala nada en
//! Linux: la comprobación de plataforma se hace con el valor inyectado.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

// El ejecutor real de procesos (contención + captura acotada) vive aparte.
pub use crate::cli_process::{CommandOutput, CommandRunner, ProcessRunner, RunError};

/// Paquete y versión exactos (constante: nunca viene del frontend).
pub const CODEX_PACKAGE: &str = "@openai/codex@0.162.1";
/// Versión fijada del CLI nativo.
pub const CODEX_VERSION: &str = "0.162.1";
/// Registro canónico de npm.
pub const NPM_REGISTRY: &str = "https://registry.npmjs.org/";
/// Nombre del ejecutable nativo gestionado.
pub const CODEX_BIN_NAME: &str = "codex.exe";

const MIN_NODE_MAJOR: u32 = 22;
const NPM_TIMEOUT: Duration = Duration::from_secs(600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

pub const MSG_BUSY: &str = "Ya hay una instalación de Codex en curso.";
pub const MSG_WRONG_WINDOW: &str = "La instalación de Codex solo puede lanzarse desde Ajustes.";
pub const MSG_UNSUPPORTED: &str =
    "La instalación asistida de Codex solo está disponible en Windows (x64 o arm64).";
pub const MSG_NO_NODE: &str = "No encuentro Node.js 22 o superior en este equipo.";
pub const MSG_NODE_OLD: &str = "La versión o arquitectura de Node.js no es compatible.";
pub const MSG_ALREADY_INSTALLED: &str = "Ya existe una instalación gestionada de Codex.";
pub const MSG_GENERIC_ERROR: &str = "No se pudo completar la instalación de Codex.";
pub const MSG_CANCELLED: &str = "Instalación cancelada.";
pub const MSG_INSTALLED: &str = "Codex se ha instalado correctamente.";

/// Mensaje del diálogo de consentimiento en el idioma dado, con el nombre del
/// canal y la carpeta gestionada ya sustituidos. El literal original en
/// español vive en el catálogo: `i18n::CODEX_CONSENT_MESSAGE_ES`.
pub fn consent_message(locale: crate::i18n::Locale) -> String {
    let profile = crate::channel::current();
    crate::i18n::codex_consent_message(locale, profile.name, profile.home_dir)
}

// ───────────────────────── DTOs ─────────────────────────

/// Resultado de un intento de instalación (persistido en memoria).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodexOutcome {
    Installed,
    Cancelled,
    Failed,
}

/// Estado que consume Ajustes (camelCase, solo lectura).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexSetupStatus {
    pub supported: bool,
    pub busy: bool,
    pub node_available: bool,
    pub installed: bool,
    pub package: String,
    pub message: Option<String>,
    pub outcome: Option<CodexOutcome>,
}

/// Resultado devuelto por `install_codex`: nunca `failed` (eso viaja como `Err`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallOutcome {
    Installed,
    Cancelled,
}

/// Respuesta de `install_codex`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexInstallResult {
    pub outcome: InstallOutcome,
    pub message: String,
}

/// Estado gestionado por Tauri: un flag global de ocupado y el último resultado.
#[derive(Default)]
pub struct CodexSetupState {
    busy: AtomicBool,
    last: Mutex<Option<LastResult>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LastResult {
    outcome: CodexOutcome,
    message: String,
}

impl CodexSetupState {
    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    fn last(&self) -> Option<LastResult> {
        self.last.lock().unwrap().clone()
    }

    fn set_last(&self, outcome: CodexOutcome, message: &str) {
        *self.last.lock().unwrap() = Some(LastResult {
            outcome,
            message: message.to_string(),
        });
    }

    fn begin(&self) -> Option<BusyGuard<'_>> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| BusyGuard(&self.busy))
    }
}

/// Libera el flag de ocupado al salir, pase lo que pase.
struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// ───────────────────────── plataforma ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    WindowsX64,
    WindowsArm64,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if !cfg!(windows) {
            Self::Other
        } else if cfg!(target_arch = "x86_64") {
            Self::WindowsX64
        } else if cfg!(target_arch = "aarch64") {
            Self::WindowsArm64
        } else {
            Self::Other
        }
    }

    pub fn supported(self) -> bool {
        matches!(self, Self::WindowsX64 | Self::WindowsArm64)
    }
}

/// Nombre del paquete alias nativo y triplete para cada plataforma soportada.
fn alias_and_triple(platform: Platform) -> Option<(&'static str, &'static str)> {
    match platform {
        Platform::WindowsX64 => Some(("codex-win32-x64", "x86_64-pc-windows-msvc")),
        Platform::WindowsArm64 => Some(("codex-win32-arm64", "aarch64-pc-windows-msvc")),
        Platform::Other => None,
    }
}

/// PATH "fresco" leído del registro de Windows (HKCU y HKLM), expandiendo
/// únicamente las variables referenciadas con el entorno del proceso. Fuera de
/// Windows devuelve una lista vacía. Nunca modifica el entorno global.
pub(crate) fn fresh_windows_path_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;
        let lookup = |name: &str| std::env::var(name).ok();
        let sources = [
            (HKEY_CURRENT_USER, "Environment"),
            (
                HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            ),
        ];
        let mut dirs = vec![];
        for (hive, subkey) in sources {
            let Ok(key) = RegKey::predef(hive).open_subkey(subkey) else {
                continue;
            };
            let Ok(raw) = key.get_value::<String, _>("Path") else {
                continue;
            };
            let expanded = expand_percent(&raw, &lookup);
            dirs.extend(std::env::split_paths(&expanded).filter(|d| !d.as_os_str().is_empty()));
        }
        dirs
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

/// Expande `%NAME%` en una sola pasada (acotada, sin bucles) usando solo los
/// nombres referenciados. Solo se usa en la lectura del registro de Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn expand_percent(input: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if bytes[i] == b'%' {
            if let Some(end) = input[i + 1..].find('%') {
                let name = &input[i + 1..i + 1 + end];
                if !name.is_empty() && !name.contains('%') {
                    if let Some(value) = lookup(name) {
                        out.push_str(&value);
                        i = i + end + 2;
                        continue;
                    }
                }
            }
        }
        let ch = input[i..].chars().next().unwrap_or('\u{0}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

// ───────────────────────── descubrimiento de Node ─────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodePair {
    pub node: PathBuf,
    pub npm_cli: PathBuf,
}

/// Busca el primer directorio con el par node.exe + npm-cli.js de la misma raíz.
pub fn discover_node_in(roots: &[PathBuf]) -> Option<NodePair> {
    roots.iter().find_map(|root| {
        let node = root.join("node.exe");
        let npm = root
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");
        (node.is_file() && npm.is_file()).then(|| NodePair { node, npm_cli: npm })
    })
}

/// Raíces donde puede vivir Node: PATH del proceso, PATH fresco del registro y
/// carpetas conocidas. Sin escanear el home.
pub fn node_search_roots(_platform: Platform) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    roots.extend(fresh_windows_path_dirs());
    roots.extend(known_node_dirs());
    dedupe(roots)
}

fn known_node_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![];
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let base = PathBuf::from(base);
            dirs.push(base.join("nodejs"));
            dirs.push(base.join("Programs").join("nodejs"));
        }
    }
    dirs
}

fn dedupe(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![];
    for path in paths {
        if !path.as_os_str().is_empty() && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

// ───────────────────────── argumentos y entorno ─────────────────────────

/// Argumentos fijos de npm. Todo es constante: el frontend no aporta nada.
pub fn npm_install_args(stage: &Path) -> Vec<String> {
    vec![
        "--ignore-scripts".into(),
        "--no-audit".into(),
        "--no-fund".into(),
        "--include=optional".into(),
        "--bin-links=true".into(),
        "--registry".into(),
        NPM_REGISTRY.into(),
        "--prefix".into(),
        stage.to_string_lossy().into_owned(),
        "-g".into(),
        CODEX_PACKAGE.into(),
    ]
}

/// Lanzamiento npm: programa `node.exe`, 1.er arg `npm-cli.js`, verbo `install` y flags fijos (sin shell).
fn npm_command(node: &NodePair, stage: &Path) -> (PathBuf, Vec<String>) {
    let mut args = vec![
        node.npm_cli.to_string_lossy().into_owned(),
        "install".to_string(),
    ];
    args.extend(npm_install_args(stage));
    (node.node.clone(), args)
}

/// Lista blanca estricta del entorno de Windows: nada de `NODE_OPTIONS`,
/// `npm_config_*`, tokens ni proxies del proceso padre.
const ENV_ALLOWLIST: &[&str] = &[
    "SystemRoot",
    "windir",
    "SystemDrive",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMDATA",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
];

fn allowlisted_env(base: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    base.iter()
        .filter(|(key, _)| ENV_ALLOWLIST.iter().any(|a| a.eq_ignore_ascii_case(key)))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn set_node_path(
    env: &mut BTreeMap<String, String>,
    base: &BTreeMap<String, String>,
    node_root: &Path,
) {
    let mut dirs = vec![node_root.to_path_buf()];
    if let Some((_, value)) = base
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
    {
        dirs.extend(std::env::split_paths(value));
    }
    if let Ok(joined) = std::env::join_paths(dirs) {
        env.insert("PATH".into(), joined.to_string_lossy().into_owned());
    }
}

/// Entorno mínimo para ejecutar Node (sin configuración de npm).
pub fn probe_env(base: &BTreeMap<String, String>, node_root: &Path) -> BTreeMap<String, String> {
    let mut env = allowlisted_env(base);
    set_node_path(&mut env, base, node_root);
    env
}

/// Entorno del hijo npm: lista blanca + PATH con la raíz de Node delante y una
/// configuración/caché de npm propias dentro del stage.
pub fn child_env(
    _platform: Platform,
    base: &BTreeMap<String, String>,
    node_root: &Path,
    stage: &Path,
) -> BTreeMap<String, String> {
    let mut env = probe_env(base, node_root);
    env.insert(
        "NPM_CONFIG_USERCONFIG".into(),
        stage.join("npmrc-user").to_string_lossy().into_owned(),
    );
    env.insert(
        "NPM_CONFIG_GLOBALCONFIG".into(),
        stage.join("npmrc-global").to_string_lossy().into_owned(),
    );
    env.insert(
        "NPM_CONFIG_CACHE".into(),
        stage.join("cache").to_string_lossy().into_owned(),
    );
    env
}

/// Subconjunto permitido del entorno del proceso (solo claves referenciadas,
/// sin enumerar ni volcar tokens).
pub fn process_env_map() -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for key in ENV_ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            map.insert((*key).to_string(), value);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        map.insert("PATH".into(), path);
    }
    map
}

// ───────────────────────── rutas gestionadas ─────────────────────────

pub fn tools_root(home: &Path) -> PathBuf {
    crate::channel::home_root(home).join("tools")
}

pub fn canonical_prefix(root: &Path) -> PathBuf {
    root.join(format!("codex-{CODEX_VERSION}"))
}

fn nested(base: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(base.to_path_buf(), |p, s| p.join(s))
}

/// Los dos contenedores conocidos del alias nativo bajo la raíz instalada.
fn alias_parents(root: &Path) -> Vec<PathBuf> {
    vec![
        nested(
            root,
            &[
                "node_modules",
                "@openai",
                "codex",
                "node_modules",
                "@openai",
            ],
        ),
        nested(root, &["node_modules", "@openai"]),
    ]
}

/// Rutas relativas conocidas (acotadas) dentro del paquete del alias.
fn alias_exe_relpaths(triple: &str) -> Vec<PathBuf> {
    vec![
        nested(Path::new("vendor"), &[triple, "codex", CODEX_BIN_NAME]),
        nested(Path::new("vendor"), &[triple, "bin", CODEX_BIN_NAME]),
        nested(Path::new("vendor"), &[triple, CODEX_BIN_NAME]),
        nested(Path::new("bin"), &[CODEX_BIN_NAME]),
        PathBuf::from(CODEX_BIN_NAME),
    ]
}

pub fn native_exe_candidates(platform: Platform, root: &Path) -> Vec<PathBuf> {
    let Some((alias, triple)) = alias_and_triple(platform) else {
        return vec![];
    };
    let rels = alias_exe_relpaths(triple);
    let mut out = vec![];
    for parent in alias_parents(root) {
        let alias_root = parent.join(alias);
        for rel in &rels {
            out.push(alias_root.join(rel));
        }
    }
    out
}

pub fn resolve_native_exe(platform: Platform, root: &Path) -> Option<PathBuf> {
    native_exe_candidates(platform, root)
        .into_iter()
        .find(|p| p.is_file())
}

/// Carpetas gestionadas (ambos alias y layouts) donde login puede encontrar
/// `codex.exe` sin depender del PATH ni de Node.
pub fn managed_native_dirs(home: &Path) -> Vec<PathBuf> {
    let prefix = canonical_prefix(&tools_root(home));
    let mut dirs = vec![];
    for (alias, triple) in [
        ("codex-win32-x64", "x86_64-pc-windows-msvc"),
        ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
    ] {
        let rels = alias_exe_relpaths(triple);
        for parent in alias_parents(&prefix) {
            let alias_root = parent.join(alias);
            for rel in &rels {
                if let Some(dir) = alias_root.join(rel).parent() {
                    let dir = dir.to_path_buf();
                    if !dirs.contains(&dir) {
                        dirs.push(dir);
                    }
                }
            }
        }
    }
    dirs
}

pub fn codex_installed_in(platform: Platform, tools_root: &Path, cli_on_path: bool) -> bool {
    cli_on_path || resolve_native_exe(platform, &canonical_prefix(tools_root)).is_some()
}

// ───────────────────────── flujo de instalación ─────────────────────────

pub fn settings_window_ok(label: &str) -> bool {
    label == crate::SETTINGS
}

fn parse_node_major(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn parse_codex_version(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .map(|token| token.trim_start_matches('v'))
        .find(|token| {
            token.chars().next().is_some_and(|c| c.is_ascii_digit())
                && token.matches('.').count() >= 2
        })
        .map(str::to_string)
}

fn arch_matches(platform: Platform, arch: &str) -> bool {
    match platform {
        Platform::WindowsX64 => arch == "x64",
        Platform::WindowsArm64 => arch == "arm64",
        Platform::Other => false,
    }
}

/// Comprueba `node --version` (>= 22) y `node -p process.arch` (arquitectura
/// compatible). Son dos comandos fijos tras el consentimiento.
fn node_metadata(
    node: &NodePair,
    platform: Platform,
    env: &BTreeMap<String, String>,
    runner: &dyn CommandRunner,
) -> Result<(), String> {
    let cwd = node.node.parent().unwrap_or_else(|| Path::new("."));
    let version = runner
        .run(
            &node.node,
            &["--version".to_string()],
            env,
            cwd,
            PROBE_TIMEOUT,
        )
        .ok()
        .filter(|out| out.code == 0)
        .and_then(|out| parse_node_major(&out.stdout))
        .ok_or_else(|| MSG_GENERIC_ERROR.to_string())?;
    if version < MIN_NODE_MAJOR {
        return Err(MSG_NODE_OLD.to_string());
    }
    let arch = runner
        .run(
            &node.node,
            &["-p".to_string(), "process.arch".to_string()],
            env,
            cwd,
            PROBE_TIMEOUT,
        )
        .ok()
        .filter(|out| out.code == 0)
        .map(|out| out.stdout.trim().to_string())
        .ok_or_else(|| MSG_GENERIC_ERROR.to_string())?;
    if !arch_matches(platform, &arch) {
        return Err(MSG_NODE_OLD.to_string());
    }
    Ok(())
}

fn unique_stage(root: &Path) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    for _ in 0..1000 {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let candidate = root.join(format!(
            "codex-{CODEX_VERSION}-stage-{}-{n}",
            std::process::id()
        ));
        if !candidate.exists() {
            return candidate;
        }
    }
    root.join(format!(
        "codex-{CODEX_VERSION}-stage-{}",
        std::process::id()
    ))
}

/// Limpia el stage propiedad de esta operación al salir, salvo que se promueva.
struct StageGuard {
    path: PathBuf,
    armed: bool,
}

impl Drop for StageGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn npm_ok(result: Result<CommandOutput, RunError>) -> bool {
    matches!(result, Ok(out) if out.code == 0)
}

fn version_ok(result: Result<CommandOutput, RunError>) -> bool {
    matches!(
        result,
        Ok(out) if out.code == 0
            && parse_codex_version(&out.stdout).as_deref() == Some(CODEX_VERSION)
    )
}

pub fn install_codex_flow(
    state: &CodexSetupState,
    platform: Platform,
    node: Option<&NodePair>,
    tools_root: &Path,
    base_env: &BTreeMap<String, String>,
    runner: &dyn CommandRunner,
    confirm: &dyn Fn() -> bool,
) -> Result<CodexInstallResult, String> {
    // Rechazo de invocaciones concurrentes ANTES de pedir confirmación.
    let _guard = match state.begin() {
        Some(guard) => guard,
        None => return Err(MSG_BUSY.to_string()),
    };

    fn fail(state: &CodexSetupState, message: &str) -> Result<CodexInstallResult, String> {
        state.set_last(CodexOutcome::Failed, message);
        Err(message.to_string())
    }

    if !platform.supported() {
        return fail(state, MSG_UNSUPPORTED);
    }

    // Confirmación nativa antes de cualquier proceso o escritura.
    if !confirm() {
        state.set_last(CodexOutcome::Cancelled, MSG_CANCELLED);
        return Ok(CodexInstallResult {
            outcome: InstallOutcome::Cancelled,
            message: MSG_CANCELLED.to_string(),
        });
    }

    let Some(node) = node else {
        return fail(state, MSG_NO_NODE);
    };
    let prefix = canonical_prefix(tools_root);
    if prefix.exists() {
        // Si ya hay un prefijo gestionado (aunque esté corrupto o sin binario
        // nativo), no se repara ni se sobrescribe: fail-safe, decide el usuario.
        return fail(state, MSG_ALREADY_INSTALLED);
    }

    let node_root = node.node.parent().unwrap_or_else(|| Path::new("."));
    if let Err(message) = node_metadata(node, platform, &probe_env(base_env, node_root), runner) {
        return fail(state, &message);
    }

    if std::fs::create_dir_all(tools_root).is_err() {
        return fail(state, MSG_GENERIC_ERROR);
    }
    let stage = unique_stage(tools_root);
    if std::fs::create_dir_all(&stage).is_err() {
        return fail(state, MSG_GENERIC_ERROR);
    }
    let mut cleanup = StageGuard {
        path: stage.clone(),
        armed: true,
    };

    // Config de npm vacía y caché propia dentro del stage.
    for name in ["npmrc-user", "npmrc-global"] {
        if std::fs::write(stage.join(name), b"").is_err() {
            return fail(state, MSG_GENERIC_ERROR);
        }
    }
    if std::fs::create_dir_all(stage.join("cache")).is_err() {
        return fail(state, MSG_GENERIC_ERROR);
    }

    let env = child_env(platform, base_env, node_root, &stage);
    let (npm_program, npm_args) = npm_command(node, &stage);
    if !npm_ok(runner.run(&npm_program, &npm_args, &env, &stage, NPM_TIMEOUT)) {
        return fail(state, MSG_GENERIC_ERROR);
    }

    // Exit 0 no basta: debe existir el binario nativo del alias correcto.
    let Some(exe) = resolve_native_exe(platform, &stage) else {
        return fail(state, MSG_GENERIC_ERROR);
    };

    // Verificación real de la versión fijada, ejecutando el binario nativo.
    let verify_env = child_env(platform, base_env, node_root, &stage);
    if !version_ok(runner.run(
        &exe,
        &["--version".to_string()],
        &verify_env,
        &stage,
        PROBE_TIMEOUT,
    )) {
        return fail(state, MSG_GENERIC_ERROR);
    }

    // Promoción atómica solo tras verificar; nunca sobrescribe.
    if prefix.exists() {
        return fail(state, MSG_ALREADY_INSTALLED);
    }
    if std::fs::rename(&stage, &prefix).is_err() {
        return fail(state, MSG_GENERIC_ERROR);
    }
    cleanup.armed = false;

    state.set_last(CodexOutcome::Installed, MSG_INSTALLED);
    Ok(CodexInstallResult {
        outcome: InstallOutcome::Installed,
        message: MSG_INSTALLED.to_string(),
    })
}

/// Estado de solo lectura para Ajustes: sin procesos, red ni mutaciones.
pub fn status(state: &CodexSetupState) -> CodexSetupStatus {
    let platform = Platform::current();
    let last = state.last();
    CodexSetupStatus {
        supported: platform.supported(),
        busy: state.busy(),
        node_available: discover_node_in(&node_search_roots(platform)).is_some(),
        installed: codex_installed_in(
            platform,
            &tools_root(&crate::providers::home()),
            crate::login::codex_cli_found(),
        ),
        package: CODEX_PACKAGE.to_string(),
        message: last.as_ref().map(|l| l.message.clone()),
        outcome: last.map(|l| l.outcome),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── utilidades de prueba ──

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "quorb-codex-setup-{}-{tag}-{n}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Raíz de Node con el par node.exe + npm-cli.js ya creado.
    fn fake_node(tag: &str) -> (TempDir, NodePair) {
        let dir = TempDir::new(tag);
        let node = dir.path().join("node.exe");
        let npm = dir.path().join("node_modules/npm/bin/npm-cli.js");
        std::fs::create_dir_all(npm.parent().unwrap()).unwrap();
        std::fs::write(&node, b"").unwrap();
        std::fs::write(&npm, b"").unwrap();
        (dir, NodePair { node, npm_cli: npm })
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Call {
        program: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        cwd: PathBuf,
        timeout: Duration,
    }

    type Handler = dyn Fn(&Call) -> Result<CommandOutput, RunError> + Send + Sync;

    struct FakeRunner {
        handler: Box<Handler>,
        calls: Mutex<Vec<Call>>,
    }

    impl FakeRunner {
        fn new<F>(f: F) -> Self
        where
            F: Fn(&Call) -> Result<CommandOutput, RunError> + Send + Sync + 'static,
        {
            Self {
                handler: Box::new(f),
                calls: Mutex::new(vec![]),
            }
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }

        fn programs(&self) -> Vec<String> {
            self.calls().into_iter().map(|c| c.program).collect()
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(
            &self,
            program: &Path,
            args: &[String],
            env: &BTreeMap<String, String>,
            cwd: &Path,
            timeout: Duration,
        ) -> Result<CommandOutput, RunError> {
            let call = Call {
                program: program.to_string_lossy().into_owned(),
                args: args.to_vec(),
                env: env.clone(),
                cwd: cwd.to_path_buf(),
                timeout,
            };
            self.calls.lock().unwrap().push(call.clone());
            (self.handler)(&call)
        }
    }

    fn ok_out(stdout: &str) -> Result<CommandOutput, RunError> {
        Ok(CommandOutput {
            code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        })
    }

    fn arch_of(platform: Platform) -> &'static str {
        match platform {
            Platform::WindowsArm64 => "arm64",
            _ => "x64",
        }
    }

    fn arg_value(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1).cloned())
    }

    /// ¿Es la llamada a npm? (programa `npm-cli.js` o primer arg = npm-cli.js).
    fn is_npm_call(node: &NodePair, call: &Call) -> bool {
        call.program.ends_with("npm-cli.js")
            || call.args.first().map(String::as_str)
                == Some(node.npm_cli.to_string_lossy().as_ref())
    }

    /// Contrato real: node.exe emparejado + npm-cli.js como 1.er arg + verbo `install`.
    fn strict_npm_ok(node: &NodePair, call: &Call) -> bool {
        call.program == node.node.to_string_lossy().as_ref()
            && !call.program.ends_with(".js")
            && call.args.first().map(String::as_str)
                == Some(node.npm_cli.to_string_lossy().as_ref())
            && call.args.get(1).map(String::as_str) == Some("install")
    }

    /// Falla si npm no cumple el contrato (`.js` ejecutable, verbo ausente, par desajustado).
    fn expect_strict_npm(node: &NodePair, call: &Call) {
        assert!(
            strict_npm_ok(node, call),
            "comando npm incorrecto: program={:?} args={:?}",
            call.program,
            call.args
        );
    }

    /// Ejecutor que simula una instalación correcta: crea el binario nativo al
    /// recibir la llamada de npm y devuelve versiones válidas.
    fn healthy_runner(platform: Platform, node: NodePair) -> FakeRunner {
        let node_prog = node.node.to_string_lossy().into_owned();
        FakeRunner::new(move |call| {
            if is_npm_call(&node, call) {
                expect_strict_npm(&node, call);
                let stage = arg_value(&call.args, "--prefix").expect("npm sin --prefix");
                let exe = native_exe_candidates(platform, Path::new(&stage))[0].clone();
                std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
                std::fs::write(&exe, b"fake").unwrap();
                return ok_out("added 1 package\n");
            }
            if call.program == node_prog {
                if call.args == ["--version"] {
                    return ok_out("v22.20.0\n");
                }
                if call.args == ["-p", "process.arch"] {
                    return ok_out(&format!("{}\n", arch_of(platform)));
                }
            }
            if call.program.ends_with(CODEX_BIN_NAME) {
                return ok_out("codex-cli 0.162.1\n");
            }
            Err(RunError::Spawn)
        })
    }

    /// Ejecutor que responde a las pruebas de Node pero no instala nada.
    fn node_only_runner(node: &NodePair) -> FakeRunner {
        let node_prog = node.node.to_string_lossy().into_owned();
        let owned = node.clone();
        FakeRunner::new(move |call| {
            if is_npm_call(&owned, call) {
                expect_strict_npm(&owned, call);
                return ok_out("added 1 package\n");
            }
            if call.program == node_prog {
                if call.args == ["--version"] {
                    return ok_out("v22.1.0\n");
                }
                if call.args == ["-p", "process.arch"] {
                    return ok_out("x64\n");
                }
            }
            Err(RunError::Spawn)
        })
    }

    /// Ejecutor con versión y arquitectura de Node fijadas (para probar desajustes).
    fn node_runner_with(node: &NodePair, version: &str, arch: &str) -> FakeRunner {
        let node_prog = node.node.to_string_lossy().into_owned();
        let owned = node.clone();
        let version = version.to_string();
        let arch = arch.to_string();
        FakeRunner::new(move |call| {
            if is_npm_call(&owned, call) {
                expect_strict_npm(&owned, call);
                return ok_out("added 1 package\n");
            }
            if call.program == node_prog {
                if call.args == ["--version"] {
                    return ok_out(&format!("{version}\n"));
                }
                if call.args == ["-p", "process.arch"] {
                    return ok_out(&format!("{arch}\n"));
                }
            }
            Err(RunError::Spawn)
        })
    }

    /// ¿Queda alguna carpeta de stage sin limpiar?
    fn stage_leftovers(root: &Path) -> bool {
        std::fs::read_dir(root)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().contains("stage"))
            })
            .unwrap_or(false)
    }

    // ── pruebas ──

    #[test]
    fn only_the_settings_window_may_install() {
        assert!(settings_window_ok("settings"));
        assert!(!settings_window_ok("widget"));
        assert!(!settings_window_ok("overlay"));
        assert!(!settings_window_ok(""));
    }

    #[test]
    fn support_is_windows_x64_or_arm64_only() {
        assert!(Platform::WindowsX64.supported());
        assert!(Platform::WindowsArm64.supported());
        assert!(!Platform::Other.supported());
        #[cfg(not(windows))]
        assert!(!Platform::current().supported());
    }

    #[test]
    fn consent_prompt_explains_package_registry_folder_node_and_scope() {
        for needle in [
            "@openai/codex@0.162.1",
            "registry.npmjs.org",
            "Node.js 22",
            ".quorb/tools/codex-0.162.1",
            "PATH",
            "elevación",
            "credenciales",
        ] {
            let message = crate::i18n::text(
                crate::i18n::Locale::Es,
                crate::i18n::Msg::CodexConsentMessage,
            );
            assert!(message.contains(needle), "falta «{needle}»");
        }
    }

    #[test]
    fn node_discovery_requires_the_paired_node_and_npm_files() {
        let (dir, pair) = fake_node("discover");
        assert_eq!(
            discover_node_in(&[dir.path().to_path_buf()]),
            Some(pair.clone())
        );
        std::fs::remove_file(&pair.npm_cli).unwrap();
        assert_eq!(discover_node_in(&[dir.path().to_path_buf()]), None);
        std::fs::write(&pair.npm_cli, b"").unwrap();
        std::fs::remove_file(&pair.node).unwrap();
        assert_eq!(discover_node_in(&[dir.path().to_path_buf()]), None);
        assert_eq!(discover_node_in(&[dir.path().join("inexistente")]), None);
    }

    #[test]
    fn declining_the_prompt_cancels_without_processes_or_files() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("decline");
        let root = TempDir::new("decline-root");
        let runner = healthy_runner(Platform::WindowsX64, node.clone());
        let result = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| false,
        )
        .unwrap();
        assert_eq!(result.outcome, InstallOutcome::Cancelled);
        assert!(runner.calls().is_empty(), "no debe lanzarse ningún proceso");
        assert!(!state.busy());
        assert_eq!(
            state.last().map(|l| l.outcome),
            Some(CodexOutcome::Cancelled)
        );
        assert!(!canonical_prefix(root.path()).exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn concurrent_install_is_rejected_before_the_prompt_and_the_guard_releases() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("busy");
        let root = TempDir::new("busy-root");
        let runner = healthy_runner(Platform::WindowsX64, node.clone());

        let guard = state.begin().expect("primera reserva");
        let prompted = AtomicBool::new(false);
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| {
                prompted.store(true, Ordering::SeqCst);
                true
            },
        )
        .unwrap_err();
        assert_eq!(err, MSG_BUSY);
        assert!(
            !prompted.load(Ordering::SeqCst),
            "no debe mostrarse el diálogo"
        );
        assert!(runner.calls().is_empty());
        assert!(state.busy());

        drop(guard);
        assert!(!state.busy(), "el guardia debe liberarse");
        let result = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| false,
        )
        .unwrap();
        assert_eq!(result.outcome, InstallOutcome::Cancelled);
        assert!(!state.busy());
    }

    #[test]
    fn npm_install_args_are_fixed_and_never_take_user_input() {
        let stage = Path::new("C:/quorb/tools/codex-stage");
        let args = npm_install_args(stage);
        assert_eq!(
            args,
            vec![
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--include=optional",
                "--bin-links=true",
                "--registry",
                NPM_REGISTRY,
                "--prefix",
                "C:/quorb/tools/codex-stage",
                "-g",
                CODEX_PACKAGE,
            ]
        );
        assert!(args.contains(&"--ignore-scripts".to_string()));
        assert!(args.iter().any(|a| a == CODEX_PACKAGE));
    }

    #[test]
    fn child_env_keeps_only_the_windows_runtime_and_drops_injection_and_secrets() {
        let mut base = BTreeMap::new();
        base.insert("SystemRoot".into(), "C:\\Windows".into());
        base.insert("PATH".into(), "C:\\Windows\\System32".into());
        base.insert("TEMP".into(), "C:\\Temp".into());
        base.insert("NODE_OPTIONS".into(), "--require evil".into());
        base.insert("npm_config_prefix".into(), "C:\\global".into());
        base.insert("GITHUB_TOKEN".into(), "secret".into());
        base.insert("HTTPS_PROXY".into(), "http://proxy".into());
        base.insert("NODE_TLS_REJECT_UNAUTHORIZED".into(), "0".into());
        let env = child_env(
            Platform::WindowsX64,
            &base,
            Path::new("/quorb/node"),
            Path::new("/quorb/stage"),
        );
        assert_eq!(
            env.get("SystemRoot").map(String::as_str),
            Some("C:\\Windows")
        );
        assert!(env
            .get("PATH")
            .unwrap()
            .to_lowercase()
            .contains("/quorb/node"));
        for forbidden in [
            "NODE_OPTIONS",
            "npm_config_prefix",
            "GITHUB_TOKEN",
            "HTTPS_PROXY",
            "NODE_TLS_REJECT_UNAUTHORIZED",
        ] {
            assert!(
                !env.keys().any(|k| k.eq_ignore_ascii_case(forbidden)),
                "no debe heredarse {forbidden}"
            );
        }
        let user = env.get("NPM_CONFIG_USERCONFIG").unwrap();
        let global = env.get("NPM_CONFIG_GLOBALCONFIG").unwrap();
        assert_ne!(user, global);
        assert!(Path::new(user).starts_with("/quorb/stage"));
        assert!(Path::new(global).starts_with("/quorb/stage"));
        assert!(env
            .get("NPM_CONFIG_CACHE")
            .unwrap()
            .starts_with("/quorb/stage"));
    }

    #[test]
    fn install_without_node_fails_with_a_clear_message_and_no_process() {
        let state = CodexSetupState::default();
        let root = TempDir::new("no-node");
        let runner = FakeRunner::new(|_| ok_out(""));
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            None,
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err, MSG_NO_NODE);
        assert!(runner.calls().is_empty());
    }

    #[test]
    fn unsupported_platform_is_refused_before_the_prompt() {
        let state = CodexSetupState::default();
        let root = TempDir::new("unsupported");
        let runner = FakeRunner::new(|_| ok_out(""));
        let prompted = AtomicBool::new(false);
        let err = install_codex_flow(
            &state,
            Platform::Other,
            None,
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| {
                prompted.store(true, Ordering::SeqCst);
                true
            },
        )
        .unwrap_err();
        assert_eq!(err, MSG_UNSUPPORTED);
        assert!(!prompted.load(Ordering::SeqCst));
    }

    #[test]
    fn old_node_fails_and_cleans_up() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("old-node");
        let root = TempDir::new("old-node-root");
        let node_prog = node.node.to_string_lossy().into_owned();
        let runner = FakeRunner::new(move |call| {
            if call.program == node_prog && call.args == ["--version"] {
                return ok_out("v20.11.0\n");
            }
            Err(RunError::Spawn)
        });
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err, MSG_NODE_OLD);
        assert!(!stage_leftovers(root.path()));
    }

    #[test]
    fn npm_exit_zero_without_the_native_binary_fails_and_cleans_the_stage() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("missing-native");
        let root = TempDir::new("missing-native-root");
        let runner = node_only_runner(&node);
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err, MSG_GENERIC_ERROR);
        assert_eq!(state.last().map(|l| l.outcome), Some(CodexOutcome::Failed));
        assert!(!canonical_prefix(root.path()).exists());
        assert!(!stage_leftovers(root.path()));
    }

    #[test]
    fn npm_failure_fails_and_cleans_the_stage() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("npm-fail");
        let root = TempDir::new("npm-fail-root");
        let node_prog = node.node.to_string_lossy().into_owned();
        let runner_node = node.clone();
        let runner = FakeRunner::new(move |call| {
            if is_npm_call(&runner_node, call) {
                expect_strict_npm(&runner_node, call);
                return Ok(CommandOutput {
                    code: 1,
                    stdout: String::new(),
                    stderr: "npm ERR! leaked-internal-token".into(),
                });
            }
            if call.program == node_prog {
                if call.args == ["--version"] {
                    return ok_out("v22.1.0\n");
                }
                if call.args == ["-p", "process.arch"] {
                    return ok_out("x64\n");
                }
            }
            Err(RunError::Spawn)
        });
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err, MSG_GENERIC_ERROR);
        assert!(!err.contains("leaked-internal-token"), "sin volcar stderr");
        assert!(!stage_leftovers(root.path()));
    }

    #[test]
    fn npm_timeout_fails_and_cleans_the_stage() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("npm-timeout");
        let root = TempDir::new("npm-timeout-root");
        let node_prog = node.node.to_string_lossy().into_owned();
        let runner_node = node.clone();
        let runner = FakeRunner::new(move |call| {
            if is_npm_call(&runner_node, call) {
                expect_strict_npm(&runner_node, call);
                return Err(RunError::Timeout);
            }
            if call.program == node_prog {
                if call.args == ["--version"] {
                    return ok_out("v22.1.0\n");
                }
                if call.args == ["-p", "process.arch"] {
                    return ok_out("x64\n");
                }
            }
            Err(RunError::Spawn)
        });
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err, MSG_GENERIC_ERROR);
        assert!(!stage_leftovers(root.path()));
    }

    #[test]
    fn promotion_refuses_to_overwrite_an_existing_install() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("overwrite");
        let root = TempDir::new("overwrite-root");
        let prefix = canonical_prefix(root.path());
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(prefix.join("keep.txt"), b"original").unwrap();
        let runner = healthy_runner(Platform::WindowsX64, node.clone());
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err, MSG_ALREADY_INSTALLED);
        assert_eq!(
            std::fs::read_to_string(prefix.join("keep.txt")).unwrap(),
            "original"
        );
        assert!(
            runner.calls().is_empty(),
            "no debe ejecutarse npm si ya está"
        );
        assert!(!stage_leftovers(root.path()));
    }

    #[test]
    fn happy_path_installs_verifies_and_promotes_atomically() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("happy");
        let root = TempDir::new("happy-root");
        let runner = healthy_runner(Platform::WindowsX64, node.clone());
        let result = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap();
        assert_eq!(result.outcome, InstallOutcome::Installed);
        let prefix = canonical_prefix(root.path());
        let exe = resolve_native_exe(Platform::WindowsX64, &prefix).expect("binario promovido");
        assert!(exe.is_file());
        assert!(!stage_leftovers(root.path()), "el stage debe desaparecer");
        assert_eq!(
            state.last().map(|l| l.outcome),
            Some(CodexOutcome::Installed)
        );
        assert!(!state.busy());
        assert!(!runner.programs().iter().any(|p| p.ends_with(".cmd")));
        // El binario verificado es el del alias nativo, no un wrapper.
        assert!(runner
            .programs()
            .iter()
            .any(|p| p.ends_with(CODEX_BIN_NAME)));
    }

    #[test]
    fn native_version_mismatch_fails_and_is_not_promoted() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("version-mismatch");
        let root = TempDir::new("version-mismatch-root");
        let node_prog = node.node.to_string_lossy().into_owned();
        let platform = Platform::WindowsX64;
        let runner_node = node.clone();
        let runner = FakeRunner::new(move |call| {
            if call.program == node_prog {
                if call.args == ["--version"] {
                    return ok_out("v22.1.0\n");
                }
                if call.args == ["-p", "process.arch"] {
                    return ok_out("x64\n");
                }
            }
            if is_npm_call(&runner_node, call) {
                expect_strict_npm(&runner_node, call);
                let stage = arg_value(&call.args, "--prefix").unwrap();
                let exe = native_exe_candidates(platform, Path::new(&stage))[0].clone();
                std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
                std::fs::write(&exe, b"fake").unwrap();
                return ok_out("added 1 package\n");
            }
            if call.program.ends_with(CODEX_BIN_NAME) {
                return ok_out("codex-cli 0.161.0\n");
            }
            Err(RunError::Spawn)
        });
        let err = install_codex_flow(
            &state,
            platform,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        assert_eq!(err, MSG_GENERIC_ERROR);
        assert!(!canonical_prefix(root.path()).exists());
        assert!(!stage_leftovers(root.path()));
    }

    #[test]
    fn node_arch_matches_x64_and_proceeds_to_npm() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("arch-x64-ok");
        let root = TempDir::new("arch-x64-ok-root");
        let runner = node_runner_with(&node, "v22.20.0", "x64");
        let err = install_codex_flow(
            &state,
            Platform::WindowsX64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap_err();
        // Llega hasta npm (falla por el binario nativo ausente), señal de que x64 pasa el filtro.
        assert_eq!(err, MSG_GENERIC_ERROR);
        assert!(runner.calls().iter().any(|c| is_npm_call(&node, c)));
    }

    #[test]
    fn node_arch_mismatch_is_refused_before_npm_and_releases_busy() {
        for arch in ["arm64", "ia32"] {
            let state = CodexSetupState::default();
            let (_node_dir, node) = fake_node(&format!("arch-{arch}"));
            let root = TempDir::new(&format!("arch-{arch}-root"));
            let runner = node_runner_with(&node, "v22.20.0", arch);
            let err = install_codex_flow(
                &state,
                Platform::WindowsX64,
                Some(&node),
                root.path(),
                &BTreeMap::new(),
                &runner,
                &|| true,
            )
            .unwrap_err();
            assert_eq!(err, MSG_NODE_OLD, "arch {arch} debe rechazarse");
            assert!(
                !runner.calls().iter().any(|c| is_npm_call(&node, c)),
                "npm no debe ejecutarse con arch {arch}"
            );
            assert!(!canonical_prefix(root.path()).exists());
            assert!(!stage_leftovers(root.path()));
            assert!(!state.busy(), "el guardia debe liberarse con arch {arch}");
            assert_eq!(state.last().map(|l| l.outcome), Some(CodexOutcome::Failed));
        }
    }

    #[test]
    fn node_arch_arm64_matches_the_arm64_platform() {
        let state = CodexSetupState::default();
        let (_node_dir, node) = fake_node("arch-arm-ok");
        let root = TempDir::new("arch-arm-ok-root");
        let runner = healthy_runner(Platform::WindowsArm64, node.clone());
        let result = install_codex_flow(
            &state,
            Platform::WindowsArm64,
            Some(&node),
            root.path(),
            &BTreeMap::new(),
            &runner,
            &|| true,
        )
        .unwrap();
        assert_eq!(result.outcome, InstallOutcome::Installed);
        assert!(
            resolve_native_exe(Platform::WindowsArm64, &canonical_prefix(root.path())).is_some()
        );
    }

    #[test]
    fn native_binary_is_looked_up_in_both_known_alias_parents() {
        let root = TempDir::new("layouts");
        let layout = root.path().join(
            "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        );
        std::fs::create_dir_all(layout.parent().unwrap()).unwrap();
        std::fs::write(&layout, b"").unwrap();
        assert_eq!(
            resolve_native_exe(Platform::WindowsX64, root.path()),
            Some(layout.clone())
        );
        let arm = root
            .path()
            .join("node_modules/@openai/codex-win32-arm64/codex.exe");
        std::fs::create_dir_all(arm.parent().unwrap()).unwrap();
        std::fs::write(&arm, b"").unwrap();
        assert_eq!(
            resolve_native_exe(Platform::WindowsArm64, root.path()),
            Some(arm)
        );
    }

    #[test]
    fn percent_expansion_resolves_only_referenced_names() {
        let lookup = |name: &str| match name.to_ascii_uppercase().as_str() {
            "SYSTEMROOT" => Some("C:\\Windows".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_percent("%SystemRoot%\\System32;%MISSING%\\x", &lookup),
            "C:\\Windows\\System32;%MISSING%\\x"
        );
        assert_eq!(expand_percent("sin variables", &lookup), "sin variables");
        // La expansión es de una sola pasada: acotada y sin bucles.
        let nested = |name: &str| match name.to_ascii_uppercase().as_str() {
            "A" => Some("%B%".to_string()),
            "B" => Some("%A%".to_string()),
            _ => None,
        };
        assert_eq!(expand_percent("%A%", &nested), "%B%");
    }

    #[test]
    fn managed_native_dirs_cover_both_aliases_and_layouts() {
        let home = Path::new("C:\\Users\\ana");
        let dirs = managed_native_dirs(home);
        let s: Vec<String> = dirs
            .iter()
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .collect();
        let root = crate::channel::current().home_dir;
        assert!(s.iter().any(|d| d.contains(&format!(
            "{root}/tools/codex-0.162.1/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64"
        ))));
        assert!(s.iter().any(|d| {
            d.contains(&format!(
                "{root}/tools/codex-0.162.1/node_modules/@openai/codex-win32-arm64"
            ))
        }));
        assert!(consent_message(crate::i18n::Locale::Es).contains(&format!("~/{root}/tools/")));
        assert!(s.iter().any(|d| d.contains("x86_64-pc-windows-msvc")));
        assert!(s.iter().any(|d| d.contains("aarch64-pc-windows-msvc")));
    }

    #[test]
    fn installed_flag_is_metadata_not_login_health() {
        let root = TempDir::new("installed");
        let prefix = canonical_prefix(root.path());
        assert!(!codex_installed_in(
            Platform::WindowsX64,
            root.path(),
            false
        ));
        let exe = native_exe_candidates(Platform::WindowsX64, &prefix)[0].clone();
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert!(codex_installed_in(Platform::WindowsX64, root.path(), false));
        assert!(codex_installed_in(Platform::WindowsX64, root.path(), true));
    }

    #[test]
    fn npm_command_is_node_plus_paired_script_plus_install_verb() {
        let node = NodePair {
            node: PathBuf::from("C:/node/node.exe"),
            npm_cli: PathBuf::from("C:/node/node_modules/npm/bin/npm-cli.js"),
        };
        let (program, args) = npm_command(&node, Path::new("C:/stage"));
        assert_eq!(program, node.node, "el programa es node.exe, nunca el .js");
        assert_eq!(args[0], node.npm_cli.to_string_lossy().as_ref());
        assert_eq!(args[1], "install", "verbo install explícito");
        assert_eq!(
            &args[2..],
            npm_install_args(Path::new("C:/stage")).as_slice()
        );
    }

    /// Node real del proyecto (por `QUORB_TEST_NODE_EXECUTABLE` o PATH); nunca se
    /// lee su versión ni se ejecutan probes de npm/Codex.
    fn test_node_executable() -> Option<PathBuf> {
        if let Some(explicit) = std::env::var_os("QUORB_TEST_NODE_EXECUTABLE") {
            let explicit = PathBuf::from(explicit);
            if explicit.is_file() {
                return Some(explicit);
            }
        }
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .flat_map(|dir| ["node", "node.exe"].map(|name| dir.join(name)))
            .find(|candidate| candidate.is_file())
    }

    /// Fixture real: `ProcessRunner` lanza node con un JS dummy emparejado y
    /// observa el argv. El script (nombre con espacios) solo imprime sus args.
    #[cfg(unix)]
    #[test]
    fn real_runner_launches_node_with_the_paired_script_and_install_verb() {
        let node_exe = test_node_executable()
            .expect("Node real no encontrado (QUORB_TEST_NODE_EXECUTABLE o PATH)");
        let dir = TempDir::new("real-node-argv");
        let script = dir.path().join("npm cli dummy.js");
        std::fs::write(
            &script,
            "process.stdout.write(process.argv.slice(2).join(\"|\"));\n",
        )
        .unwrap();
        let node = NodePair {
            node: node_exe,
            npm_cli: script,
        };
        let stage = dir.path().join("stage with space");
        std::fs::create_dir_all(&stage).unwrap();
        let (program, args) = npm_command(&node, &stage);
        let mut env = BTreeMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".into(), path);
        }
        let out = ProcessRunner
            .run(&program, &args, &env, &stage, Duration::from_secs(10))
            .expect("node debe lanzar el script emparejado");
        assert_eq!(out.code, 0);
        let observed: Vec<&str> = out.stdout.split('|').collect();
        let expected: Vec<&str> = args[1..].iter().map(String::as_str).collect();
        assert_eq!(observed, expected, "argv observado por el JS dummy");
        assert_eq!(observed[0], "install");
    }
}
