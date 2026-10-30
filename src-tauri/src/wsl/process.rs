//! Lanzador de `wsl.exe`: dónde está el binario, cómo se construye el argv
//! y cómo se cancela una operación SIN tumbar la distro.
//!
//! **F14 (doble frontera)**: el texto del script que se pasa al shell es
//! una **constante del código** (allowlist). Los datos (rutas, args del
//! proveedor) viajan como **parámetros posicionales** que el script
//! referencia entrecomillados. Nada se interpola nunca en el script.
//!
//! **Cancelación en dos niveles** (revisión del owner, 2026-10-23):
//! - **Nivel 1 (automático)**: al expirar el timeout, se mata el proceso
//!   remoto de la operación (el PID que el propio script escribió en un
//!   pidfile) y la distro queda `Running`. No se toca nada ajeno.
//! - **Nivel 2 (recuperación explícita del usuario)**: `wsl --terminate
//!   <distro>` — para eso está `terminate()` en el trait.

use super::{ShellStrategy, WslError};
use crate::cli_process::{CommandOutput, CommandRunner, RunError};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Script constante de la sonda de shell (F12): resuelve la ruta del
/// binario indicado como `$1` (`command -v`).
///
/// `command` es un BUILTIN del shell, no un binario: por eso la sonda NO
/// puede ir como `exec "$@"` (fallaría con 127 en todas las distros —
/// hallazgo del lab W3 en WSL real, 2026-10-30). El script es constante
/// y el nombre del binario viaja como dato posicional `$1`. Devuelve:
/// ruta + exit 0 si el binario existe; salida vacía + exit != 0 si no.
pub const SCRIPT_COMMAND_V: &str = "command -v \"$1\"";

/// Script constante con pidfile endurecido.
///
/// `$1` es un DIRECTORIO BASE que crea este script de forma atómica con
/// `mkdir -m 700` (falla con EEXIST si ya existe: no sigue enlaces
/// preexistentes, así que otro usuario de la distro no puede plantar un
/// symlink). Dentro del base se crea el directorio de la operación con
/// `mktemp -d` (O_EXCL, sufijo aleatorio): el PID vive en
/// `<base>/<aleatorio>/pid`, solo legible por el dueño (`umask 077`).
///
/// `exec` conserva el PID, así que el pidfile apunta al proceso final de la
/// operación. La limpieza del base (`rm -rf`) la hace el host en éxito,
/// error y cancelación.
pub const SCRIPT_EXEC_PIDFILE: &str = concat!(
    "b=\"$1\" && shift && ",
    "mkdir -m 700 \"$b\" && ",
    "d=$(mktemp -d \"$b/XXXXXX\") && ",
    "umask 077 && ",
    "echo $$ > \"$d/pid\" && ",
    "exec \"$@\""
);

/// Nombre de cortesía para `$0`. No es un dato: solo ocupa la posición.
const SHELL_ARGV0: &str = "quorb";

/// Contador de operaciones, para que el nonce sea distinto entre llamadas.
static NONCE: AtomicU64 = AtomicU64::new(0);

fn next_nonce() -> u64 {
    NONCE.fetch_add(1, Ordering::Relaxed)
}

/// Directorio BASE de la operación **dentro de la distro**.
///
/// `/tmp` es escribible por el usuario en cualquier distro y no depende de
/// conocer el home. El nombre combina PID del host, un contador y el reloj
/// de nanos. Lo crea el script con `mkdir -m 700` (atómico: falla si ya
/// existe, así que no sigue un symlink plantado) y dentro `mktemp -d`
/// decide el directorio real de la operación.
pub fn pidfile_base() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    PathBuf::from(format!(
        "/tmp/quorb-wsl-{}-{}-{nanos}",
        std::process::id(),
        next_nonce()
    ))
}

/// Script constante para leer el PID publicado dentro del base.
///
/// El nombre del subdirectorio lo decide `mktemp -d` en la distro, así que
/// el host lo descubre con un glob dentro del base. `$1` entra como
/// parámetro posicional: nada se interpola en el script.
pub const SCRIPT_READ_PID: &str = "cat \"$1\"/*/pid";

