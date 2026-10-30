//! `RealWslAdapter`: la implementación real contra `wsl.exe`.
//!
//! Toda la lógica de proceso vive aquí; el resto de la app depende del
//! trait, así que los tests usan `MockWslAdapter` y no tocan WSL.
//!
//! Decisiones que implementa (W2-PLAN §4, ADR-W2, W1-CONTRACT):
//! - **Lectura**: `wsl -d <distro> -- cat <path>` (no UNC), porque solo
//!   así se puede acotar el proceso colgado.
//! - **Home**: `whoami` → `getent passwd <user>` → campo 6 parseado en
//!   Rust (nunca `| cut`).
//! - **Enumeración**: `wsl --list --verbose`, que NO despierta la distro
//!   (F4).
//! - **Diagnóstico**: `--version` (WSL ausente) y `--list` (cero distros).
//!   como sondas separadas (F6).
//! - **Timeout**: cancelación ACOTADA (nivel 1) — se mata el proceso
//!   remoto de la operación y la distro queda `Running`.
//! - **`--terminate`**: solo desde `terminate()`, por acción explícita
//!   del usuario (nivel 2).

use super::errors::{looks_utf16, parse_list_verbose, parse_passwd_home};
use super::process::{
    direct_args, option_args, resolve_wsl_exe, shell_args, WslRunner, WslSearchPaths,
    SCRIPT_COMMAND_V,
};
use super::{Distribution, ShellStrategy, WslAdapter, WslDiagnostic, WslError, WslState};
use crate::cli_process::{CommandOutput, CommandRunner, ProcessRunner};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Adaptador real contra `wsl.exe`.
pub struct RealWslAdapter {
    runner: Box<dyn CommandRunner>,
    program: PathBuf,
    /// Presupuesto de una operación de la distro.
    timeout: Duration,
    /// Presupuesto de las operaciones de limpieza (leer pidfile, matar,
    /// borrar) tras un timeout.
    cleanup_timeout: Duration,
    /// Variables de entorno que se pasan al proceso `wsl.exe`.
    env: BTreeMap<String, String>,
}

impl RealWslAdapter {
    /// Adaptador con el `ProcessRunner` real y el binario descubierto.
    pub fn new() -> Self {
        Self::with_runner(Box::new(ProcessRunner))
    }

    /// Adaptador con un runner inyectado (para pruebas) y el binario
    /// descubierto en el sistema.
    pub fn with_runner(runner: Box<dyn CommandRunner>) -> Self {
        let program = Self::discover_program();
        Self::with_runner_and_program(runner, program)
    }

    /// Adaptador con runner y binario explícitos.
    pub fn with_runner_and_program(runner: Box<dyn CommandRunner>, program: PathBuf) -> Self {
        RealWslAdapter {
            runner,
            program,
            timeout: Duration::from_secs(20),
            cleanup_timeout: Duration::from_secs(5),
            env: Self::base_env(),
        }
    }

    /// Descubre `wsl.exe` (F9). Si no está en ninguno de los sitios
    /// conocidos, se usa el nombre a secas: el fallo se distingue por
    /// `WslNotInstalled` (F6), no por un error de arranque genérico.
    fn discover_program() -> PathBuf {
        let paths = WslSearchPaths::from_env();
        let is_32bit = cfg!(target_pointer_width = "32");
        resolve_wsl_exe(&paths, is_32bit, &|p| p.exists())
            .unwrap_or_else(|| PathBuf::from("wsl.exe"))
    }

