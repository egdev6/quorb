//! Mock determinista del `WslAdapter` (Fase A).
//!
//! Sustituye a `wsl.exe` por completo: no hay procesos, no hay red y no se
//! toca el disco. Cada estado de la app se programa explícitamente y las
//! llamadas quedan registradas, así que los tests de W1 §5/§6/§7 son
//! deterministas y no dependen de que haya WSL en la máquina.

use super::{Distribution, ShellStrategy, WslAdapter, WslDiagnostic, WslError, WslState};
use crate::cli_process::CommandOutput;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Llamada registrada por el mock. Permite comprobar qué-operaciones
/// hizo la app (p. ej. que enumerar NO ejecuta comandos: F4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WslCall {
    ListDistributions,
    ResolveHome(String),
    ReadFile(String, PathBuf),
    ShellStrategy(String),
    RunCommand(String, Vec<String>),
    Diagnose(Option<String>),
    Terminate(String),
}

#[derive(Debug, Clone, Default)]
struct MockState {
    installed: bool,
    distributions: Vec<Distribution>,
    homes: BTreeMap<String, PathBuf>,
    shells: BTreeMap<String, ShellStrategy>,
    files: BTreeMap<(String, PathBuf), String>,
    command_output: Option<CommandOutput>,
    failure: Option<WslError>,
    calls: Vec<WslCall>,
}

/// Adaptador simulado. El estado se configura por métodos (con
/// mutabilidad interior: el trait usa `&self`) y se lee con `calls()`.
#[derive(Debug, Default)]
pub struct MockWslAdapter {
    state: Mutex<MockState>,
}

impl MockWslAdapter {
    /// Mock con WSL instalado y sin distros: el punto de partida habitual.
    pub fn new() -> Self {
        MockWslAdapter {
            state: Mutex::new(MockState {
                installed: true,
                ..MockState::default()
            }),
        }
    }

    /// ¿Está WSL instalado? (F6: `wsl --version`).
    pub fn set_installed(&self, installed: bool) {
        self.with(|s| s.installed = installed);
    }

    /// Distros que devuelve la enumeración (F4).
    pub fn set_distributions(&self, distributions: Vec<Distribution>) {
        self.with(|s| s.distributions = distributions);
    }

    /// Home del default user de una distro (F5/F7).
    pub fn set_home(&self, distro: &str, home: PathBuf) {
        self.with(|s| s.homes.insert(distro.to_string(), home));
    }

    /// Estrategia de shell detectada para una distro (F8/F12).
    pub fn set_shell(&self, distro: &str, shell: ShellStrategy) {
        self.with(|s| s.shells.insert(distro.to_string(), shell));
    }

    /// Contenido de un archivo dentro de la distro.
    pub fn set_file(&self, distro: &str, path: PathBuf, content: String) {
        self.with(|s| s.files.insert((distro.to_string(), path), content));
    }

    /// Salida que devuelve cualquier `run_command`.
    pub fn set_command_output(&self, output: CommandOutput) {
        self.with(|s| s.command_output = Some(output));
    }

    /// Fuerza un error en cualquier operación (timeout, distro ausente…).
    pub fn set_failure(&self, failure: WslError) {
        self.with(|s| s.failure = Some(failure.clone()));
    }

    /// Llamadas registradas, en orden.
    pub fn calls(&self) -> Vec<WslCall> {
        self.with(|s| s.calls.clone())
    }

    fn with<T>(&self, f: impl FnOnce(&mut MockState) -> T) -> T {
        let mut guard = self.state.lock().unwrap();
        f(&mut guard)
    }

    /// ¿La distro aparece en la enumeración? (sin contar el fallo forzado).
    fn is_enumerated(state: &MockState, distro: &str) -> bool {
        state
            .distributions
            .iter()
            .any(|d| super::distro_name_matches(distro, &d.name))
    }
}

impl WslAdapter for MockWslAdapter {
    fn list_distributions(&self) -> Result<Vec<Distribution>, WslError> {
        self.with(|s| {
            s.calls.push(WslCall::ListDistributions);
            if let Some(err) = &s.failure {
                return Err(err.clone());
            }
            if !s.installed {
                return Err(WslError::WslNotInstalled);
            }
            Ok(s.distributions.clone())
        })
    }

    fn resolve_home(&self, distro: &str) -> Result<PathBuf, WslError> {
        self.with(|s| {
            s.calls.push(WslCall::ResolveHome(distro.to_string()));
            if let Some(err) = &s.failure {
                return Err(err.clone());
            }
            if !s.installed {
                return Err(WslError::WslNotInstalled);
            }
            match s.homes.get(distro) {
                Some(home) => Ok(home.clone()),
                None => Err(WslError::DistroNotFound(distro.to_string())),
            }
        })
    }

