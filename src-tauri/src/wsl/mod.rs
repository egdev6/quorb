//! Adaptador WSL — contrato inyectable para el modo `wsl/<distro>`.
//!
//! **Fase A** (issue #90, `quorb-wsl-v1`): solo el contrato y un mock
//! determinista. La implementación real (`RealWslAdapter`, procesos
//! `wsl.exe`) es Fase B.
//!
//! Decisiones del paso 0: `ADR-W2.md`. Contrato firmado: `W2-WSLADAPTER.md`.

pub use crate::cli_process::{CommandOutput, RunError};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod errors;
mod mock;
mod process;
mod real;
mod session;
pub use mock::{MockWslAdapter, WslCall};
pub use process::SCRIPT_COMMAND_V;
pub use real::{build_wslenv_entry, RealWslAdapter, SESSION_ENV_ALLOWLIST};
pub use session::{SessionEnv, SessionError, SessionResolver};

/// Caché del home del default user de una distro (#91).
///
/// `resolve_home` lanza dos procesos `wsl.exe` y `session_stamp` se
/// consulta cada 15 s (`SESSION_CHECK_MS`): sin caché, cada consulta paga
/// dos procesos y puede mantener la VM de WSL siempre activa. El home de
/// una distro solo cambia si cambia su default user; la invalidación es
/// automática al cambiar la distro configurada: `home_for` descarta el
/// mapa en cuanto ve una distro distinta de la cacheada (revisión del
/// mantenedor, 2026-11-02).
#[derive(Default)]
pub struct WslHomeCache(Mutex<(Option<String>, HashMap<String, PathBuf>)>);

impl WslHomeCache {
    /// Home cacheado para `distro`, o `None` si no está. Si la distro
    /// activa cambió, el caché se limpia y `None` fuerza a resolver el
    /// home nuevo.
    pub fn home_for(&self, distro: &str) -> Option<PathBuf> {
        let mut inner = self.0.lock().unwrap();
        if inner.0.as_deref() != Some(distro) {
            inner.0 = Some(distro.to_string());
            inner.1.clear();
            return None;
        }
        inner.1.get(distro).cloned()
    }

    /// Guarda el home resuelto de `distro`.
    pub fn insert(&self, distro: &str, home: PathBuf) {
        self.0.lock().unwrap().1.insert(distro.to_string(), home);
    }
}

/// Error tipado de una operación WSL. Se asigna desde el parseo de tokens
/// del output (F2) o desde fallos del lanzador (F13/timeout).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WslError {
    /// WSL no está instalado / no en PATH (`wsl --version` falla) — F6.
    WslNotInstalled,
    /// Cero distros (`wsl --list` → "no installed distributions") — F6.
    NoDistributions,
    /// Distro elegida no existe (`Wsl/Service/WSL_E_DISTRO_NOT_FOUND`) — F2/F6.
    DistroNotFound(String),
    /// El archivo no existe dentro de la distro (o no se pudo leer). Se
    /// distingue de `UnparsableOutput`: aquí no hay sesión, el contenido
    /// nunca llegó a parsearse.
    FileNotFound(String),
    /// Argumento inválido del CLI ("Invalid command line argument") — F2.
    InvalidArgument(String),
    /// Salida inesperada que no se pudo parsear.
    UnparsableOutput(String),
    /// Timeout: cancelación ACOTADA (nivel 1) — kill del launcher local y del
    /// PID remoto que escribió el pidfile. La distro queda `Running`; no se
    /// toca nada ajeno a la operación. `--terminate` es el nivel 2
    /// (recuperación explícita del usuario) y no llega por aquí.
    Timeout { distro: String, pid: i64 },
    /// Error de lanzamiento de proceso (re-export de RunError bajo el mismo).
    Spawn(RunError),
}

/// Interfaz que W2 implementa (RealWslAdapter) y los tests simulan
/// (MockWslAdapter). Métodos síncronos que devuelven Result — el lanzador
/// con timeout vive dentro del impl, no en el llamador.
pub trait WslAdapter: Send + Sync {
    /// Enumerar distros instaladas (F4, `wsl --list --quiet`/`--verbose`).
    /// NO despierta ninguna distro.
    fn list_distributions(&self) -> Result<Vec<Distribution>, WslError>;