/// Script constante para borrar el base de la operación (éxito, error o
/// cancelación).
pub const SCRIPT_CLEANUP: &str = "rm -rf \"$1\"";

/// Rutas donde puede vivir `wsl.exe` (F9).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WslSearchPaths {
    /// `%SystemRoot%\System32`
    pub system32: Option<PathBuf>,
    /// `%SystemRoot%\Sysnative` — para procesos de 32 bits (F9).
    pub sysnative: Option<PathBuf>,
    /// `%ProgramFiles%\WSL` — imágenes de Win10 antiguas.
    pub program_files: Option<PathBuf>,
    /// Directorios del PATH donde buscar `wsl.exe`.
    pub path_dirs: Vec<PathBuf>,
}

impl WslSearchPaths {
    /// Rutas derivadas del entorno real del proceso.
    pub fn from_env() -> Self {
        let system_root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("SYSTEMROOT"))
            .map(PathBuf::from);
        let program_files = std::env::var_os("ProgramFiles")
            .or_else(|| std::env::var_os("PROGRAMFILES"))
            .map(PathBuf::from);
        let path_dirs = std::env::var_os("PATH")
            .or_else(|| std::env::var_os("Path"))
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        WslSearchPaths {
            system32: system_root.as_ref().map(|r| r.join("System32")),
            sysnative: system_root.as_ref().map(|r| r.join("Sysnative")),
            program_files: program_files.map(|p| p.join("WSL")),
            path_dirs,
        }
    }
}

/// Resuelve el binario de `wsl.exe`.
///
/// Orden (F9 + Microsoft Learn): `System32` en procesos de 64 bits;
/// `Sysnative` **antes** en procesos de 32 bits (en System32 el
/// redireccionamiento a SysWOW64 no tiene `wsl.exe`); luego
/// `%ProgramFiles%\WSL` (Win10 antiguo) y por último el PATH.
///
/// `exists` se inyecta para poder probar el orden sin tocar el disco.
pub fn resolve_wsl_exe(
    paths: &WslSearchPaths,
    is_32bit: bool,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if is_32bit {
        candidates.extend(paths.sysnative.iter().map(|d| d.join("wsl.exe")));
        candidates.extend(paths.system32.iter().map(|d| d.join("wsl.exe")));
    } else {
        candidates.extend(paths.system32.iter().map(|d| d.join("wsl.exe")));
        candidates.extend(paths.sysnative.iter().map(|d| d.join("wsl.exe")));
    }
    candidates.extend(paths.program_files.iter().map(|d| d.join("wsl.exe")));
    if let Some(candidate) = candidates.into_iter().find(|c| exists(c)) {
        return Some(candidate);
    }
    paths
        .path_dirs
        .iter()
        .map(|dir| dir.join("wsl.exe"))
        .find(|c| exists(c))
}

/// Construye el argv de un comando con shell dentro de una distro.
///
/// El shell se elige como `-e bash -lc` (login: carga el PATH del
/// usuario, donde viven nvm/volta — F8) o `-e sh -c` si no hay bash.
/// El texto del script es una constante; los datos van como parámetros
/// posicionales.
pub fn shell_args(
    distro: Option<&str>,
    shell: ShellStrategy,
    script: &str,
    args: &[&str],
) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + 7);
    if let Some(distro) = distro {
        out.push("-d".to_string());
        out.push(distro.to_string());
    }
    out.push("-e".to_string());
    match shell {
        ShellStrategy::BashLogin => {
            out.push("bash".to_string());
            out.push("-lc".to_string());
        }
        ShellStrategy::ShPosix => {
            out.push("sh".to_string());
            out.push("-c".to_string());
        }
    }
    out.push(script.to_string());
    out.push(SHELL_ARGV0.to_string());
    out.extend(args.iter().map(|a| a.to_string()));
    out
}

/// Construye el argv de un comando directo dentro de una distro:
/// `wsl -d X -- cmd args…`. Los args van como elementos separados: nunca
/// se interpolan.
pub fn direct_args(distro: Option<&str>, command: &str, args: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + 5);
    if let Some(distro) = distro {
        out.push("-d".to_string());
        out.push(distro.to_string());
    }
    out.push("--".to_string());
    out.push(command.to_string());
    out.extend(args.iter().map(|a| a.to_string()));
    out
}

