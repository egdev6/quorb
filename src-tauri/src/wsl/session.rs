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
use std::sync::Arc;

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
///
/// El adaptador va en un `Arc` (y no prestado) para que la lectura pueda
///derivarse a un hilo propio (`read_async`): en modo WSL cada lectura
/// espera a `wsl.exe`, y bloquear el executor async congelaría el widget
/// (revisión PR #220).
#[derive(Clone)]
pub struct SessionResolver {
    env: SessionEnv,
    adapter: Arc<dyn WslAdapter>,
    /// Home del entorno elegido: el del host, o el del usuario de la distro.
    home: PathBuf,
}

impl SessionResolver {
    /// `home` es el home del entorno: el del host en modo host, o el del
    /// usuario por defecto de la distro (lo resuelve `resolve_home`).
    pub fn new(env: SessionEnv, adapter: Arc<dyn WslAdapter>, home: PathBuf) -> Self {
        SessionResolver { env, adapter, home }
    }

    /// Resolvedor del entorno host: lee del disco local con el home del host.
    /// El `adapter` no se usa en este modo (queda por si el entorno cambia).
    pub fn for_host(adapter: Arc<dyn WslAdapter>, home: PathBuf) -> Self {
        SessionResolver::new(SessionEnv::Host, adapter, home)
    }

    /// Resolvedor de la distro elegida (#91): la sesión se resuelve y se lee
    /// DENTRO de la distro, con `read_file` del adaptador (`wsl cat`).
    ///
    /// `home` es el home del default user de la distro, ya resuelto por
    /// `resolve_home` (F7): este constructor no hace I/O, así que puede
    /// fallar quien lo llama con un mensaje acorde al contexto (la UI, la
    /// línea de comandos) en vez de un error genérico de WSL.
    pub fn for_wsl(adapter: Arc<dyn WslAdapter>, distro: String, home: PathBuf) -> Self {
        SessionResolver::new(SessionEnv::Wsl { distro }, adapter, home)
    }