    /// Resolver el home del default user de la distro (F7, SÍ despierta;
    /// solo se llama en acción explícita del usuario — W1 §2).
    /// vía `wsl -d <distro> -- getent passwd <user>` sin pipe (el campo 6 se
    /// parsea en Rust). El `<user>` se resuelve PRIMERO con
    /// `wsl -d X -- whoami` (F5), nunca se asume el user Windows (W1 §1).
    fn resolve_home(&self, distro: &str) -> Result<PathBuf, WslError>;

    /// Leer un archivo dentro de la distro (decisión paso 0: `wsl -d X --
    /// cat <path>`), con timeout por cancelación ACOTADA (nivel 1: kill del
    /// launcher + kill del PID remoto del pidfile; la distro queda Running).
    /// `--terminate` es el nivel 2, recuperación explícita del usuario.
    /// Devuelve el contenido como texto UTF-8 (lossy) — el runner
    /// reutilizable devuelve `String`, no bytes.
    fn read_file(&self, distro: &str, path: &Path) -> Result<String, WslError>;

    /// Detectar la estrategia de shell de la distro (W1 §3, "una vez"): corre
    /// `command -v bash` (F12) y devuelve `BashLogin` si existe, `ShPosix` si
    /// no. El llamador la cachea y la pasa a `run_command`.
    fn shell_strategy(&self, distro: &str) -> Result<ShellStrategy, WslError>;

    /// Ejecutar un comando en la distro con la estrategia de shell (F8/F12):
    /// `-e bash -lc` si bash existe, si no `-e sh -c`.
    /// F14 (doble frontera): el script pasado al shell es CONSTANTE del código
    /// (allowlist, p. ej. `exec "$1" "$@"`) y `args`/`env` entran como
    /// parámetros posicionales y variables del proceso, nunca interpolados en
    /// el texto del script. `env` transmite las variables de sesión
    /// (CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME) a la distro
    /// (W1 §5/§7, WSLENV/env del proceso).
    fn run_command(
        &self,
        distro: &str,
        shell: ShellStrategy,
        args: &[&str],
        env: &[(&str, &str)],
    ) -> Result<CommandOutput, WslError>;

    /// ¿Existe `program` en el PATH de la distro? (#92)
    ///
    /// `command -v` es un BUILTIN de la shell: no se puede `exec` como
    /// programa (`exec command -v …` sale con 127 en WSL real — hallazgo
    /// del lab W3, 2026-10-30) y `run_command` toma un PROGRAMA en
    /// `args[0]`. La sonda es el script constante `SCRIPT_COMMAND_V`
    /// ejecutado por la shell del entorno (bash o sh, según la estrategia)
    /// con el nombre del programa como DATO posicional (F14, doble
    /// frontera): el host nunca interpola el nombre en un script.
    ///
    /// `false` significa «la CLI no está en la distro» (código 0 con salida
    /// vacía), no un fallo de WSL: los errores del subsistema se propagan.
    fn program_available(
        &self,
        distro: &str,
        shell: ShellStrategy,
        program: &str,
    ) -> Result<bool, WslError> {
        let shell_bin = match shell {
            ShellStrategy::BashLogin => "bash",
            ShellStrategy::ShPosix => "sh",
        };
        let out = self.run_command(
            distro,
            shell,
            &[shell_bin, "-c", SCRIPT_COMMAND_V, "quorb", program],
            &[],
        )?;
        Ok(out.code == 0 && !out.stdout.trim().is_empty())
    }

    /// Diagnóstico de los 4 estados (F6) con sondas separadas.
    /// `target` es la distro elegida (si hay): permite producir
    /// `WslState::DistroUnavailable` (decisión paso 0 #3) y el detalle F2.
    /// Sin `target`, devuelve Available / WslNotInstalled / NoDistributions.
    fn diagnose(&self, target: Option<&str>) -> Result<WslDiagnostic, WslError>;