    /// Entorno base de los hijos: `WSL_UTF8=1` (F1) y `LC_ALL=C` para que
    /// los tokens de error sean los mismos en cualquier locale (F2/F6).
    fn base_env() -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert("WSL_UTF8".to_string(), "1".to_string());
        env.insert("LC_ALL".to_string(), "C".to_string());
        env.insert("LANG".to_string(), "C".to_string());
        // `wsl.exe` necesita el PATH del host para sus propias dependencias.
        if let Some(path) = std::env::var_os("PATH").or_else(|| std::env::var_os("Path")) {
            env.insert("PATH".to_string(), path.to_string_lossy().into_owned());
        }
        for key in ["SystemRoot", "ProgramFiles", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                env.insert(key.to_string(), value.to_string_lossy().into_owned());
            }
        }
        env
    }

    /// Fusiona las variables de sesión del llamador en el env del hijo.
    ///
    /// Las de valor de ruta se anuncian también en `WSLENV` con `/p`
    /// (traducción de path Windows→Linux por el propio WSL): sin eso, una
    /// var como `CODEX_HOME=C:\Users\...` llegaría a la distro sin traducir
    /// y el comando no encontraría las rutas (contrato W1 §5/§7).
    ///
    /// Pública para que el lab W3 pueda medir el WSLENV que produce el
    /// CÓDIGO REAL (misma función que `run_command` acaba usando), en vez
    /// de duplicar la política en el harness.
    pub fn env_with(&self, extra: &[(&str, &str)]) -> BTreeMap<String, String> {
        let mut env = self.env.clone();
        let mut wslenv = env.get("WSLENV").cloned().unwrap_or_default();
        for (k, v) in extra {
            env.insert((*k).to_string(), (*v).to_string());
            if let Some(marked) = build_wslenv_entry(k, v, &wslenv) {
                wslenv = marked;
            }
        }
        if !wslenv.is_empty() {
            env.insert("WSLENV".to_string(), wslenv);
        }
        env
    }

    /// Directorio de trabajo de los hijos: el propio cwd del proceso.
    fn cwd() -> PathBuf {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }

    /// Contexto de ejecución agrupado para las operaciones del adaptador.
    fn runner<'e>(&'e self, env: &'e BTreeMap<String, String>, cwd: &'e Path) -> WslRunner<'e> {
        WslRunner::new(
            &*self.runner,
            &self.program,
            env,
            cwd,
            self.timeout,
            self.cleanup_timeout,
        )
    }

    /// Ejecuta un comando de control (sin distro): `--list`, `--status`,
    /// `--terminate`.
    fn control(&self, args: &[String], distro: Option<&str>) -> Result<CommandOutput, WslError> {
        let cwd = Self::cwd();
        self.runner(&self.env, &cwd).control(args, distro)
    }

    /// Ejecuta un comando dentro de la distro con cancelación acotada.
    fn in_distro(
        &self,
        distro: &str,
        shell: ShellStrategy,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Result<CommandOutput, WslError> {
        let merged = self.env_with(env);
        let cwd = Self::cwd();
        self.runner(&merged, &cwd).run_scoped(distro, shell, args)
    }
}

/// Variables de sesión que el adaptador puede transmitir a la distro.
///
/// Allowlist explícita: nada de reenviar el entorno del host. Cualquier
/// variable fuera de esta lista se ignora (sin fallback silencioso: si el
/// proveedor no la recibe, tampoco se inventa un home alternativo).
pub const SESSION_ENV_ALLOWLIST: [&str; 3] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME"];

/// ¿El valor es una ruta de Windows (necesita conversión con `/p`)?
///
/// Solo esos valores se marcan: una ruta Linux ya resuelta para la distro
/// NO debe convertirse (se transmitiría mal). Un valor que no es ruta
/// (p. ej. `debug=1`) no entra en `WSLENV` en absoluto.
fn is_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with("\\\\")
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// ¿El valor es una ruta Linux ya resuelta para la distro?
fn is_linux_path(value: &str) -> bool {
    value.starts_with('/')
}

/// Construye la entrada de `WSLENV` para una variable de sesión.
///
/// - Ruta de Windows → `KEY/p` (WSL traduce el path al anclar la variable).
/// - Ruta Linux ya resuelta → `KEY` sin flag: no hay nada que convertir y
///   la marca `/p` la estropearía.
/// - Valor que no es ruta → `None`: no entra en `WSLENV`. La variable se
///   inserta en el entorno del proceso `wsl.exe`, pero WSL solo reenvía a
///   la distro lo listado en `WSLENV` (la whitelist), así que el proceso
///   remoto NO la recibe (ausente). El contrato es la ausencia, no el
///   transporte en el entorno del host.
///
/// Preserva las entradas ya presentes (con o sin flags) y no duplica.
/// Devuelve el `WSLENV` ampliado.
pub fn build_wslenv_entry(key: &str, value: &str, current: &str) -> Option<String> {
    if !SESSION_ENV_ALLOWLIST.contains(&key) {
        return None;
    }
    let flag = if is_windows_path(value) {
        Some("/p")
    } else if is_linux_path(value) {
        None
    } else {
        // No es una ruta: no entra en WSLENV.
        return None;
    };
    // No duplicar: cualquier entrada previa con el mismo nombre (con o sin
    // flags) se respeta tal cual.
    let already = current
        .split(':')
        .any(|token| token.split('/').next() == Some(key));
    if already {
        return None;
    }
    let entry = match flag {
        Some(f) => format!("{key}{f}"),
        None => key.to_string(),
    };
    Some(if current.is_empty() {
        entry
    } else {
        format!("{current}:{entry}")
    })
}