/// argv para un script CONSTANTE con datos posicionales (F14): `sh -c
/// <script> <argv0> <args…>`. Nunca se interpola nada.
pub fn script_args(distro: Option<&str>, script: &str, args: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + 6);
    if let Some(distro) = distro {
        out.push("-d".to_string());
        out.push(distro.to_string());
    }
    out.push("--".to_string());
    out.push("sh".to_string());
    out.push("-c".to_string());
    out.push(script.to_string());
    out.push(SHELL_ARGV0.to_string());
    out.extend(args.iter().map(|a| a.to_string()));
    out
}

/// argv de limpieza del base del pidfile (éxito, error y cancelación).
fn cleanup_args(distro: Option<&str>, base: &Path) -> Vec<String> {
    let base_str = base.to_string_lossy().to_string();
    script_args(distro, SCRIPT_CLEANUP, &[base_str.as_str()])
}

/// Construye el argv de una **opción de `wsl.exe`** (no de un comando):
/// `wsl --list --verbose`, `wsl --version`, `wsl --terminate <distro>`.
/// Sin el separador `--`, que aquí delimita el comando a ejecutar.
pub fn option_args(option: &str, value: Option<&str>) -> Vec<String> {
    let mut out = vec![option.to_string()];
    if let Some(value) = value {
        out.push(value.to_string());
    }
    out
}

/// Ejecuta `wsl.exe` y traduce el fallo a un error de dominio.
///
/// `distro` es el nombre de la distro objetivo (para el error
/// `DistroNotFound`); `None` en comandos de control (`--list`, `--version`,
/// `--terminate`).
#[allow(clippy::too_many_arguments)]
pub fn run_wsl(
    runner: &dyn CommandRunner,
    program: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: &Path,
    timeout: Duration,
    distro: Option<&str>,
) -> Result<CommandOutput, WslError> {
    match runner.run(program, args, env, cwd, timeout) {
        Ok(output) => {
            if output.code == 0 {
                Ok(output)
            } else {
                Err(super::errors::classify(&output, distro).unwrap_or_else(|| {
                    WslError::UnparsableOutput(format!(
                        "wsl.exe terminó con código {}",
                        output.code
                    ))
                }))
            }
        }
        Err(RunError::Spawn) => Err(WslError::WslNotInstalled),
        Err(RunError::Io) => Err(WslError::UnparsableOutput(
            "wsl.exe no se pudo ejecutar (error de E/S)".into(),
        )),
        // Comando de control: no hay pidfile, así que el PID remoto se
        // desconoce (0). La cancelación acotada de nivel 1 es la de
        // `run_scoped`.
        Err(RunError::Timeout) => Err(WslError::Timeout {
            distro: distro.unwrap_or_default().to_string(),
            pid: 0,
        }),
    }
}

/// Contexto de ejecución de `wsl.exe`: el runner, el binario, el entorno,
/// el cwd y los presupuestos de tiempo. Agrupa lo que cada operación
/// necesita para no arrastrar media docena de argumentos.
pub struct WslRunner<'a> {
    runner: &'a dyn CommandRunner,
    program: &'a Path,
    env: &'a BTreeMap<String, String>,
    cwd: &'a Path,
    timeout: Duration,
    cleanup_timeout: Duration,
}

impl<'a> WslRunner<'a> {
    pub fn new(
        runner: &'a dyn CommandRunner,
        program: &'a Path,
        env: &'a BTreeMap<String, String>,
        cwd: &'a Path,
        timeout: Duration,
        cleanup_timeout: Duration,
    ) -> Self {
        WslRunner {
            runner,
            program,
            env,
            cwd,
            timeout,
            cleanup_timeout,
        }
    }

    /// Ejecuta un comando de control (sin distro) y traduce el fallo.
    pub fn control(
        &self,
        args: &[String],
        distro: Option<&str>,
    ) -> Result<CommandOutput, WslError> {
        run_wsl(
            self.runner,
            self.program,
            args,
            self.env,
            self.cwd,
            self.timeout,
            distro,
        )
    }