    /// RECUPERACIÓN EXPLÍCITA del usuario (nivel 2): detiene la distro
    /// completa. `--terminate` para TODO lo que corra en ella, incluidos
    /// procesos y sesiones ajenos a Quorb. Nunca como primitive automático
    /// de timeout (ese es el kill acotado por pidfile).
    fn terminate(&self, distro: &str) -> Result<(), WslError>;
}

/// Distro enumerada (`wsl --list --verbose` bajo WSL_UTF8, F1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Distribution {
    pub name: String,       // nombre de store o importado
    pub state: DistroState, // Running / Stopped
    pub version: u8,        // 1 o 2
}

/// Estado de la columna STATE de `wsl --list --verbose`. Incluye los estados
/// transitorios que WSL reporta (Installing, Converting, Uninstalling) para
/// no degradar a `UnparsableOutput` una distro legítimamente en transición.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistroState {
    Running,
    Stopped,
    Installing,
    Converting,
    Uninstalling,
}

impl Distribution {
    /// ¿Es usable para sesiones ahora mismo? (Running, o Stopped pero no en
    /// transición). Una distro Installing/Converting/Uninstalling NO lo es.
    pub fn is_usable(&self) -> bool {
        matches!(self.state, DistroState::Running | DistroState::Stopped)
    }
}

/// Constructor de distros (para tests y para el adaptador real).
pub fn distro(name: &str, state: DistroState) -> Distribution {
    Distribution {
        name: name.to_string(),
        state,
        version: 2,
    }
}

/// Estrategia de shell (W1 §3): se detecta una vez y se reutiliza.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellStrategy {
    BashLogin, // -e bash -lc  (bash existe; PATH limpio del login)
    ShPosix,   // -e sh -c     (fallback; Alpine/busybox)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslDiagnostic {
    pub state: WslState,
    /// Detalle por estado; sin tokens en UI/logs (W1 §7).
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WslState {
    Available,         // WSL + ≥1 distro
    WslNotInstalled,   // F6
    NoDistributions,   // F6
    DistroUnavailable, // elegida pero no presente (decisión paso 0 #3)
}

/// Precedencia de la ruta de credenciales (W1 §5).
///
/// 1. `credentials_path` explícito del usuario → ese path.
/// 2. Sin path explícito → el home del modo activo (en WSL, el home del
///    default user de la distro) + la ruta relativa del proveedor.
///
/// La existencia del fichero la verifica el proveedor; aquí solo se decide
/// *qué* path se usa.
/// Ruta del archivo de credenciales para la precedencia de W1 §5:
/// `credentials_path` explícito > home del modo activo de la distro.
///
/// ¿Es una ruta ABSOLUTA del guest (semántica POSIX de la distro)?
///
/// Las rutas de sesión en modo WSL se pasan al `cat` DENTRO de la distro
/// (Linux), así que la semántica de "absoluta" es la del guest (empieza
/// por `/`), NO la del host Windows: `Path::is_absolute()` en Windows
/// devolvería `false` para `/home/u/...` (no tiene prefijo de unidad) y
/// `true` para `C:\...`, justo al revés de lo que el guest entiende
/// (revisión PR #220).
fn is_guest_absolute(path: &str) -> bool {
    path.starts_with('/')
}

/// ¿La ruta lleva el separador del HOST (`\`)?
///
/// En el guest (Linux) la `\` es un carácter NORMAL del nombre de fichero,
/// no un separador: una ruta con `\`Travelaría al `cat` tal cual y buscaría
/// un fichero distinto (o inexistente). En Windows, además, `Path::join`
/// introduce `\` al componer. Por eso las rutas de sesión se componen y se
/// validan con semántica POSIX (revisión del mantenedor, 2026-11-02).
fn has_host_separator(path: &str) -> bool {
    path.contains('\\')
}

/// Ruta RELATIVA dentro del home del entorno, con separador POSIX (`/`).
///
/// NUNCA `Path::join` para rutas del guest: en Windows insertaría `\` en el
/// INTERIOR, y esa ruta viaja literal al `cat` de la distro (Linux), donde
/// `\` no separa nada — el guest buscaría otro fichero (revisión del
/// mantenedor, 2026-11-04).
pub fn guest_relative(parts: &[&str]) -> PathBuf {
    PathBuf::from(parts.join("/"))
}