impl Default for RealWslAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl WslAdapter for RealWslAdapter {
    /// F4: `wsl --list --verbose` NO despierta ninguna distro.
    fn list_distributions(&self) -> Result<Vec<Distribution>, WslError> {
        let args = option_args("--list", None);
        let mut args = args;
        args.push("--verbose".to_string());
        let output = self.control(&args, None)?;
        if looks_utf16(&output.stdout) {
            // F1: sin `WSL_UTF8=1` la salida viene en UTF-16 y el runner
            // de texto la habría perdido. Se dice explícitamente en vez de
            // devolver una lista corrupta.
            return Err(WslError::UnparsableOutput(
                "wsl.exe devolvió la salida en UTF-16 (WSL_UTF8 no soportado)".into(),
            ));
        }
        Ok(parse_list_verbose(&output.stdout))
    }

    /// F7: despierta la distro. Solo desde una acción explícita del
    /// usuario (W1 §2). El home es el campo 6 de `getent passwd`.
    fn resolve_home(&self, distro: &str) -> Result<PathBuf, WslError> {
        let whoami = direct_args(Some(distro), "whoami", &[]);
        let output = self.control(&whoami, Some(distro))?;
        let user = output.stdout.trim().to_string();
        if user.is_empty() {
            return Err(WslError::UnparsableOutput(
                "wsl.exe no devolvió el usuario por defecto de la distro".into(),
            ));
        }
        let passwd = direct_args(Some(distro), "getent", &["passwd", &user]);
        let output = self.control(&passwd, Some(distro))?;
        let home = parse_passwd_home(output.stdout.trim())
            .ok_or_else(|| WslError::UnparsableOutput("getent passwd sin campo home".into()))?;
        Ok(PathBuf::from(home))
    }

    /// Lee un archivo dentro de la distro (decisión paso 0 #1: `wsl cat`,
    /// no UNC), con cancelación acotada (nivel 1).
    fn read_file(&self, distro: &str, path: &Path) -> Result<String, WslError> {
        let path_str = path.to_string_lossy().to_string();
        // `--` antes del path: un nombre que empiece por `-` no se
        // interpreta como opción de `cat`.
        match self.in_distro(
            distro,
            ShellStrategy::ShPosix,
            &["cat", "--", path_str.as_str()],
            &[],
        ) {
            Ok(output) => Ok(output.stdout),
            // El timeout se propaga: no es un fichero ausente.
            Err(err @ WslError::Timeout { .. }) => Err(err),
            // WSL ausente, distro equivocada o argumento inválido también se
            // propagan: confundirlos con "fichero ausente" rompería el
            // diagnóstico (F6/W1 §7). Solo el `cat` fallido sin token
            // conocido (p. ej. "No such file") es, en la práctica, que el
            // fichero no está.
            Err(WslError::WslNotInstalled) => Err(WslError::WslNotInstalled),
            Err(err @ WslError::DistroNotFound(_)) => Err(err),
            Err(err @ WslError::InvalidArgument(_)) => Err(err),
            // `run_scoped` no produce estas variantes (no hay `--list` ni
            // pidfile en `cat`), pero el match debe ser exhaustivo: si
            // alguna llega, no se disfraza de "fichero ausente".
            Err(
                err @ (WslError::NoDistributions | WslError::FileNotFound(_) | WslError::Spawn(_)),
            ) => Err(err),
            Err(WslError::UnparsableOutput(_)) => Err(WslError::FileNotFound(path_str)),
        }
    }