    /// Igual que `control`, pero NO convierte un exit code distinto de 0
    /// en error: el código de salida de una **sonda** es parte de su
    /// respuesta (p. ej. `command -v X` devuelve != 0 cuando X no existe).
    /// Solo `Spawn`/`Io`/`Timeout` (no poder lanzar wsl.exe) son errores.
    pub fn control_raw(
        &self,
        args: &[String],
        distro: Option<&str>,
    ) -> Result<CommandOutput, WslError> {
        match self
            .runner
            .run(self.program, args, self.env, self.cwd, self.timeout)
        {
            Ok(output) => Ok(output),
            Err(RunError::Spawn) => Err(WslError::WslNotInstalled),
            Err(RunError::Io) => Err(WslError::UnparsableOutput(
                "wsl.exe no se pudo ejecutar (error de E/S)".into(),
            )),
            Err(RunError::Timeout) => Err(WslError::Timeout {
                distro: distro.unwrap_or_default().to_string(),
                pid: 0,
            }),
        }
    }

    /// Ejecuta un comando en la distro con **cancelación acotada**
    /// (nivel 1).
    ///
    /// El comando se envuelve con el script constante de pidfile, de modo
    /// que el PID remoto de la operación queda escrito antes del `exec`.
    /// Si el comando expira: se lee el PID del pidfile (comando corto y
    /// acotado), se mata ese PID dentro de la distro (`kill -TERM`, luego
    /// `-KILL`) y se borra el pidfile.
    ///
    /// La distro **queda `Running`** y no se toca ningún proceso ajeno
    /// (a diferencia de `--terminate`, que es el nivel 2).
    pub fn run_scoped(
        &self,
        distro: &str,
        shell: ShellStrategy,
        args: &[&str],
    ) -> Result<CommandOutput, WslError> {
        let base = pidfile_base();
        let base_str = base.to_string_lossy().to_string();

        // El directorio de la operación ocupa `$1`; el comando va detrás.
        let mut shell_args_all: Vec<&str> = Vec::with_capacity(args.len() + 1);
        shell_args_all.push(base_str.as_str());
        shell_args_all.extend_from_slice(args);

        let argv = shell_args(Some(distro), shell, SCRIPT_EXEC_PIDFILE, &shell_args_all);
        let outcome = self
            .runner
            .run(self.program, &argv, self.env, self.cwd, self.timeout);

        // El base del pidfile no se deja atrás: se limpia en éxito y en
        // error; en timeout lo limpia `kill_remote_process` tras cancelar.
        let cleanup = |base: &Path| {
            let a = cleanup_args(Some(distro), base);
            let _ = self
                .runner
                .run(self.program, &a, self.env, self.cwd, self.cleanup_timeout);
        };

        match outcome {
            Ok(output) if output.code == 0 => {
                cleanup(&base);
                Ok(output)
            }
            Ok(output) => {
                cleanup(&base);
                Err(
                    super::errors::classify(&output, Some(distro)).unwrap_or_else(|| {
                        WslError::UnparsableOutput(format!(
                            "wsl.exe terminó con código {}",
                            output.code
                        ))
                    }),
                )
            }
            Err(RunError::Timeout) => {
                let pid = kill_remote_process(
                    self.runner,
                    self.program,
                    distro,
                    &base,
                    self.env,
                    self.cwd,
                    self.cleanup_timeout,
                );
                Err(WslError::Timeout {
                    distro: distro.to_string(),
                    pid,
                })
            }
            Err(RunError::Spawn) => Err(WslError::WslNotInstalled),
            Err(RunError::Io) => Err(WslError::UnparsableOutput(
                "wsl.exe no se pudo ejecutar (error de E/S)".into(),
            )),
        }
    }
}

/// Gracia que se le da al remoto entre el `kill -TERM` y el `-KILL`.
const TERM_GRACE: Duration = Duration::from_millis(100);
const TERM_PROBES: usize = 10;