/// Problema de una ruta EXPLÍCITA para el guest (modo WSL): `Some(mensaje
/// accionable)` si no es POSIX absoluta, `None` si es válida. ÚNICA fuente
/// de la regla «absoluta del guest y sin `\`» — la usan `SessionResolver::resolve`
/// (ruta de sesión pegada a mano en Ajustes), `account_session_path`
/// (`config_dir` de cuentas) y `login` (carpeta de sesión de cuentas),
/// para que los tres mensajes no diverjan (revisión del mantenedor,
/// 2026-11-06).
pub fn guest_path_problem(path: &str) -> Option<String> {
    if path.contains('\\') {
        return Some(format!(
            "La ruta en modo WSL no puede llevar separadores de Windows (\\). \
             Pega la ruta del guest (por ejemplo /home/usuario/...) en su lugar: {path}"
        ));
    }
    if !path.starts_with('/') {
        return Some(format!(
            "La ruta en modo WSL debe ser absoluta del guest (empieza por '/'), se recibió: {path}"
        ));
    }
    None
}

/// Compone `base` + `relative` con semántica POSIX (separador `/`).
///
/// `Path::join` NO sirve aquí: en Windows usa `\` como separador, y la ruta
/// compuesta viaja literal al `cat` de la distro (Linux), donde `\` no
/// separa nada. Con esta función el argumento que llega al guest es
/// siempre POSIX, también en Windows.
pub fn join_guest_path(base: &Path, relative: &Path) -> PathBuf {
    let base = base.to_string_lossy();
    let relative = relative.to_string_lossy();
    PathBuf::from(format!(
        "{}/{}",
        base.trim_end_matches('/'),
        relative.trim_start_matches('/')
    ))
}

/// En modo WSL la ruta explícita DEBE ser absoluta: `read_file` la pasa al
/// `cat` de la distro, cuyo proceso corre en el directorio de la distro
/// (F8), no en el home ni en el cwd de Windows — una ruta relativa caería
/// en un directorio dependiente del estado de la distro. (Decisión
/// declarada al owner, revisión rust 2026-10-23; Fase B valida que el
/// impl rechace la relativa como `InvalidArgument`.)
pub fn session_path(
    explicit: Option<&str>,
    mode_home: &Path,
    relative: &Path,
) -> Result<PathBuf, WslError> {
    match explicit.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            // Semántica del GUEST, no del host: la ruta se consume con
            // `cat` dentro de la distro. Un path `C:\...` (absoluto para
            // Windows) NO es válido como ruta de sesión WSL. La regla vive
            // en `guest_path_problem` (una sola fuente; revisión del
            // mantenedor, 2026-11-06).
            if let Some(problem) = guest_path_problem(p) {
                return Err(WslError::InvalidArgument(problem));
            }
            Ok(PathBuf::from(p))
        }
        None => {
            // La ruta relativa al proveedor también debe ser relativa: si
            // fuera absoluta, `join` la dejaría escapar del home del modo.
            let rel = relative.to_string_lossy();
            if is_guest_absolute(&rel) {
                return Err(WslError::InvalidArgument(format!(
                    "la ruta del proveedor dentro del modo debe ser relativa, se recibió: {rel}"
                )));
            }
            if has_host_separator(&rel) {
                return Err(WslError::InvalidArgument(format!(
                    "la ruta del proveedor dentro del modo usa separadores POSIX ('/'), se recibió: {rel}"
                )));
            }
            Ok(join_guest_path(mode_home, relative))
        }
    }
}

/// ¿Coincide el nombre configurado con el de una distro enumerada?
///
/// Comparación normalizada: trim + case-insensitive **Unicode** (no solo
/// ASCII: un nombre de distro puede llevar acentos). Es la ÚNICA regla de
/// matching del módulo — la usan el mock, el adaptador real y
/// `resolve_distro_name`, para que el mock sea un doble fiel del real.
pub fn distro_name_matches(configured: &str, actual: &str) -> bool {
    configured.trim().to_lowercase() == actual.trim().to_lowercase()
}

