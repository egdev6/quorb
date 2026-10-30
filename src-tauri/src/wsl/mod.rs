//! Adaptador WSL — contrato inyectable para el modo `wsl/<distro>`.
//!
//! **Fase A** (issue #90, `quorb-wsl-v1`): solo el contrato y un mock
//! determinista. La implementación real (`RealWslAdapter`, procesos
//! `wsl.exe`) es Fase B.
//!
//! Decisiones del paso 0: `ADR-W2.md`. Contrato firmado: `W2-WSLADAPTER.md`.

pub use crate::cli_process::{CommandOutput, RunError};
use std::path::{Path, PathBuf};

mod errors;
mod mock;
mod process;
mod real;
pub use mock::{MockWslAdapter, WslCall};
pub use real::{build_wslenv_entry, RealWslAdapter, SESSION_ENV_ALLOWLIST};

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
            let path = PathBuf::from(p);
            if !path.is_absolute() {
                return Err(WslError::InvalidArgument(format!(
                    "credentials_path en modo WSL debe ser absoluto, se recibió: {p}"
                )));
            }
            Ok(path)
        }
        None => {
            // La ruta relativa al proveedor también debe ser relativa: si
            // fuera absoluta, `join` la dejaría escapar del home del modo.
            if relative.is_absolute() {
                return Err(WslError::InvalidArgument(format!(
                    "la ruta del proveedor dentro del modo debe ser relativa, se recibió: {}",
                    relative.display()
                )));
            }
            Ok(mode_home.join(relative))
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