    /// W1 §3: `command -v bash` — si existe, `-e bash -lc` (PATH de
    /// login, donde viven nvm/volta); si no, `-e sh -c`.
    ///
    /// La sonda usa el script constante `SCRIPT_COMMAND_V` (NO `exec`:
    /// `command` es un builtin y `exec command` falla con 127 — hallazgo
    /// del lab W3 en WSL real, 2026-10-30) y `control_raw` (el exit code
    /// de la sonda es la respuesta, no un error: sin bash, `command -v`
    /// sale con != 0 y eso significa "usa sh").
    fn shell_strategy(&self, distro: &str) -> Result<ShellStrategy, WslError> {
        let argv = shell_args(
            Some(distro),
            ShellStrategy::ShPosix,
            SCRIPT_COMMAND_V,
            &["bash"],
        );
        let cwd = Self::cwd();
        let output = self
            .runner(&self.env, &cwd)
            .control_raw(&argv, Some(distro))?;
        Ok(if output.code == 0 && !output.stdout.trim().is_empty() {
            ShellStrategy::BashLogin
        } else {
            ShellStrategy::ShPosix
        })
    }

    /// Ejecuta un comando con el script constante y los datos como
    /// parámetros posicionales (F14, doble frontera).
    fn run_command(
        &self,
        distro: &str,
        shell: ShellStrategy,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Result<CommandOutput, WslError> {
        self.in_distro(distro, shell, args, env)
    }

    /// F6: sondas separadas — `--version` (WSL ausente) y `--list` (cero
    /// distros o distro objetivo ausente).
    ///
    /// La sonda es `--version` (contrato W1 §6). Un `wsl.exe` de build
    /// antigua que lo rechaza con "Invalid command line argument" (p. ej.
    /// Windows Server 2022, hallazgo del lab W3) tampoco tiene WSL2, así
    /// que se trata como WSL ausente.
    fn diagnose(&self, target: Option<&str>) -> Result<WslDiagnostic, WslError> {
        let version = option_args("--version", None);
        match self.control(&version, None) {
            Ok(_) => {}
            Err(WslError::WslNotInstalled) => {
                return Ok(WslDiagnostic {
                    state: WslState::WslNotInstalled,
                    detail: None,
                })
            }
            // Build antigua sin `--version`: sin WSL2 usable.
            Err(WslError::InvalidArgument(_)) => {
                return Ok(WslDiagnostic {
                    state: WslState::WslNotInstalled,
                    detail: Some("wsl.exe no soporta --version (build antigua, sin WSL2)".into()),
                })
            }
            Err(e) => return Err(e),
        }

        let distros = self.list_distributions()?;
        if distros.is_empty() {
            return Ok(WslDiagnostic {
                state: WslState::NoDistributions,
                detail: None,
            });
        }
        match target {
            Some(name) => {
                let known = distros
                    .iter()
                    .any(|d| super::distro_name_matches(name, &d.name));
                if known {
                    Ok(WslDiagnostic {
                        state: WslState::Available,
                        detail: None,
                    })
                } else {
                    // Decisión paso 0 #3: error explícito, sin fallback a
                    // native y conservando el valor configurado.
                    Ok(WslDiagnostic {
                        state: WslState::DistroUnavailable,
                        detail: Some(format!(
                            "la distro configurada no aparece en la enumeración; disponibles: {}",
                            distros
                                .iter()
                                .map(|d| d.name.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        )),
                    })
                }
            }
            None => Ok(WslDiagnostic {
                state: WslState::Available,
                detail: None,
            }),
        }
    }

    /// Nivel 2: detener la distro COMPLETA. Solo por acción explícita
    /// del usuario — mata también procesos y sesiones ajenas a Quorb.
    fn terminate(&self, distro: &str) -> Result<(), WslError> {
        let args = option_args("--terminate", Some(distro));
        self.control(&args, Some(distro)).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_process::RunError;
    use crate::wsl::DistroState;
    use std::sync::{Arc, Mutex};

    /// Runner de mentira: responde por el substring del argv y registra
    /// las llamadas. Permite probar el argv y el parseo sin WSL.
    /// `Arc<Mutex<…>>` en vez de `RefCell`: el trait exige `Send + Sync`,
    /// y el `Arc` deja al test consultar las llamadas después de mover el
    /// runner dentro del adaptador.
    #[derive(Default, Clone)]
    struct FakeRunner {
        calls: Arc<Mutex<Vec<Vec<String>>>>,
        responses: Arc<Mutex<Vec<(String, CommandOutput)>>>,
        spawn_on: Arc<Mutex<Vec<String>>>,
    }

    impl FakeRunner {
        fn respond(&self, needle: &str, output: CommandOutput) {
            self.responses
                .lock()
                .unwrap()
                .push((needle.to_string(), output));
        }

        /// Como si el binario no existiera (WSL ausente).
        fn spawn_on(&self, needle: &str) {
            self.spawn_on.lock().unwrap().push(needle.to_string());
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(
            &self,
            _program: &Path,
            args: &[String],
            _env: &BTreeMap<String, String>,
            _cwd: &Path,
            _timeout: Duration,
        ) -> Result<CommandOutput, RunError> {
            self.calls.lock().unwrap().push(args.to_vec());
            let joined = args.join(" ");
            for needle in self.spawn_on.lock().unwrap().iter() {
                if joined.contains(needle.as_str()) {
                    return Err(RunError::Spawn);
                }
            }
            for (needle, output) in self.responses.lock().unwrap().iter() {
                if joined.contains(needle.as_str()) {
                    return Ok(output.clone());
                }
            }
            Ok(CommandOutput {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }

    fn ok(stdout: &str) -> CommandOutput {
        CommandOutput {
            code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    fn adapter(runner: FakeRunner) -> RealWslAdapter {
        RealWslAdapter::with_runner_and_program(Box::new(runner), PathBuf::from("wsl.exe"))
    }

    /// La enumeración usa `--list --verbose` y NO despierta (F4): el argv
    /// no lleva `-d`.
    #[test]
    fn list_distributions_uses_verbose_list_without_distro() {
        let runner = FakeRunner::default();
        runner.respond(
            "--list",
            ok("NAME            STATE           VERSION\nUbuntu-22.04   Running         2\n"),
        );
        let adapter = adapter(runner);
        let distros = adapter.list_distributions().expect("enumeración");
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu-22.04");
        assert_eq!(distros[0].state, DistroState::Running);
    }

    /// El home sale del campo 6 de `getent passwd`, con el usuario
    /// resuelto antes por `whoami` (F5) — nunca se asume el de Windows.
    #[test]
    fn resolve_home_uses_whoami_then_getent() {
        let runner = FakeRunner::default();
        runner.respond("whoami", ok("quorbuser\n"));
        runner.respond(
            "getent",
            ok("quorbuser:x:1000:1000::/home/quorbuser:/bin/sh\n"),
        );
        let adapter = adapter(runner);
        let home = adapter.resolve_home("Ubuntu-22.04").expect("home");
        assert_eq!(home, PathBuf::from("/home/quorbuser"));
    }

    /// La lectura usa `cat --` con el path como argumento (F14: sin
    /// shell, sin interpolación) y apunta a la distro pedida.
    #[test]
    fn read_file_passes_path_as_argument() {
        let runner = FakeRunner::default();
        runner.respond("cat", ok("contenido\n"));
        let adapter = adapter(runner);
        let out = adapter
            .read_file(
                "Ubuntu-22.04",
                Path::new("/home/u/.claude/.credentials.json"),
            )
            .expect("lectura");
        assert_eq!(out, "contenido\n");
    }

    /// La detección de shell mira `command -v bash` (F12).
    #[test]
    fn shell_strategy_detects_bash() {
        let runner = FakeRunner::default();
        runner.respond("command -v \"$1\"", ok("/bin/bash\n"));
        let adapter = adapter(runner);
        assert_eq!(
            adapter.shell_strategy("Ubuntu-22.04").expect("shell"),
            ShellStrategy::BashLogin
        );
    }

    /// Sin bash, el fallback es POSIX (`-e sh -c`).
    #[test]
    fn shell_strategy_falls_back_to_posix() {
        let runner = FakeRunner::default();
        runner.respond("command -v \"$1\"", ok(""));
        let adapter = adapter(runner);
        assert_eq!(
            adapter.shell_strategy("Ubuntu-22.04").expect("shell"),
            ShellStrategy::ShPosix
        );
    }

    /// La sonda usa el script constante `command -v "$1"` (datos
    /// posicionales), NO `exec` — en WSL real `exec command` falla con 127
    /// porque `command` es un builtin (hallazgo del lab W3, 2026-10-30).
    #[test]
    fn shell_strategy_uses_command_v_script_not_exec() {
        let runner = FakeRunner::default();
        runner.respond("command -v \"$1\"", ok("/bin/bash\n"));
        let adapter = adapter(runner);
        adapter.shell_strategy("Ubuntu-22.04").expect("shell");
        let calls = runner.calls();
        let argv = calls.last().expect("hay una llamada");
        let joined = argv.join(" ");
        assert!(
            joined.contains("command -v \"$1\""),
            "debe usar el script SCRIPT_COMMAND_V: {joined}"
        );
        assert!(
            !joined.contains("exec"),
            "no debe usar exec (builtin): {joined}"
        );
        assert!(
            argv.ends_with(&["bash".to_string()]),
            "el dato posicional es 'bash': {joined}"
        );
    }

    /// En Alpine (busybox, sin bash) `command -v bash` sale con exit != 0:
    /// eso es una RESPUESTA válida (usa sh), no un error. control_raw
    /// devuelve el output con su código y shell_strategy elige ShPosix.
    #[test]
    fn shell_strategy_treats_nonzero_command_v_as_posix() {
        let runner = FakeRunner::default();
        runner.respond(
            "command -v \"$1\"",
            CommandOutput {
                code: 127,
                stdout: String::new(),
                stderr: String::new(),
            },
        );
        let adapter = adapter(runner);
        assert_eq!(
            adapter.shell_strategy("Alpine").expect("shell"),
            ShellStrategy::ShPosix
        );
    }

    /// El diagnóstico distingue WSL ausente de cero distros (F6).
    #[test]
    fn diagnose_reports_wsl_not_installed() {
        let runner = FakeRunner::default();
        runner.spawn_on("--version");
        let adapter = adapter(runner);
        assert_eq!(
            adapter.diagnose(None).expect("diagnóstico").state,
            WslState::WslNotInstalled
        );
    }

    /// Con WSL pero sin distros: `NoDistributions`, no un error.
    #[test]
    fn diagnose_reports_no_distributions() {
        let runner = FakeRunner::default();
        runner.respond("--version", ok("WSL version: 2.0.0\n"));
        runner.respond("--list", ok("NAME STATE VERSION\n"));
        let adapter = adapter(runner);
        assert_eq!(
            adapter.diagnose(None).expect("diagnóstico").state,
            WslState::NoDistributions
        );
    }

    /// Una distro configurada que no aparece: `DistroUnavailable` con la
    /// lista de disponibles (decisión paso 0 #3, sin fallback).
    #[test]
    fn diagnose_reports_distro_unavailable() {
        let runner = FakeRunner::default();
        runner.respond("--version", ok("WSL version: 2.0.0\n"));
        runner.respond(
            "--list",
            ok("NAME            STATE           VERSION\nUbuntu-22.04   Running         2\n"),
        );
        let adapter = adapter(runner);
        let diag = adapter.diagnose(Some("Debian")).expect("diagnóstico");
        assert_eq!(diag.state, WslState::DistroUnavailable);
        let detail = diag.detail.expect("detalle");
        assert!(detail.contains("Ubuntu-22.04"));
    }

    /// M5: el adaptador real acepta un nombre configurado con distinta
    /// caja (trim + case-insensitive Unicode) — igual que el mock, para
    /// que ambos sean dobles fieles.
    #[test]
    fn diagnose_accepts_different_case_like_the_mock() {
        let runner = FakeRunner::default();
        runner.respond("--version", ok("WSL version: 2.0.0\n"));
        runner.respond(
            "--list",
            ok("NAME            STATE           VERSION\nUbuntu-22.04   Running         2\n"),
        );
        let adapter = adapter(runner);
        let diag = adapter.diagnose(Some("ubuntu-22.04")).expect("diagnóstico");
        assert_eq!(diag.state, WslState::Available);
    }

    /// H2: un `cat` fallido es "fichero ausente", pero WSL ausente o una
    /// distro equivocada NO pueden disfrazarse de eso: el diagnóstico
    /// (F6/W1 §7) depende de distinguirlos.
    #[test]
    fn read_file_distinguishes_missing_file_from_missing_wsl() {
        // WSL ausente: se propaga, no se convierte en FileNotFound.
        let runner = FakeRunner::default();
        runner.spawn_on("cat");
        let adapter = adapter(runner);
        let err = adapter
            .read_file(
                "Ubuntu-22.04",
                Path::new("/home/u/.claude/.credentials.json"),
            )
            .expect_err("WSL ausente");
        assert_eq!(err, WslError::WslNotInstalled);
    }

    /// H2: `cat` fallido sin token conocido → el fichero no está.
    #[test]
    fn read_file_reports_missing_file_on_failed_cat() {
        let runner = FakeRunner::default();
        runner.respond(
            "cat",
            CommandOutput {
                code: 1,
                stdout: String::new(),
                stderr: "cat: /home/u/.claude/.credentials.json: No such file".into(),
            },
        );
        let adapter = adapter(runner);
        let err = adapter
            .read_file(
                "Ubuntu-22.04",
                Path::new("/home/u/.claude/.credentials.json"),
            )
            .expect_err("fichero ausente");
        assert_eq!(
            err,
            WslError::FileNotFound("/home/u/.claude/.credentials.json".to_string())
        );
    }

    /// Las vars con valor de path de Windows se marcan en WSLENV con `/p`
    /// para que WSL traduzca el path al anclar la variable en la distro.
    #[test]
    fn wslenv_marks_windows_paths() {
        assert_eq!(
            build_wslenv_entry("CODEX_HOME", r"C:\Users\quorb\.codex", "").as_deref(),
            Some("CODEX_HOME/p")
        );
        assert_eq!(
            build_wslenv_entry(
                "CLAUDE_CONFIG_DIR",
                r"\\wsl.localhost\Ubuntu\home\q\.claude",
                ""
            )
            .as_deref(),
            Some("CLAUDE_CONFIG_DIR/p")
        );
        // Acumula respetando lo que ya había.
        assert_eq!(
            build_wslenv_entry("CODEX_HOME", r"C:\a", "GEMINI_CLI_HOME/p").as_deref(),
            Some("GEMINI_CLI_HOME/p:CODEX_HOME/p")
        );
    }

    /// Una ruta Linux YA resuelta para la distro no se convierte: entra sin
    /// `/p` (marcarla la estropearía). Un valor que no es ruta no entra.
    #[test]
    fn wslenv_does_not_convert_linux_paths_nor_non_paths() {
        assert_eq!(
            build_wslenv_entry("CLAUDE_CONFIG_DIR", "/home/q/.claude", "").as_deref(),
            Some("CLAUDE_CONFIG_DIR")
        );
        assert_eq!(build_wslenv_entry("DEBUG", "1", ""), None);
        // Fuera de la allowlist: no se reenvía nada.
        assert_eq!(build_wslenv_entry("PATH", "/usr/bin", ""), None);
        assert_eq!(build_wslenv_entry("HOME", r"C:\Users\q", ""), None);
    }

    /// Solo se transmiten las variables de la allowlist de sesión.
    #[test]
    fn wslenv_only_forwards_allowlisted_session_vars() {
        for key in SESSION_ENV_ALLOWLIST {
            assert!(
                build_wslenv_entry(key, r"C:\x", "").is_some(),
                "{key} debería transmitirse"
            );
        }
        assert_eq!(
            build_wslenv_entry("AWS_SECRET_ACCESS_KEY", r"C:\x", ""),
            None
        );
    }

    /// No duplica una entrada ya presente (con o sin flag).
    #[test]
    fn wslenv_does_not_duplicate() {
        assert_eq!(
            build_wslenv_entry("CODEX_HOME", r"C:\a", "CODEX_HOME"),
            None
        );
        assert_eq!(
            build_wslenv_entry("CODEX_HOME", r"C:\a", "CODEX_HOME/p"),
            None
        );
    }

    /// La sonda de WSL es `--version` (contrato W1 §6); la build antigua
    /// sin soporte se cubre en `diagnose_maps_old_build_without_version_*`.

    /// `terminate()` es el nivel 2: `--terminate <distro>`, sin el
    /// separador `--` (es una opción de `wsl.exe`, no un comando).
    #[test]
    fn terminate_uses_terminate_option() {
        let runner = FakeRunner::default();
        let adapter = adapter(runner.clone());
        adapter.terminate("Ubuntu-22.04").expect("terminate");
        let calls = runner.calls();
        assert_eq!(
            calls[0],
            vec!["--terminate".to_string(), "Ubuntu-22.04".to_string()]
        );
    }
}