/// Resuelve el nombre de distro configurado contra la enumeración real (F4).
///
/// La validación NO es un whitelist de caracteres: el rechazo de
/// `wsl --import` (F3) ocurre al *crear* una distro, no al *aceptar* una que
/// ya existe. Un nombre enumerado es válido aunque tenga espacios o
/// no-ASCII. La comparación es trim + case-insensitive (Unicode).
///
/// Devuelve el nombre canónico tal y como lo reporta WSL, o `None` si no
/// aparece en la enumeración (distro borrada o renombrada). El llamador
/// conserva el valor configurado y reporta `DistroUnavailable` (decisión
/// paso 0 #3, sin fallback a native).
pub fn resolve_distro_name(configured: &str, enumerated: &[Distribution]) -> Option<String> {
    if configured.trim().is_empty() {
        return None;
    }
    enumerated
        .iter()
        .find(|d| distro_name_matches(configured, &d.name))
        .map(|d| d.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl::{distro, DistroState, MockWslAdapter, WslAdapter};

    /// W1 §5: un `credentials_path` explícito manda, con independencia del
    /// home del modo activo.
    #[test]
    fn explicit_credentials_path_wins_over_mode_home() {
        let home = PathBuf::from("/home/quorbuser");
        let explicit = session_path(
            Some("/mnt/c/Users/quorb/creds.json"),
            &home,
            Path::new(".claude/.credentials.json"),
        )
        .expect("ruta absoluta");
        assert_eq!(explicit, PathBuf::from("/mnt/c/Users/quorb/creds.json"));
    }

    /// W1 §5: sin path explícito, la ruta se compone sobre el home del modo
    /// activo (en WSL, el home del default user de la distro).
    #[test]
    fn without_explicit_path_the_mode_home_is_used() {
        let home = PathBuf::from("/home/quorbuser");
        let path = session_path(None, &home, Path::new(".claude/.credentials.json"))
            .expect("ruta del home");
        assert_eq!(
            path,
            PathBuf::from("/home/quorbuser/.claude/.credentials.json")
        );
    }

    /// W1 §5: un path explícito en blanco se trata como ausente (no como una
    /// ruta vacía).
    #[test]
    fn blank_explicit_path_falls_back_to_mode_home() {
        let home = PathBuf::from("/home/quorbuser");
        let path =
            session_path(Some("   "), &home, Path::new(".codex/auth.json")).expect("ruta del home");
        assert_eq!(path, PathBuf::from("/home/quorbuser/.codex/auth.json"));
    }

    /// M-2: en modo WSL una ruta explícita RELATIVA se rechaza — el `cat` de
    /// la distro corre en el directorio de la distro (F8), no en el home.
    #[test]
    fn relative_explicit_path_is_rejected() {
        let home = PathBuf::from("/home/quorbuser");
        let err = session_path(Some("creds.json"), &home, Path::new(".codex/auth.json"))
            .expect_err("ruta relativa");
        assert!(matches!(err, WslError::InvalidArgument(_)));
    }

    /// La semántica de "absoluta" es la del GUEST (POSIX): una ruta de
    /// Windows `C:\...` (absoluta para el host) NO es una ruta de sesión
    /// WSL válida, porque `cat` corre dentro de la distro. Antes esto
    /// pasaba `Path::is_absolute()` en Windows (revisión PR #220).
    #[test]
    fn windows_path_is_rejected_as_guest_relative() {
        let home = PathBuf::from("/home/quorbuser");
        let err = session_path(
            Some("C:\\Users\\quorb\\creds.json"),
            &home,
            Path::new(".claude/auth.json"),
        )
        .expect_err("ruta Windows en modo WSL");
        assert!(matches!(err, WslError::InvalidArgument(_)));
    }

    /// Un path del guest sin prefijo de unidad (`/etc/passwd`) es
    /// ABSOLUTO para la distro y debe rechazarse como ruta relativa del
    /// proveedor — aunque en Windows `Path::is_absolute()` diga lo
    /// contrario (revisión PR #220: semántica del guest, no del host).
    #[test]
    fn guest_absolute_provider_relative_is_rejected_even_on_windows() {
        let home = PathBuf::from("/home/quorbuser");
        let err = session_path(None, &home, Path::new("/etc/passwd"))
            .expect_err("ruta absoluta del guest como relativa del proveedor");
        assert!(matches!(err, WslError::InvalidArgument(_)));
    }

    /// Las rutas de sesión del guest se componen con `/` SIEMPRE, también en
    /// Windows: el argumento que llega al `cat` de la distro no puede
    /// llevar `\` (allí es un carácter normal, no un separador). Este test
    /// falla si `session_path` vuelve a usar `Path::join` (revisión del
    /// mantenedor, 2026-11-02).
    #[test]
    fn composed_session_paths_are_posix_on_every_platform() {
        let home = PathBuf::from("/home/quorbuser");
        for (relative, expected) in [
            (
                ".claude/.credentials.json",
                "/home/quorbuser/.claude/.credentials.json",
            ),
            (".codex/auth.json", "/home/quorbuser/.codex/auth.json"),
            (
                ".gemini/oauth_creds.json",
                "/home/quorbuser/.gemini/oauth_creds.json",
            ),
            (".grok/auth.json", "/home/quorbuser/.grok/auth.json"),
        ] {
            let p = session_path(None, &home, Path::new(relative)).expect("ruta del home");
            let s = p.to_string_lossy().replace('\\', "/");
            assert_eq!(s, expected);
            assert!(
                !p.to_string_lossy().contains('\\'),
                "el argumento al guest no puede llevar separadores del host: {p:?}"
            );
        }
        // El path explícito también llega POSIX.
        let explicit = session_path(
            Some("/mnt/c/a b/c.json"),
            &home,
            Path::new(".codex/auth.json"),
        )
        .expect("explícita");
        let s = explicit.to_string_lossy().replace('\\', "/");
        assert_eq!(s, "/mnt/c/a b/c.json");
        assert!(!explicit.to_string_lossy().contains('\\'));
    }

    /// En modo WSL un `\` en la ruta EXPLÍCITA o en la relativa se rechaza:
    /// llegarían al guest como caracteres normales y apuntarían a otro
    /// fichero (o a ninguno). Es semántica POSIX, no un fallo silencioso.
    #[test]
    fn host_separators_in_session_paths_are_rejected() {
        let home = PathBuf::from("/home/quorbuser");
        let err = session_path(
            Some("/mnt/c/Users/yo\\config"),
            &home,
            Path::new(".codex/auth.json"),
        )
        .expect_err("backslash en la explícita");
        assert!(matches!(err, WslError::InvalidArgument(_)));
        let err = session_path(None, &home, Path::new(".codex\\auth.json"))
            .expect_err("backslash en la relativa");
        assert!(matches!(err, WslError::InvalidArgument(_)));
    }

    /// M6: la ruta relativa al proveedor también debe ser relativa — un
    /// path absoluto escaparía del home del modo por `join`.
    #[test]
    fn absolute_provider_relative_is_rejected() {
        let home = PathBuf::from("/home/quorbuser");
        let err = session_path(None, &home, Path::new("/etc/passwd"))
            .expect_err("ruta absoluta del proveedor");
        assert!(matches!(err, WslError::InvalidArgument(_)));
    }

    /// W1 §5 completo: precedencia `credentials_path` > home de la distro >
    /// ruta del proveedor, componiendo con el adaptador (home resuelto con
    /// el mock, sin procesos).
    #[test]
    fn session_path_composes_with_the_resolved_distro_home() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Stopped)]);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/quorbuser"));
        let home = mock.resolve_home("Ubuntu-22.04").expect("home");
        let path = session_path(None, &home, Path::new(".gemini/oauth_creds.json"))
            .expect("ruta del home");
        assert_eq!(
            path,
            PathBuf::from("/home/quorbuser/.gemini/oauth_creds.json")
        );
    }

    /// W1 §6 / decisión del owner (punto 2): un nombre enumerado con
    /// espacios es VÁLIDO — el rechazo de `wsl --import` es al crear
    /// distros, no al aceptar las que ya existen. Los nombres de store
    /// habituales se resuelven contra su forma canónica.
    #[test]
    fn enumerated_names_with_spaces_are_valid_and_store_names_resolve() {
        let enumerated = vec![
            distro("Ubuntu-22.04", DistroState::Stopped),
            distro("Debian", DistroState::Stopped),
            distro("kali-linux", DistroState::Stopped),
            distro("Hello World", DistroState::Stopped),
        ];
        assert_eq!(
            resolve_distro_name("Hello World", &enumerated).as_deref(),
            Some("Hello World")
        );
        assert_eq!(
            resolve_distro_name("Ubuntu-22.04", &enumerated).as_deref(),
            Some("Ubuntu-22.04")
        );
        assert_eq!(
            resolve_distro_name("Debian", &enumerated).as_deref(),
            Some("Debian")
        );
        assert_eq!(
            resolve_distro_name("kali-linux", &enumerated).as_deref(),
            Some("kali-linux")
        );
    }

    /// W1 §6: un nombre NO enumerado (borrada, renombrada o legacy que hoy
    /// se rechazaría) no se resuelve a otra distro ni a native: devuelve
    /// None y el llamador conserva el valor y reporta `DistroUnavailable`.
    #[test]
    fn unknown_name_resolves_to_nothing_without_fallback() {
        let enumerated = vec![distro("Ubuntu-22.04", DistroState::Stopped)];
        assert_eq!(resolve_distro_name("Quorb-Pgone", &enumerated), None);
        assert_eq!(resolve_distro_name("   ", &enumerated), None);
        assert_eq!(resolve_distro_name("", &enumerated), None);
    }

    /// `guest_relative` compone con `/` en cualquier plataforma (el
    /// `Path::join` de Windows introduciría `\` en el interior; revisión del
    /// mantenedor, 2026-11-04).
    #[test]
    fn guest_relative_uses_posix_separators_on_every_platform() {
        let p = guest_relative(&[".claude", ".credentials.json"]);
        assert_eq!(p.to_string_lossy(), ".claude/.credentials.json");
        assert!(!p.to_string_lossy().contains('\\'));
        let nested = guest_relative(&[".quorb", ".gemini/oauth_creds.json"]);
        assert_eq!(nested.to_string_lossy(), ".quorb/.gemini/oauth_creds.json");
        assert!(!nested.to_string_lossy().contains('\\'));
    }

    /// El home se cachea por distro y se invalida SOLO al cambiar la distro
    /// activa (revisión del mantenedor, 2026-11-02): `session_stamp` se
    /// consulta cada 15 s y no debe lanzar `resolve_home` (dos procesos
    /// wsl.exe) por cada tick.
    #[test]
    fn home_cache_resolves_once_and_invalidates_on_distro_change() {
        let cache = WslHomeCache::default();
        assert_eq!(cache.home_for("Ubuntu-22.04"), None);
        cache.insert("Ubuntu-22.04", PathBuf::from("/home/u1"));
        assert_eq!(
            cache.home_for("Ubuntu-22.04").as_deref(),
            Some(Path::new("/home/u1"))
        );
        // Cambio de distro configurada: se descarta lo cacheado.
        assert_eq!(cache.home_for("Debian"), None);
        cache.insert("Debian", PathBuf::from("/home/u2"));
        assert_eq!(
            cache.home_for("Debian").as_deref(),
            Some(Path::new("/home/u2"))
        );
        // La distro anterior quedó invalidada al cambiar.
        assert_eq!(cache.home_for("Ubuntu-22.04"), None);
    }

    /// La comparación contra la enumeración es trim + case-insensitive, y
    /// devuelve el nombre canónico tal como lo reporta WSL.
    #[test]
    fn distro_name_matching_is_trimmed_and_case_insensitive() {
        let enumerated = vec![distro("Ubuntu-22.04", DistroState::Stopped)];
        assert_eq!(
            resolve_distro_name("  ubuntu-22.04 ", &enumerated).as_deref(),
            Some("Ubuntu-22.04")
        );
    }
}