    fn read_file(&self, distro: &str, path: &Path) -> Result<String, WslError> {
        self.with(|s| {
            s.calls
                .push(WslCall::ReadFile(distro.to_string(), path.to_path_buf()));
            if let Some(err) = &s.failure {
                return Err(err.clone());
            }
            if !s.installed {
                return Err(WslError::WslNotInstalled);
            }
            match s.files.get(&(distro.to_string(), path.to_path_buf())) {
                Some(content) => Ok(content.clone()),
                None => Err(WslError::FileNotFound(path.display().to_string())),
            }
        })
    }

    fn shell_strategy(&self, distro: &str) -> Result<ShellStrategy, WslError> {
        self.with(|s| {
            s.calls.push(WslCall::ShellStrategy(distro.to_string()));
            if let Some(err) = &s.failure {
                return Err(err.clone());
            }
            if !s.installed {
                return Err(WslError::WslNotInstalled);
            }
            match s.shells.get(distro) {
                Some(shell) => Ok(*shell),
                None => Err(WslError::DistroNotFound(distro.to_string())),
            }
        })
    }

    fn run_command(
        &self,
        distro: &str,
        _shell: ShellStrategy,
        args: &[&str],
        _env: &[(&str, &str)],
    ) -> Result<CommandOutput, WslError> {
        self.with(|s| {
            s.calls.push(WslCall::RunCommand(
                distro.to_string(),
                args.iter().map(|a| a.to_string()).collect(),
            ));
            if let Some(err) = &s.failure {
                return Err(err.clone());
            }
            if !s.installed {
                return Err(WslError::WslNotInstalled);
            }
            Ok(s.command_output.clone().unwrap_or(CommandOutput {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            }))
        })
    }