    /// El home del entorno elegido.
    pub fn home(&self) -> &Path {
        &self.home
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

    /// La ruta estándar del proveedor bajo el home del entorno elegido.
    ///
    /// `relative` es la ruta relativa del proveedor (`.claude/.credentials.json`,
    /// `.codex/auth.json`, `.gemini/oauth_creds.json`): la misma que se usa
    /// hoy contra el home del host, pero compuesta sobre el home del
    /// entorno activo (el del usuario Linux cuando el entorno es WSL).
    pub fn default_path(&self, relative: &Path) -> PathBuf {
        self.home.join(relative)
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

    /// Lectura sin bloquear el executor async.
    ///
    /// En modo WSL la lectura espera a `wsl.exe` (hasta 20 s de presupuesto);
    /// hacerla en el hilo del executor congelaría el widget y las demás
    /// tareas async (revisión PR #220). Aquí la operación corre en un hilo
    /// propio y el error del hilo se distingue del de la sesión.
    pub async fn read_async(&self, path: &Path) -> Result<String, SessionError> {
        let me = self.clone();
        let path = path.to_path_buf();
        // El path entra (por `move`) en el hilo propio; el mensaje de error se
        // formatea antes para no usarlo después del move.
        let display = path.display().to_string();
        match tokio::task::spawn_blocking(move || me.read(&path)).await {
            Ok(result) => result,
            Err(e) => Err(SessionError::Unreadable(format!(
                "No puedo leer {display}: {e}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl::MockWslAdapter;

    #[test]
    fn host_resolver_reads_from_the_local_disk() {
        let mock = Arc::new(MockWslAdapter::new());
        let r = SessionResolver::new(
            SessionEnv::Host,
            mock.clone(),
            PathBuf::from("/home/hostuser"),
        );
        let f = std::env::temp_dir().join("quorb-session-host-test.json");
        std::fs::write(&f, b"{}").expect("escribe fixture");
        assert_eq!(r.read(&f).expect("lee"), "{}");
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn host_resolver_reports_absent_when_there_is_no_file() {
        let mock = Arc::new(MockWslAdapter::new());
        let r = SessionResolver::new(
            SessionEnv::Host,
            mock.clone(),
            PathBuf::from("/home/hostuser"),
        );
        let missing = PathBuf::from("/no/existe/quorb-creds.json");
        assert!(matches!(r.read(&missing), Err(SessionError::Absent(_))));
    }

    /// #91 (camino 1): el MISMO path significa dos cosas según el entorno — en
    /// la distro se lee el fichero de la distro, en el host el del host. Las
    /// cuentas de un entorno nunca se mezclan con las del otro.
    #[test]
    fn the_same_path_resolves_to_the_environment_it_belongs_to() {
        let mock = Arc::new(MockWslAdapter::new());
        let path = std::env::temp_dir().join("quorb-session-env-path.json");
        std::fs::write(&path, b"{\"origen\":\"host\"}").expect("escribe fixture");
        mock.set_file(
            "Ubuntu-22.04",
            path.clone(),
            "{\"origen\":\"distro\"}".to_string(),
        );

        let host = SessionResolver::for_host(mock.clone(), PathBuf::from("/home/hostuser"));
        assert_eq!(host.read(&path).expect("lee host"), "{\"origen\":\"host\"}");

        let wsl = SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
        );
        assert_eq!(
            wsl.read(&path).expect("lee distro"),
            "{\"origen\":\"distro\"}"
        );

        std::fs::remove_file(&path).ok();
    }

    /// La ruta por defecto se compone sobre el home del ENTORNO: el del
    /// usuario de la distro en WSL, el del host en host.
    #[test]
    fn default_path_is_composed_over_the_environment_home() {
        let mock = Arc::new(MockWslAdapter::new());
        let wsl = SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
        );
        assert_eq!(
            wsl.default_path(Path::new(".claude").join(".credentials.json").as_path()),
            PathBuf::from("/home/user/.claude/.credentials.json")
        );
        let host = SessionResolver::for_host(mock.clone(), PathBuf::from("/home/hostuser"));
        assert_eq!(
            host.default_path(Path::new(".codex").join("auth.json").as_path()),
            PathBuf::from("/home/hostuser/.codex/auth.json")
        );
    }

    #[test]
    fn wsl_resolver_reads_through_the_adapter() {
        let mock = Arc::new(MockWslAdapter::new());
        mock.set_file(
            "Ubuntu-22.04",
            PathBuf::from("/home/user/.claude/.credentials.json"),
            "{\"creds\":true}".to_string(),
        );
        let r = SessionResolver::new(
            SessionEnv::Wsl {
                distro: "Ubuntu-22.04".into(),
            },
            mock.clone(),
            PathBuf::from("/home/user"),
        );
        let contents = r
            .read(Path::new("/home/user/.claude/.credentials.json"))
            .expect("lee en la distro");
        assert_eq!(contents, "{\"creds\":true}");
    }

    #[test]
    fn wsl_resolver_reports_absent_when_file_is_missing_in_the_distro() {
        let mock = Arc::new(MockWslAdapter::new());
        mock.set_file(
            "Ubuntu-22.04",
            PathBuf::from("/home/user/.codex/auth.json"),
            "{}".to_string(),
        );
        let r = SessionResolver::new(
            SessionEnv::Wsl {
                distro: "Ubuntu-22.04".into(),
            },
            mock.clone(),
            PathBuf::from("/home/user"),
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
        let mock = Arc::new(MockWslAdapter::new());
        // WSL no está instalado: el fallo es del subsistema, no de la sesión.
        mock.set_installed(false);
        let r = SessionResolver::new(
            SessionEnv::Wsl {
                distro: "Ubuntu-22.04".into(),
            },
            mock.clone(),
            PathBuf::from("/home/user"),
        );
        let err = r
            .read(Path::new("/home/user/.claude/.credentials.json"))
            .unwrap_err();
        assert!(matches!(err, SessionError::Wsl(WslError::WslNotInstalled)));
    }

    #[test]
    fn explicit_path_wins_over_the_default() {
        let mock = Arc::new(MockWslAdapter::new());
        let r = SessionResolver::new(
            SessionEnv::Host,
            mock.clone(),
            PathBuf::from("/home/hostuser"),
        );
        let p = r.resolve(
            Some("C:\\Users\\u\\custom.json"),
            Path::new("/home/u/default.json"),
        );
        assert_eq!(p, PathBuf::from("C:\\Users\\u\\custom.json"));
    }

    #[test]
    fn blank_explicit_path_falls_back_to_the_default() {
        let mock = Arc::new(MockWslAdapter::new());
        let r = SessionResolver::new(
            SessionEnv::Host,
            mock.clone(),
            PathBuf::from("/home/hostuser"),
        );
        let p = r.resolve(Some("   "), Path::new("/home/u/default.json"));
        assert_eq!(p, PathBuf::from("/home/u/default.json"));
    }

    /// La lectura asíncrona devuelve lo mismo que la síncrona: en WSL espera
    /// a `wsl.exe`, y lo hace en un hilo propio para no congelar el
    /// executor (revisión PR #220).
    #[test]
    fn read_async_returns_the_same_content_as_read() {
        let mock = Arc::new(MockWslAdapter::new());
        mock.set_file(
            "Ubuntu-22.04",
            PathBuf::from("/home/user/.claude/.credentials.json"),
            "{\"creds\":true}".to_string(),
        );
        let r = SessionResolver::for_wsl(
            mock.clone(),
            "Ubuntu-22.04".into(),
            PathBuf::from("/home/user"),
        );
        let path = PathBuf::from("/home/user/.claude/.credentials.json");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime de un hilo");
        let contents = rt.block_on(r.read_async(&path)).expect("lee en la distro");
        assert_eq!(contents, "{\"creds\":true}");
    }
}
