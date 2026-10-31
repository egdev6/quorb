//! Resolución de sesiones de los proveedores en el entorno elegido (#91).
//!
//! En modo WSL las credenciales de Codex, Gemini y Claude viven **dentro de
//! la distro** (`.codex/auth.json`, `.gemini/oauth_creds.json`,
//! `.claude/.credentials.json` bajo el home del usuario Linux), no en el home
//! de Windows. Este módulo es el puente: sabe **dónde** está la sesión según
//! el entorno y **cómo** se lee, sin que los proveedores conozcan WSL.
//!
//! Reglas del contrato de sesiones (#91):
//! - La ruta explícita tiene prioridad y su origen efectivo se expone; una
//!   ruta inválida es un error sin fallback oculto.
//! - Sin credenciales en el entorno elegido, jamás se usa silenciosamente una
//!   cuenta de otro entorno (Windows, otra distro).
//! - Las cuentas principal/adicional conservan el aislamiento que ya tienen:
//!   resolver una no pisa los ficheros de otra.
//! - Lectura y login comparten este mismo contrato de entorno/carpeta.
//! - No se copian tokens: WSL lee el fichero en su casa, Windows lo lee del
//!   disco; ninguno importa el valor a otro lado.

use super::{WslAdapter, WslError};
use std::path::{Path, PathBuf};

/// El entorno en el que se resuelve la sesión de un proveedor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEnv {
    /// El host: Windows (o macOS) usa el home local, como hoy.
    Host,
    /// La distro WSL elegida: la sesión se resuelve y se lee dentro de ella.
    Wsl { distro: String },
}

/// Error de resolución de una sesión, recuperable por el llamador.
///
/// Distingue lo que la UI y el diagnóstico necesitan (#91):
/// - `Absent`: no hay credenciales (necesita login).
/// - `Unreadable`: existen pero no se pueden leer (permisos, WSL roto).
/// - `Invalid`: se leyeron pero no son JSON/sesión válida.
/// - `Wsl`: el fallo es del subsistema o la distro (no de las credenciales).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// No hay credenciales en el entorno elegido.
    Absent(String),
    /// Las credenciales existen pero no se pudieron leer.
    Unreadable(String),
    /// Se leyeron pero no se pudieron interpretar.
    Invalid(String),
    /// El subsistema WSL o la distro fallaron (no es un problema de sesión).
    Wsl(WslError),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Absent(m) => write!(f, "{m}"),
            SessionError::Unreadable(m) => write!(f, "{m}"),
            SessionError::Invalid(m) => write!(f, "{m}"),
            SessionError::Wsl(e) => write!(f, "WSL: {e:?}"),
        }
    }
}

/// Un resolvedor de sesiones: el entorno y cómo leer dentro de él.
///
/// `adapter` es el doble de `RealWslAdapter` en los tests (o el real en
/// producción); `read_file` del trait es `wsl cat -- path` con cancelación
/// acotada. Para `Host` no se usa WSL: la lectura es del disco local.
pub struct SessionResolver<'a> {
    env: SessionEnv,
    adapter: &'a dyn WslAdapter,
}

impl<'a> SessionResolver<'a> {
    pub fn new(env: SessionEnv, adapter: &'a dyn WslAdapter) -> Self {
        SessionResolver { env, adapter }
    }

    /// La ruta de la sesión, con la precedencia de la #91: explícita > default.
    ///
    /// `explicit` es `credentials_path` de la config del proveedor (si lo hay);
    /// `default` es la ruta estándar del entorno (`~/.claude/.credentials.json`
    /// bajo el home del usuario Linux, o el del host).
    ///
    /// No cae a otro entorno: si la ruta explícita no existe o la default del
    /// entorno elegido no está, es `Absent` — nunca se busca en Windows cuando
    /// el entorno es WSL ni al revés.
    pub fn resolve(&self, explicit: Option<&str>, default: &Path) -> PathBuf {
        match explicit.map(str::trim).filter(|s| !s.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => default.to_path_buf(),
        }
    }