    fn diagnose(&self, target: Option<&str>) -> Result<WslDiagnostic, WslError> {
        self.with(|s| {
            s.calls.push(WslCall::Diagnose(target.map(str::to_string)));
            if let Some(err) = &s.failure {
                return Err(err.clone());
            }
            if !s.installed {
                return Ok(WslDiagnostic {
                    state: WslState::WslNotInstalled,
                    detail: None,
                });
            }
            if s.distributions.is_empty() {
                return Ok(WslDiagnostic {
                    state: WslState::NoDistributions,
                    detail: None,
                });
            }
            match target {
                Some(name) if !MockWslAdapter::is_enumerated(s, name) => Ok(WslDiagnostic {
                    state: WslState::DistroUnavailable,
                    detail: Some(format!(
                        "la distro configurada no aparece en la enumeración; disponibles: {}",
                        s.distributions
                            .iter()
                            .map(|d| d.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )),
                }),
                _ => Ok(WslDiagnostic {
                    state: WslState::Available,
                    detail: None,
                }),
            }
        })
    }

    fn terminate(&self, distro: &str) -> Result<(), WslError> {
        self.with(|s| {
            s.calls.push(WslCall::Terminate(distro.to_string()));
            if let Some(err) = &s.failure {
                return Err(err.clone());
            }
            if !s.installed {
                return Err(WslError::WslNotInstalled);
            }
            if MockWslAdapter::is_enumerated(s, distro) {
                Ok(())
            } else {
                Err(WslError::DistroNotFound(distro.to_string()))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl::{distro, DistroState};
    use std::path::PathBuf;

    fn mock_with_distros(names: &[&str]) -> MockWslAdapter {
        let mock = MockWslAdapter::new();
        mock.set_distributions(
            names
                .iter()
                .map(|n| distro(n, DistroState::Stopped))
                .collect(),
        );
        mock
    }

    /// F4: enumerar NO despierta ninguna distro → el mock no registra
    /// ninguna ejecución de comandos, solo la propia enumeración.
    #[test]
    fn list_distributions_does_not_run_any_command() {
        let mock = mock_with_distros(&["Ubuntu-22.04", "Debian"]);
        let distros = mock.list_distributions().expect("enumeración");
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "Ubuntu-22.04");
        assert_eq!(
            mock.calls(),
            vec![WslCall::ListDistributions],
            "enumerar no debe ejecutar ningún comando en la distro"
        );
    }

    /// F7: resolver home es una operación DISTINTA de enumerar (despierta).
    #[test]
    fn resolve_home_is_separate_from_listing() {
        let mock = mock_with_distros(&["Ubuntu-22.04"]);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/quorbuser"));
        let home = mock.resolve_home("Ubuntu-22.04").expect("home");
        assert_eq!(home, PathBuf::from("/home/quorbuser"));
        assert!(mock
            .calls()
            .contains(&WslCall::ResolveHome("Ubuntu-22.04".into())));
        assert!(
            !mock.calls().contains(&WslCall::ListDistributions),
            "resolver home no debe implicar enumerar"
        );
    }

    /// Resolver el home de una distro que no existe → error explícito, sin
    /// caer al home de otra distro ni a native.
    #[test]
    fn resolve_home_of_unknown_distro_fails_closed() {
        let mock = mock_with_distros(&["Ubuntu-22.04"]);
        let err = mock.resolve_home("Debian").expect_err("debe fallar");
        assert_eq!(err, WslError::DistroNotFound("Debian".to_string()));
    }

    /// F6: los cuatro estados del diagnóstico se distinguen.
    #[test]
    fn diagnose_reports_the_four_states() {
        let mock = MockWslAdapter::new();
        mock.set_installed(false);
        assert_eq!(
            mock.diagnose(None).expect("diagnóstico").state,
            WslState::WslNotInstalled
        );

        let mock = MockWslAdapter::new();
        mock.set_distributions(Vec::new());
        assert_eq!(
            mock.diagnose(None).expect("diagnóstico").state,
            WslState::NoDistributions
        );

        let mock = mock_with_distros(&["Ubuntu-22.04"]);
        assert_eq!(
            mock.diagnose(Some("Ubuntu-22.04"))
                .expect("diagnóstico")
                .state,
            WslState::Available
        );
        // M5: misma regla que el adaptador real — case-insensitive Unicode.
        assert_eq!(
            mock.diagnose(Some("ubuntu-22.04"))
                .expect("diagnóstico")
                .state,
            WslState::Available
        );
        assert_eq!(
            mock.diagnose(Some("Debian")).expect("diagnóstico").state,
            WslState::DistroUnavailable
        );
    }

    /// F6 + W1 §7: el detalle de `DistroUnavailable` lista las disponibles y
    /// no revela nada más.
    #[test]
    fn unavailable_distro_detail_lists_available_ones() {
        let mock = mock_with_distros(&["Ubuntu-22.04", "Debian"]);
        let diag = mock.diagnose(Some("Quorb-Pgone")).expect("diagnóstico");
        assert_eq!(diag.state, WslState::DistroUnavailable);
        let detail = diag.detail.expect("detalle");
        assert!(detail.contains("Ubuntu-22.04") && detail.contains("Debian"));
    }

    /// El timeout se reporta como cancelación acotada (nivel 1), con el PID
    /// remoto: no como una distro ausente ni como un cierre de distro.
    #[test]
    fn timeout_is_reported_as_scoped_cancellation() {
        let mock = mock_with_distros(&["Ubuntu-22.04"]);
        mock.set_failure(WslError::Timeout {
            distro: "Ubuntu-22.04".to_string(),
            pid: 4242,
        });
        let err = mock.resolve_home("Ubuntu-22.04").expect_err("timeout");
        assert_eq!(
            err,
            WslError::Timeout {
                distro: "Ubuntu-22.04".to_string(),
                pid: 4242
            }
        );
    }

    /// Leer un archivo inexistente en la distro se distingue de un fallo de
    /// parseo: no hay sesión.
    #[test]
    fn missing_file_reports_file_not_found() {
        let mock = mock_with_distros(&["Ubuntu-22.04"]);
        let err = mock
            .read_file(
                "Ubuntu-22.04",
                Path::new("/home/quorbuser/.claude/.credentials.json"),
            )
            .expect_err("sin fichero");
        assert_eq!(
            err,
            WslError::FileNotFound("/home/quorbuser/.claude/.credentials.json".to_string())
        );
    }

    /// `set_failure` también afecta a `diagnose` (M-1): un fallo de sonda
    /// (timeout, spawn) se propaga antes de evaluar los estados.
    #[test]
    fn diagnose_honors_set_failure() {
        let mock = mock_with_distros(&["Ubuntu-22.04"]);
        mock.set_failure(WslError::Timeout {
            distro: "Ubuntu-22.04".to_string(),
            pid: 7,
        });
        let err = mock
            .diagnose(Some("Ubuntu-22.04"))
            .expect_err("timeout de sonda");
        assert_eq!(
            err,
            WslError::Timeout {
                distro: "Ubuntu-22.04".to_string(),
                pid: 7
            }
        );
    }

    /// `terminate()` es recuperación explícita (nivel 2) y solo aplica a
    /// distros que existen.
    #[test]
    fn terminate_only_applies_to_enumerated_distros() {
        let mock = mock_with_distros(&["Ubuntu-22.04"]);
        assert!(mock.terminate("Ubuntu-22.04").is_ok());
        assert_eq!(
            mock.terminate("Debian").expect_err("desconocida"),
            WslError::DistroNotFound("Debian".to_string())
        );
    }
}