/// Lee el PID del pidfile y mata ese proceso dentro de la distro.
///
/// Devuelve el PID si se pudo leer y matar; 0 si no se pudo determinar
/// (el error del timeout sigue siendo el que se propaga).
fn kill_remote_process(
    runner: &dyn CommandRunner,
    program: &Path,
    distro: &str,
    base: &Path,
    env: &BTreeMap<String, String>,
    cwd: &Path,
    cleanup_timeout: Duration,
) -> i64 {
    let base_str = base.to_string_lossy().to_string();
    let read = script_args(Some(distro), SCRIPT_READ_PID, &[base_str.as_str()]);
    let pid = runner
        .run(program, &read, env, cwd, cleanup_timeout)
        .ok()
        .filter(|o| o.code == 0)
        .and_then(|o| o.stdout.trim().parse::<i64>().ok())
        .unwrap_or(0);

    if pid > 0 {
        let pid_str = pid.to_string();
        // `kill` con el PID como argv: sin shell, sin interpolación.
        let term = direct_args(Some(distro), "kill", &["-TERM", pid_str.as_str()]);
        let _ = runner.run(program, &term, env, cwd, cleanup_timeout);
        // Gracia: el TERM es la vía suave; solo si al cabo de esas sondas
        // sigue vivo se escala a KILL (antes el -KILL era instantáneo y la
        // vía suave nunca se ejercitaba).
        for _ in 0..TERM_PROBES {
            let alive = direct_args(Some(distro), "kill", &["-0", pid_str.as_str()]);
            let alive = match runner.run(program, &alive, env, cwd, cleanup_timeout) {
                Ok(out) => out.code == 0,
                // Comandos de limpieza acotados; un fallo aquí es indicio
                // de que el pid ya no está: se trata como "murió".
                Err(_) => false,
            };
            if !alive {
                break;
            }
            std::thread::sleep(TERM_GRACE);
        }
        // Segunda comprobación tras la gracia; si sigue, KILL.
        let alive = direct_args(Some(distro), "kill", &["-0", pid_str.as_str()]);
        if let Ok(out) = runner.run(program, &alive, env, cwd, cleanup_timeout) {
            if out.code == 0 {
                let hard = direct_args(Some(distro), "kill", &["-KILL", pid_str.as_str()]);
                let _ = runner.run(program, &hard, env, cwd, cleanup_timeout);
            }
        }
    }

    // El base de la operación no se deja en la distro.
    let rm = cleanup_args(Some(distro), base);
    let _ = runner.run(program, &rm, env, cwd, cleanup_timeout);
    pid
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> WslSearchPaths {
        WslSearchPaths {
            system32: Some(PathBuf::from(r"C:\Windows\System32")),
            sysnative: Some(PathBuf::from(r"C:\Windows\Sysnative")),
            program_files: Some(PathBuf::from(r"C:\Program Files\WSL")),
            path_dirs: vec![PathBuf::from(r"C:\Windows")],
        }
    }

    /// El path se compara por partes: en Linux el separador de `PathBuf`
    /// es `/`, y estos son paths de Windows.
    fn assert_win(path: Option<PathBuf>, dir: &str) {
        let path = path.expect("wsl.exe debe resolverse");
        assert!(
            path.ends_with("wsl.exe"),
            "debe terminar en wsl.exe: {path:?}"
        );
        assert!(
            path.to_string_lossy().contains(dir),
            "debe estar bajo {dir}: {path:?}"
        );
    }

    /// F9: en 64 bits manda System32.
    #[test]
    fn resolves_system32_first_on_64bit() {
        let found = resolve_wsl_exe(&paths(), false, &|_| true);
        assert_win(found, "System32");
    }

    /// F9: en 32 bits, Sysnative va antes (System32 redirige a SysWOW64,
    /// donde no hay `wsl.exe`).
    #[test]
    fn resolves_sysnative_first_on_32bit() {
        let found = resolve_wsl_exe(&paths(), true, &|_| true);
        assert_win(found, "Sysnative");
    }

    /// Si System32 no existe, se cae a Sysnative y luego a ProgramFiles.
    #[test]
    fn falls_back_when_system32_is_missing() {
        let exists = |p: &Path| !p.to_string_lossy().contains("System32");
        let found = resolve_wsl_exe(&paths(), false, &exists);
        assert_win(found, "Sysnative");
    }

    /// El PATH es el último recurso.
    #[test]
    fn falls_back_to_path() {
        let exists = |p: &Path| {
            p.ends_with("wsl.exe")
                && p.to_string_lossy().contains("C:\\Windows")
                && !p.to_string_lossy().contains("System32")
                && !p.to_string_lossy().contains("Sysnative")
                && !p.to_string_lossy().contains("Program Files")
        };
        let found = resolve_wsl_exe(&paths(), false, &exists);
        assert_win(found, "C:\\Windows");
    }

    /// Sin `wsl.exe` en ninguna parte: `None` (WSL ausente → diagnóstico
    /// F6, no otro error).
    #[test]
    fn returns_none_when_wsl_is_absent() {
        let found = resolve_wsl_exe(&paths(), false, &|_| false);
        assert_eq!(found, None);
    }

    /// F14: el script va como elemento de argv, la distro y los datos
    /// como posicionales; nada se concatena.
    #[test]
    fn shell_args_keep_script_and_data_separated() {
        let argv = shell_args(
            Some("Ubuntu-22.04"),
            ShellStrategy::BashLogin,
            SCRIPT_COMMAND_V,
            &["bash"],
        );
        assert_eq!(
            argv,
            vec![
                "-d",
                "Ubuntu-22.04",
                "-e",
                "bash",
                "-lc",
                "command -v \"$1\"",
                "quorb",
                "bash"
            ]
        );
    }

    /// El fallback POSIX usa `-e sh -c`.
    #[test]
    fn shell_args_use_posix_fallback() {
        let argv = shell_args(None, ShellStrategy::ShPosix, SCRIPT_COMMAND_V, &["bash"]);
        assert_eq!(&argv[..3], &["-e", "sh", "-c"]);
    }

    /// Un comando directo no pasa por el shell: los args van sueltos.
    #[test]
    fn direct_args_are_separated() {
        let argv = direct_args(Some("Ubuntu-22.04"), "cat", &["--", "/a b/c"]);
        assert_eq!(
            argv,
            vec!["-d", "Ubuntu-22.04", "--", "cat", "--", "/a b/c"]
        );
    }

    /// Las opciones de `wsl.exe` no llevan el separador `--`.
    #[test]
    fn option_args_have_no_separator() {
        assert_eq!(
            option_args("--terminate", Some("Ubuntu-22.04")),
            vec!["--terminate", "Ubuntu-22.04"]
        );
        assert_eq!(option_args("--version", None), vec!["--version"]);
    }

    /// Dos operaciones no comparten pidfile.
    #[test]
    fn pidfiles_are_unique() {
        let a = pidfile_base();
        let b = pidfile_base();
        assert_ne!(a, b);
        assert!(a.to_string_lossy().starts_with("/tmp/quorb-wsl-"));
    }

    /// Endurecimiento del pidfile (revision del owner, 2026-10-26):
    /// la creacion es ATOMICA y privada. El script crea el base con
    /// `mkdir -m 700` (falla si existe -> no sigue un symlink plantado),
    /// y dentro `mktemp -d` decide el subdirectorio. El host NUNCA escribe
    /// el pid: solo lo lee con un glob.
    #[test]
    fn pidfile_creation_is_atomic_and_private() {
        assert!(SCRIPT_EXEC_PIDFILE.contains("mkdir -m 700"));
        assert!(SCRIPT_EXEC_PIDFILE.contains("mktemp -d"));
        assert!(SCRIPT_EXEC_PIDFILE.contains("umask 077"));
        // Nada de `echo >` directo sobre una ruta predecible.
        assert!(!SCRIPT_EXEC_PIDFILE.contains("> \"$b/pid\""));
        // La lectura descubre el subdirectorio creado por mktemp.
        assert_eq!(SCRIPT_READ_PID, "cat \"$1\"/*/pid");
    }

    /// La limpieza es un script constante con el base como parametro: se
    /// ejecuta en exito, error y cancelacion.
    #[test]
    fn cleanup_is_a_constant_script_with_the_base_as_argument() {
        let argv = cleanup_args(Some("Ubuntu-22.04"), Path::new("/tmp/quorb-wsl-x"));
        assert_eq!(&argv[..5], &["-d", "Ubuntu-22.04", "--", "sh", "-c"]);
        assert_eq!(argv[5], SCRIPT_CLEANUP);
        assert_eq!(argv[6], "quorb");
        assert_eq!(argv[7], "/tmp/quorb-wsl-x");
    }

    /// F14: el script va como elemento de argv y los datos como
    /// posicionales; nada se concatena.
    #[test]
    fn script_args_keep_script_and_data_separated() {
        let argv = script_args(Some("Debian"), SCRIPT_READ_PID, &["/tmp/a b"]);
        assert_eq!(
            argv,
            vec![
                "-d",
                "Debian",
                "--",
                "sh",
                "-c",
                "cat \"$1\"/*/pid",
                "quorb",
                "/tmp/a b"
            ]
        );
    }

    /// El directorio del pidfile no debe ser predecible: lleva el reloj de
    /// nanos, no solo un contador.
    #[test]
    fn pidfile_dir_is_not_just_a_counter() {
        let dir = pidfile_base().to_string_lossy().to_string();
        let parts: Vec<&str> = dir
            .trim_start_matches("/tmp/quorb-wsl-")
            .split('-')
            .collect();
        assert!(
            parts.len() >= 3 && parts[2].parse::<u128>().is_ok(),
            "el nombre debe incluir un nonce temporal: {dir}"
        );
    }

    /// Nivel 1: si el comando expira, se mata el proceso remoto de la
    /// operación (por su pidfile), se borra el pidfile y se devuelve
    /// `Timeout` — SIN `--terminate` (eso es el nivel 2).
    #[test]
    fn run_scoped_timeout_kills_only_the_remote_process() {
        use crate::cli_process::RunError;
        use std::sync::Mutex;
        use std::time::Duration;

        #[derive(Default)]
        struct Scripted {
            calls: Mutex<Vec<Vec<String>>>,
            // needle -> output
            responses: Mutex<Vec<(String, String)>>,
            timeout_on: Mutex<Vec<String>>,
        }
        impl CommandRunner for Scripted {
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
                for needle in self.timeout_on.lock().unwrap().iter() {
                    if joined.contains(needle.as_str()) {
                        return Err(RunError::Timeout);
                    }
                }
                for (needle, stdout) in self.responses.lock().unwrap().iter() {
                    if joined.contains(needle.as_str()) {
                        return Ok(CommandOutput {
                            code: 0,
                            stdout: stdout.clone(),
                            stderr: String::new(),
                        });
                    }
                }
                Ok(CommandOutput {
                    code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            }
        }

        let scripted = Scripted::default();
        // El comando que cuelga es el `sleep`; el pidfile ya se escribió.
        scripted
            .timeout_on
            .lock()
            .unwrap()
            .push("sleep 100".to_string());
        // Leer el pidfile devuelve el PID; matar/rm devuelven OK.
        scripted
            .responses
            .lock()
            .unwrap()
            .push(("/tmp/quorb-wsl-".to_string(), "4242\n".to_string()));

        let env = BTreeMap::new();
        let cwd = Path::new(".");
        let runner = WslRunner::new(
            &scripted,
            Path::new("wsl.exe"),
            &env,
            cwd,
            Duration::from_secs(1),
            Duration::from_secs(1),
        );
        let err = runner
            .run_scoped("Ubuntu-22.04", ShellStrategy::ShPosix, &["sleep", "100"])
            .expect_err("timeout");

        assert_eq!(
            err,
            WslError::Timeout {
                distro: "Ubuntu-22.04".to_string(),
                pid: 4242
            }
        );
        let calls = scripted.calls.lock().unwrap().clone();
        // Tras el timeout se leyó el pid dentro del base (script constante
        // con glob: el nombre lo decidio `mktemp -d`).
        assert!(calls
            .iter()
            .any(|c| c.contains(&SCRIPT_READ_PID.to_string())));
        // ...se mató el proceso remoto (kill -TERM/-KILL), sin --terminate.
        assert!(calls
            .iter()
            .any(|c| c.iter().any(|a| a == "-TERM" || a == "-KILL")));
        assert!(calls.iter().all(|c| !c.iter().any(|a| a == "--terminate")));
        // ...y se limpió el base de la operacion.
        assert!(calls
            .iter()
            .any(|c| c.contains(&SCRIPT_CLEANUP.to_string())));
    }

    /// TERM -> KILL con plazo de gracia REAL (revision del owner,
    /// 2026-10-26). Tres casos sobre `kill_remote_process`:
    ///  - atiende TERM y muere -> NO se escala a KILL;
    ///  - IGNORA TERM -> si se escala a KILL;
    ///  - ya terminado -> nada que matar (sin error).
    /// En los tres, la distro NO se toca (nunca `--terminate`) y el base
    /// de la operacion se limpia.
    #[test]
    fn kill_escalates_to_kill_only_when_term_is_ignored() {
        use crate::cli_process::RunError;
        use std::sync::Mutex;

        struct Remote {
            alive: Mutex<bool>,
            term_works: bool,
            calls: Mutex<Vec<Vec<String>>>,
        }
        impl CommandRunner for Remote {
            fn run(
                &self,
                _program: &Path,
                args: &[String],
                _env: &BTreeMap<String, String>,
                _cwd: &Path,
                _timeout: Duration,
            ) -> Result<CommandOutput, RunError> {
                self.calls.lock().unwrap().push(args.to_vec());
                // La lectura del pid: script constante con glob.
                if args.contains(&SCRIPT_READ_PID.to_string()) {
                    return Ok(CommandOutput {
                        code: 0,
                        stdout: "4242\n".to_string(),
                        stderr: String::new(),
                    });
                }
                let joined = args.join(" ");
                if joined.contains("-TERM") && self.term_works {
                    *self.alive.lock().unwrap() = false;
                }
                if joined.contains("-KILL") {
                    *self.alive.lock().unwrap() = false;
                }
                let code = if joined.contains("-0") {
                    if *self.alive.lock().unwrap() {
                        0
                    } else {
                        1
                    }
                } else {
                    0
                };
                Ok(CommandOutput {
                    code,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            }
        }

        fn case(term_works: bool, alive: bool) -> (i64, Vec<Vec<String>>) {
            let remote = Remote {
                alive: Mutex::new(alive),
                term_works,
                calls: Mutex::new(Vec::new()),
            };
            let env = BTreeMap::new();
            let pid = kill_remote_process(
                &remote,
                Path::new("wsl.exe"),
                "Ubuntu-22.04",
                Path::new("/tmp/quorb-base"),
                &env,
                Path::new("."),
                Duration::from_millis(1),
            );
            let calls = remote.calls.lock().unwrap().clone();
            (pid, calls)
        }

        // 1) atiende TERM -> muere sin KILL
        let (pid1, c1) = case(true, true);
        assert_eq!(pid1, 4242);
        assert!(c1.iter().any(|c| c.iter().any(|a| a == "-TERM")));
        assert!(
            !c1.iter().any(|c| c.iter().any(|a| a == "-KILL")),
            "no debe escalar si TERM basta"
        );

        // 2) ignora TERM -> escala a KILL
        let (_, c2) = case(false, true);
        assert!(c2.iter().any(|c| c.iter().any(|a| a == "-TERM")));
        assert!(
            c2.iter().any(|c| c.iter().any(|a| a == "-KILL")),
            "debe escalar si ignora TERM"
        );

        // 3) ya terminado -> sin KILL
        let (_, c3) = case(true, false);
        assert!(
            !c3.iter().any(|c| c.iter().any(|a| a == "-KILL")),
            "nada que matar"
        );

        // En ninguno se toco la distro entera; y siempre se limpio el base.
        for calls in [&c1, &c2, &c3] {
            assert!(calls.iter().all(|c| !c.iter().any(|a| a == "--terminate")));
            assert!(calls
                .iter()
                .any(|c| c.contains(&SCRIPT_CLEANUP.to_string())));
        }
    }
}