    /// Lee el contenido de la sesión en el entorno elegido.
    ///
    /// Devuelve `Absent` si el fichero no existe (o no se pudo determinar),
    /// `Unreadable` si existe pero no se lee, y `Wsl` si el fallo es del
    /// subsistema o de la distro — el llamador decide la acción correcta
    /// (pedir login, avisar de WSL, etc.).
    pub fn read(&self, path: &Path) -> Result<String, SessionError> {
        match &self.env {
            SessionEnv::Host => {
                if !path.is_file() {
                    return Err(SessionError::Absent(format!(
                        "No encuentro credenciales en {}",
                        path.display()
                    )));
                }
                std::fs::read_to_string(path).map_err(|e| {
                    SessionError::Unreadable(format!("No puedo leer {}: {e}", path.display()))
                })
            }
            SessionEnv::Wsl { distro } => match self.adapter.read_file(distro, path) {
                Ok(contents) => Ok(contents),
                // El fichero no existe en la distro: es un "necesita login",
                // no un fallo de WSL.
                Err(WslError::FileNotFound(_)) => Err(SessionError::Absent(format!(
                    "No encuentro credenciales en {distro}: {}",
                    path.display()
                ))),
                // Distro desconocida / WSL sin instalar: el fallo es del
                // subsistema, y la acción correcta es distinta de "login".
                Err(e) => Err(SessionError::Wsl(e)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl::MockWslAdapter;

    #[test]
    fn host_resolver_reads_from_the_local_disk() {
        let mock = MockWslAdapter::new();
        let r = SessionResolver::new(SessionEnv::Host, &mock);
        let f = std::env::temp_dir().join("quorb-session-host-test.json");
        std::fs::write(&f, b"{}").expect("escribe fixture");
        assert_eq!(r.read(&f).expect("lee"), "{}");
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn host_resolver_reports_absent_when_there_is_no_file() {
        let mock = MockWslAdapter::new();
        let r = SessionResolver::new(SessionEnv::Host, &mock);
        let missing = PathBuf::from("/no/existe/quorb-creds.json");
        assert!(matches!(r.read(&missing), Err(SessionError::Absent(_))));
    }

    #[test]
    fn wsl_resolver_reads_through_the_adapter() {
        let mock = MockWslAdapter::new();
        mock.set_file(
            "Ubuntu-22.04",
            PathBuf::from("/home/user/.claude/.credentials.json"),
            "{\"creds\":true}".to_string(),
        );
        let r = SessionResolver::new(
            SessionEnv::Wsl {
                distro: "Ubuntu-22.04".into(),
            },
            &mock,
        );
        let contents = r
            .read(Path::new("/home/user/.claude/.credentials.json"))
            .expect("lee en la distro");
        assert_eq!(contents, "{\"creds\":true}");
    }

    #[test]
    fn wsl_resolver_reports_absent_when_file_is_missing_in_the_distro() {
        let mock = MockWslAdapter::new();
        mock.set_file(
            "Ubuntu-22.04",
            PathBuf::from("/home/user/.codex/auth.json"),
            "{}".to_string(),
        );
        let r = SessionResolver::new(
            SessionEnv::Wsl {
                distro: "Ubuntu-22.04".into(),
            },
            &mock,
        );
        // El fichero de Claude no está en la distro: "necesita login", no
        // un fallo de WSL.
        let err = r
            .read(Path::new("/home/user/.claude/.credentials.json"))
            .unwrap_err();
        assert!(matches!(err, SessionError::Absent(_)));
    }

    #[test]
    fn wsl_resolver_propagates_subsystem_failure_as_wsl_error() {
        let mock = MockWslAdapter::new();
        // WSL no está instalado: el fallo es del subsistema, no de la sesión.
        mock.set_installed(false);
        let r = SessionResolver::new(
            SessionEnv::Wsl {
                distro: "Ubuntu-22.04".into(),
            },
            &mock,
        );
        let err = r
            .read(Path::new("/home/user/.claude/.credentials.json"))
            .unwrap_err();
        assert!(matches!(err, SessionError::Wsl(WslError::WslNotInstalled)));
    }

    #[test]
    fn explicit_path_wins_over_the_default() {
        let mock = MockWslAdapter::new();
        let r = SessionResolver::new(SessionEnv::Host, &mock);
        let p = r.resolve(
            Some("C:\\Users\\u\\custom.json"),
            Path::new("/home/u/default.json"),
        );
        assert_eq!(p, PathBuf::from("C:\\Users\\u\\custom.json"));
    }

    #[test]
    fn blank_explicit_path_falls_back_to_the_default() {
        let mock = MockWslAdapter::new();
        let r = SessionResolver::new(SessionEnv::Host, &mock);
        let p = r.resolve(Some("   "), Path::new("/home/u/default.json"));
        assert_eq!(p, PathBuf::from("/home/u/default.json"));
    }
}
