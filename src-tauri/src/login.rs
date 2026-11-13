//! Login OAuth delegado en los CLIs oficiales.
//!
//! Anthropic y OpenAI no permiten registrar clientes OAuth de terceros para
//! las suscripciones de consumo, así que la app abre el flujo oficial
//! (`claude` / `codex login`) en una terminal nueva: el navegador hace el
//! OAuth con el proveedor y el CLI guarda la sesión, que luego leemos.
//!
//! Las cuentas adicionales usan el mismo comando con su propia carpeta de sesión
//! (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` o `GEMINI_CLI_HOME`), así no pisan la principal.

use crate::config::{Account, AppConfig};
use crate::wsl::{self, ShellStrategy, WslAdapter};
use std::path::{Path, PathBuf};

/// `id`: el proveedor (cuenta principal) o el id de una cuenta adicional.
/// Entorno WSL para la detección y el login (#92): la distro elegida y el
/// adaptador (real en producción, mock en los tests) para consultar dentro
/// de ella. `Some` solo cuando la configuración elige el modo WSL.
pub(crate) struct WslLogin<'a> {
    pub adapter: &'a dyn WslAdapter,
    pub distro: &'a str,
}

/// `id`: el proveedor (cuenta principal) o el id de una cuenta adicional.
/// En modo WSL (wsl: Some) la CLI se comprueba DENTRO de la distro y el
/// login se lanza allí; en host el flujo de siempre.
pub(crate) fn open(id: &str, cfg: &AppConfig, wsl: Option<WslLogin<'_>>) -> Result<(), String> {
    let (provider, env) = account_env(id, cfg, wsl.as_ref())?;
    let command = match provider.as_str() {
        "claude" => cfg.claude.login_command.trim(),
        "codex" => cfg.codex.login_command.trim(),
        "gemini" => cfg.gemini.login_command.trim(),
        "grok" => cfg.grok.login_command.trim(),
        "cursor" => cfg.cursor.login_command.trim(),
        other => return Err(format!("El proveedor {other} no tiene login por CLI")),
    };
    if command.is_empty() {
        return Err("Comando de login vacío (revísalo en Ajustes)".into());
    }
    match wsl.as_ref() {
        Some(w) => {
            let argv = prepare_wsl_login(w, &provider, command, &env)?;
            spawn_wsl_terminal(&argv)
        }
        None => {
            // Antes de abrir la terminal se comprueba que el CLI está
            // instalado: si no, la consola solo diría «no se reconoce como
            // un comando» y no sabrías qué hacer. El MISMO tokenizador que
            // la ejecución decide el programa (revisión PR #92): comillas y
            // escapes se ven igual aquí y en la terminal.
            // En HOST la ruta es del sistema: `C:\tools\codex.cmd` no debe
            // leer `\t`/`\c` como escapes POSIX (revisión PR #92, punto 8).
            // `program_of` es la heurística de host: primer token por
            // espacios o comillas envolventes, sin interpretar backslashes.
            let program = program_of(command);
            let extra_dir = match find_program(&program) {
                Found::OnPath => None,
                Found::In(dir) => Some(dir),
                Found::Missing => return Err(not_installed(&provider, &program)),
            };
            spawn_terminal(command, env, extra_dir)
        }
    }
}

/// ¿Está el CLI de login de cada proveedor DENTRO del entorno elegido?
///
/// En modo WSL se consulta la distro con UNA enumeración y UNA detección de
/// shell para las cuatro CLIs (no 12 invocaciones de `wsl.exe` por
/// refresco); una distro detenida no se despierta (se informa «no
/// disponible»). En host sigue siendo la detección de Windows de siempre.
/// Estado de una CLI de login para la UI (#92, revisión PR).
///
/// Contrato ampliado a 4 estados: el booleano no distinguía «no instalada»
/// de «distro detenida» o «WSL roto», y la UI no debe proponer instalar la
/// CLI cuando el problema es la distro.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CliStatus {
    /// Instalada y localizable (host o distro Running).
    Ready,
    /// La distro corre y no tiene esa CLI.
    Missing,
    /// La distro está detenida/transición: el login explícito puede
    /// activarla; el sondeo no la despierta.
    Stopped,
    /// WSL no disponible, distro inexistente o fallo del subsistema.
    Error,
}

impl CliStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CliStatus::Ready => "ready",
            CliStatus::Missing => "missing",
            CliStatus::Stopped => "stopped",
            CliStatus::Error => "error",
        }
    }
}

pub(crate) fn cli_status(
    cfg: &AppConfig,
    wsl: Option<WslLogin<'_>>,
) -> std::collections::BTreeMap<String, CliStatus> {
    let providers = [
        ("claude", &cfg.claude.login_command),
        ("codex", &cfg.codex.login_command),
        ("gemini", &cfg.gemini.login_command),
        ("grok", &cfg.grok.login_command),
    ];
    match &wsl {
        Some(w) => {
            let distros = w.adapter.list_distributions().ok();
            let situation = match distros.as_ref().and_then(|ds| {
                ds.iter()
                    .find(|d| crate::wsl::distro_name_matches(w.distro, &d.name))
            }) {
                // Distro ausente o WSL roto: no es un problema de la CLI.
                None => Some(CliStatus::Error),
                Some(d) if !matches!(d.state, crate::wsl::DistroState::Running) => {
                    Some(CliStatus::Stopped)
                }
                Some(_) => None,
            };
            if let Some(situation) = situation {
                return providers
                    .into_iter()
                    .map(|(p, _)| (p.to_string(), situation))
                    .collect();
            }
            let shell = w.adapter.shell_strategy(w.distro).ok();
            providers
                .into_iter()
                .map(|(p, c)| {
                    // Detección en el GUEST: mismo tokenizador POSIX que la
                    // ejecución (revisión PR #92, punto 5) — `program_of` es
                    // la heurística del HOST (punto 8) y aquí no aplica.
                    //
                    // Un comando que ya lanza `wsl` por su cuenta no se busca
                    // dentro del guest (allí no existe `wsl`) ni se envuelve
                    // (revisión PR #253): se informa como error de
                    // configuración, que no propone instalar ni bloquea el
                    // login (el mensaje accionable lo da `open`).
                    let status = if is_wsl_command(c) {
                        CliStatus::Error
                    } else {
                        match &shell {
                            Some(shell) => {
                                let program =
                                    split_login_command(c).map(|(p, _)| p).unwrap_or_default();
                                match w.adapter.program_available(w.distro, *shell, &program) {
                                    Ok(true) => CliStatus::Ready,
                                    Ok(false) => CliStatus::Missing,
                                    // Falla el subsistema a media sonda.
                                    Err(_) => CliStatus::Error,
                                }
                            }
                            None => CliStatus::Error,
                        }
                    };
                    (p.to_string(), status)
                })
                .collect()
        }
        None => providers
            .into_iter()
            .map(|(p, c)| {
                let status = if matches!(find_program(&program_of(c)), Found::Missing) {
                    CliStatus::Missing
                } else {
                    CliStatus::Ready
                };
                (p.to_string(), status)
            })
            .collect(),
    }
}

/// Estado de la CLI de login dentro de la distro (#92).
#[derive(Debug, PartialEq, Clone, Copy)]
enum CliCheck {
    /// Instalada y la distro está Running. Lleva la ESTRATEGIA de shell
    /// detectada: el argv la reutiliza en vez de asumir `bash -lc`
    /// (revisión 2 PR #92).
    Ready(ShellStrategy),
    /// La distro está detenida o en transición: el SONDEO no la despierta,
    /// pero el login explícito puede activarla.
    Stopped,
    /// La distro corre y no tiene esa CLI.
    Missing,
}

/// ¿Está `program` dentro de la distro? (issue #92).
///
/// No despierta una distro detenida: se consulta el estado con
/// `list_distributions` (no lanza nada) y solo se sondea con `command -v`
/// cuando está Running. Una distro Stopped o en transición devuelve
/// `Stopped` (ni Missing ni error): el sondeo informa sin activarla, y el
/// login explícito decide.
fn cli_check(wsl: &WslLogin<'_>, program: &str) -> Result<CliCheck, String> {
    if program.is_empty() {
        return Ok(CliCheck::Missing);
    }
    let distros = wsl
        .adapter
        .list_distributions()
        .map_err(|e| format!("WSL: {e:?}"))?;
    match distros
        .iter()
        .find(|d| wsl::distro_name_matches(wsl.distro, &d.name))
    {
        None => Err(format!("WSL: la distro «{}» no está instalada", wsl.distro)),
        Some(d) if !matches!(d.state, wsl::DistroState::Running) => Ok(CliCheck::Stopped),
        Some(_) => {
            let shell = wsl
                .adapter
                .shell_strategy(wsl.distro)
                .map_err(|e| format!("WSL: {e:?}"))?;
            // `command -v "$1"` (script constante, F14) con la CLI como dato:
            // `command` es un builtin, no se puede `exec` como programa.
            let available = wsl
                .adapter
                .program_available(wsl.distro, shell, program)
                .map_err(|e| format!("WSL: {e:?}"))?;
            Ok(if available {
                CliCheck::Ready(shell)
            } else {
                CliCheck::Missing
            })
        }
    }
}

/// Variables y carpeta de sesión de una cuenta adicional, en el ENTORNO
/// elegido (#92): en WSL la carpeta es la ruta LINUX donde el CLI escribirá
/// y donde el resolvedor de sesiones lee (la misma resolución de #91).
fn account_env(
    id: &str,
    cfg: &AppConfig,
    wsl: Option<&WslLogin<'_>>,
) -> Result<(String, SessionEnv), String> {
    if let Some(a) = cfg.accounts.iter().find(|a| a.id == id) {
        let var = a
            .session_env()
            .ok_or_else(|| format!("La cuenta «{}» no tiene login por CLI", a.label))?;
        let dir = match wsl {
            Some(w) => account_session_dir_linux(a, w)?,
            None => {
                let d = a.session_dir(&crate::providers::home());
                std::fs::create_dir_all(&d)
                    .map_err(|e| format!("No pude crear {}: {e}", d.display()))?;
                d
            }
        };
        return Ok((a.provider.to_string(), Some((var, dir))));
    }
    // Cuenta PRINCIPAL con `credentials_path` personalizado (revisión PR
    // #253): para el nombre estándar del CLI se usa la carpeta que lee
    // `account_session`/el fetch. En host, un nombre distinto puede venir
    // de un comando avanzado y mantiene el comportamiento sin variable; en
    // WSL no se permite porque el CLI debe escribir donde Quorb lee.
    let Some(var) = main_session_var(id) else {
        return Ok((id.to_string(), None));
    };
    let Some(sub) = main_subscription(cfg, id) else {
        return Ok((id.to_string(), None));
    };
    let path = sub.credentials_path.as_deref().map(str::trim).unwrap_or("");
    if path.is_empty() {
        return Ok((id.to_string(), None));
    }
    if wsl.is_some() {
        if let Some(problem) = wsl::guest_path_problem(path) {
            return Err(format!(
                "La ruta de credenciales de {id} no es válida en modo WSL: {problem}"
            ));
        }
    }
    let Some(dir) = main_session_dir(id, path) else {
        let file = crate::config::credentials_file_name(id).unwrap_or("…");
        // Un nombre estándar sin carpeta deducible sigue siendo inválido;
        // solo los nombres distintos conservan el comando avanzado de host.
        if wsl.is_none()
            && Path::new(&path.replace('\\', "/")).file_name() != Path::new(file).file_name()
        {
            return Ok((id.to_string(), None));
        }
        return Err(format!(
            "La ruta de credenciales de {id} debe terminar en el fichero del CLI ({file}): así el login escribe donde Quorb lee"
        ));
    };
    if wsl.is_none() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("No pude crear {}: {e}", dir.display()))?;
    }
    Ok((id.to_string(), Some((var, dir))))
}

/// Config de suscripción de una cuenta principal, por proveedor.
fn main_subscription<'a>(
    cfg: &'a AppConfig,
    provider: &str,
) -> Option<&'a crate::config::SubscriptionConfig> {
    match provider {
        "claude" => Some(&cfg.claude),
        "codex" => Some(&cfg.codex),
        "gemini" => Some(&cfg.gemini),
        "grok" => Some(&cfg.grok),
        _ => None,
    }
}

/// Variable de entorno de la carpeta de sesión de una cuenta principal.
fn main_session_var(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("CLAUDE_CONFIG_DIR"),
        "codex" => Some("CODEX_HOME"),
        "gemini" => Some("GEMINI_CLI_HOME"),
        "grok" => Some("GROK_HOME"),
        _ => None,
    }
}

/// Carpeta de la variable de sesión a partir de la ruta de credenciales
/// personalizada: la base que, unida al fichero estándar del CLI, da
/// exactamente esa ruta (`CLAUDE_CONFIG_DIR/<.credentials.json>`, o
/// `GEMINI_CLI_HOME/.gemini/oauth_creds.json`). Si no se puede derivar, el
/// llamador conserva los nombres no estándar en host sin variable adicional
/// y rechaza los demás casos con un mensaje accionable.
fn main_session_dir(provider: &str, credentials_path: &str) -> Option<PathBuf> {
    let file = crate::config::credentials_file_name(provider)?;
    let normalized = credentials_path.trim().replace('\\', "/");
    let suffix = format!("/{}", file.replace('\\', "/"));
    let base = normalized.strip_suffix(&suffix)?;
    if base.is_empty() {
        return None;
    }
    Some(PathBuf::from(base))
}

/// Carpeta de sesión LINUX de una cuenta adicional (#92): la misma regla de
/// `account_session_path` de #91 — `config_dir` absoluto del guest tal cual,
/// y la carpeta por defecto `~/.quorb` compuesta con POSIX; lo que no sea
/// POSIX (separadores de Windows o rutas relativas) se rechaza con un error
/// de configuración accionable.
fn account_session_dir_linux(a: &Account, wsl: &WslLogin<'_>) -> Result<PathBuf, String> {
    let home = wsl
        .adapter
        .resolve_home(wsl.distro)
        .map_err(|e| format!("WSL: {e:?}"))?;
    match &a.config_dir {
        Some(d) => {
            let d = d.trim();
            // Regla única de «POSIX absoluta del guest» (wsl::guest_path_problem;
            // revisión del mantenedor, 2026-11-06): la misma que usan
            // `resolve` y `account_session_path`, para que los mensajes no
            // diverjan.
            if let Some(problem) = wsl::guest_path_problem(d) {
                return Err(format!(
                    "La carpeta de la cuenta {} no es válida en modo WSL: {problem}",
                    a.id
                ));
            }
            // `"/"` es válida pero el recorte de barras la deja vacía: en el
            // guest `mkdir -p -- ""` falla (revisión PR #92, menor). La raíz
            // se queda como raíz.
            let trimmed = d.trim_end_matches('/');
            Ok(PathBuf::from(if trimmed.is_empty() {
                "/"
            } else {
                trimmed
            }))
        }
        None => {
            // La MISMA carpeta por defecto que el host (revisión del
            // mantenedor, 2026-11-06): home_dir del canal +
            // `accounts/<provider>-<suffix>`, con POSIX del guest. Así la
            // cuenta escribe donde la resolución de #91 lee.
            let account_dir = format!("{}-{}", a.provider, a.suffix());
            let rel = wsl::guest_relative(&[
                crate::channel::current().home_dir,
                "accounts",
                account_dir.as_str(),
            ]);
            Ok(wsl::join_guest_path(&home, &rel))
        }
    }
}

/// ¿El comando ya lanza WSL por su cuenta (`wsl …` / `wsl.exe …`)?
///
/// En modo WSL Quorb ya ejecuta el login dentro de la distro elegida:
/// envolver un comando que empieza por `wsl` lo lanzaría dos veces (un
/// segundo `wsl.exe` dentro del guest, que no existe), y buscarlo en el
/// guest da un falso «no instalado» (revisión PR #253).
fn is_wsl_command(command: &str) -> bool {
    let program = split_login_command(command)
        .map(|(program, _)| program)
        // An invalid command cannot execute; retain the previous guard result
        // for malformed inputs, including a plain wsl with unclosed arguments.
        .unwrap_or_else(|_| program_of(command));
    let file = program
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&program)
        .to_ascii_lowercase();
    file == "wsl" || file == "wsl.exe"
}

/// Mensaje de CLI ausente DENTRO de la distro (#92): sin ofrecer el
/// instalador de Windows como solución.
fn not_installed_wsl(provider: &str, program: &str, distro: &str) -> String {
    format!(
        "«{program}» no está instalado dentro de «{distro}». Instálalo en la distro (la \
         instalación automática en WSL queda fuera de alcance y aquí no se ejecuta el \
         instalador de Windows). Vuelve a pulsar «Iniciar sesión» una vez instalado. \
         Proveedor: {provider}"
    )
}

/// Prepara el lanzamiento del login en WSL SIN ejecutarlo (puro): el
/// sondeo de la CLI (Ready/Stopped/Missing) y el argv exacto. Separado del
/// spawn para que los tests no abran consolas reales y para tener una única
/// definición de la secuencia «comprobar → tokenizar → lanzar».
fn prepare_wsl_login(
    wsl: &WslLogin<'_>,
    provider: &str,
    command: &str,
    env: &SessionEnv,
) -> Result<Vec<std::ffi::OsString>, String> {
    // El comando ya lanza `wsl`: envolverlo lo ejecutaría dos veces (otro
    // `wsl.exe` dentro del guest) y la sonda buscaría `wsl`, que no existe
    // allí (revisión PR #253). Se pide el comando del CLI, sin `wsl`.
    if is_wsl_command(command) {
        return Err(format!(
            "El comando de login de {provider} ya incluye `wsl`: en modo WSL escribe \
             el comando del CLI dentro de la distro (por ejemplo `codex login`) y \
             elige la distro en Ajustes; Quorb lo ejecuta dentro de ella."
        ));
    }
    // El MISMO tokenizador que la ejecución decide el programa de la sonda
    // (revisión PR #92): una ruta entre comillas o con escapes se ejecuta
    // bien, pero `program_of` la daría por ausente.
    let (program, _) = split_login_command(command)?;
    match cli_check(wsl, &program)? {
        // `Ready(shell)` ya trae la estrategia DETECTADA (no asumimos bash);
        // `Stopped` — login explícito: el propio `wsl -d` la activa. Como se
        // va a activar de todos modos, aquí sí se resuelve la shell de la
        // distro (el sondeo informativo no la despierta; el login sí) y el
        // argv la lleva: en una distro sin bash, la CLI aparece «lista» con
        // sh y el login debe usar sh, no `bash: not found` (bloqueante 3,
        // revisión 2 PR #92).
        CliCheck::Ready(shell) => wsl_login_argv(wsl.distro, shell, command, env),
        CliCheck::Stopped => {
            let shell = wsl
                .adapter
                .shell_strategy(wsl.distro)
                .map_err(|e| format!("WSL: {e:?}"))?;
            wsl_login_argv(wsl.distro, shell, command, env)
        }
        CliCheck::Missing => Err(not_installed_wsl(provider, &program, wsl.distro)),
    }
}

/// Argv de `wsl.exe` que ejecuta el login DENTRO de la distro (#92, F14).
///
/// El comando configurado se **tokeniza** con `split_login_command` y cada
/// token viaja como argumento POSICIONAL del script constante
/// (`$0=quorb`, `$1..=programa y args`; con cuenta adicional `$1=carpeta`,
/// `$2=programa`…): el guest lo ejecuta con su argv exacto y el host no lo
/// reparsea. Nunca se pasa el comando entero como un único elemento — se
/// trataría como el nombre de un binario con espacios.
///
/// La carpeta de sesión de una cuenta adicional se asegura (`mkdir -p`) y se
/// aplica con el ejecutable `env` DENTRO del guest
/// (`env VAR=/ruta programa args…`), sin depender de WSLENV: así el CLI
/// escribe donde la resolución de #91 lee.
///
/// El lanzador usa `-e`/`--exec`, NO `--`: sin `-e`, `wsl.exe` ejecuta el
/// resto de la línea con la shell por defecto de la distro, que procesa las
/// comillas y deja `exec "$@"` en `exec` sin argumentos (`exec: : not
/// found` — hallazgo de la evidencia real en WSL, 2026-11-08). Con `-e` los
/// tokens llegan al guest tal cual y el `"$@"` ve `$@` completo.
///
/// Al terminar el login NO se cierra la consola: se ejecuta el shell del
/// usuario (`${SHELL:-/bin/sh}`), igual que `SHELL_WRAP` en host — si el
/// CLI falla, el error queda visible en la ventana (revisión PR #92). Con
/// carpeta de sesión de cuenta adicional, `$1` es la ruta y se asegura con
/// `mkdir -p --` ANTES del login: Codex falla si `CODEX_HOME` no existe.
const WSL_LOGIN_WRAP: &str = "\"$@\"; exec \"${SHELL:-/bin/sh}\"";
const WSL_LOGIN_WRAP_MKDIR: &str =
    "mkdir -p -- \"$1\" && shift && \"$@\"; exec \"${SHELL:-/bin/sh}\"";

fn wsl_login_argv(
    distro: &str,
    shell: ShellStrategy,
    login_command: &str,
    env: &SessionEnv,
) -> Result<Vec<std::ffi::OsString>, String> {
    let (program, args) = split_login_command(login_command)?;
    if program.is_empty() {
        return Err("Comando de login vacío (revísalo en Ajustes)".into());
    }
    // La estrategia de shell DETECTADA decide bash -lc o sh -c (revisión PR
    // #92): sin esto, una distro sin bash muestra la CLI como lista (el
    // sondeo de `command -v` usa sh) pero el login muere en `bash: not
    // found`. Llega explícita: `prepare_wsl_login` la resuelve y la pasa.
    let (shell_bin, shell_flag) = match shell {
        ShellStrategy::BashLogin => ("bash", "-lc"),
        ShellStrategy::ShPosix => ("sh", "-c"),
    };
    let mut argv: Vec<std::ffi::OsString> = vec![
        "wsl.exe".into(),
        "-d".into(),
        distro.into(),
        "-e".into(),
        shell_bin.into(),
        shell_flag.into(),
        WSL_LOGIN_WRAP.into(),
        "quorb".into(),
    ];
    if let Some((var, dir)) = env {
        // `$1` = carpeta a asegurar; detrás `env VAR=/ruta <programa>`.
        // La ruta viaja como DATO posicional (F14): sin quoting de shell.
        argv[6] = WSL_LOGIN_WRAP_MKDIR.into();
        // `PathBuf: Into<OsString>` directamente (no vía `to_string_lossy`,
        // que devuelve `Cow<str>` y no implementa `Into<OsString>`).
        argv.push(dir.clone().into());
        argv.push("env".into());
        argv.push(format!("{var}={}", dir.to_string_lossy()).into());
    }
    argv.push(program.into());
    argv.extend(args.into_iter().map(std::ffi::OsString::from));
    Ok(argv)
}

/// Abre una consola nueva con `wsl.exe` y el argv exacto del login (#92).
///
/// Los argumentos se pasan con `Command::args` (quoting MSVCRT de
/// CreateProcess), el mismo camino que mide el lab F14: nada de `cmd /C
/// start` ni de quoting manual, así que espacios, no-ASCII y metacaracteres
/// del comando personalizado llegan al guest sin reinterpretarse en el host.
#[cfg(windows)]
fn spawn_wsl_terminal(argv: &[std::ffi::OsString]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.current_dir(dirs::home_dir().unwrap_or_else(|| ".".into()))
        .args(argv.iter().skip(1))
        .creation_flags(CREATE_NEW_CONSOLE)
        // Revisión PR #92: la terminal hereda el entorno del host y un
        // `WSLENV` con, p. ej., `CODEX_HOME/p` desviaría `codex login`
        // hacia la carpeta de Windows mientras Quorb lee la del guest. El
        // entorno de la sesión se pasa DENTRO del guest vía `env VAR=…`
        // (argv posicional, F14), así que WSLENV no aporta nada: se limpia
        // para que ni el valor ni las reglas heredadas desvíen la sesión.
        .env_remove("WSLENV")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("No pude abrir la terminal: {e}"))
}

#[cfg(not(windows))]
fn spawn_wsl_terminal(_argv: &[std::ffi::OsString]) -> Result<(), String> {
    // WSL solo existe en Windows; en este build el adaptador real ya habrá
    // fallado en `cli_check` con WslNotInstalled antes de llegar aquí.
    Err("WSL no está disponible en esta plataforma".into())
}

/// Primer elemento del comando (`codex login` → `codex`), sin comillas.
/// Primer elemento del comando en HOST (#92): sin interpretar backslashes
/// como escapes (en Windows son separadores de carpeta; `C:\tools\codex.cmd`
/// no puede quedar `C:toolscodex.cmd` — revisión PR #92, punto 8). En WSL la
/// detección y la ejecución comparten `split_login_command` (semántica
/// POSIX del guest); son dos dominios con tokenizadores propios.
fn program_of(command: &str) -> String {
    let c = command.trim();
    if let Some(rest) = c.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("").to_string();
    }
    c.split_whitespace().next().unwrap_or("").to_string()
}

#[derive(Debug, PartialEq)]
enum Found {
    OnPath,
    /// No está en el PATH de Quorb, pero sí en una carpeta de instalación conocida
    /// (p. ej. se instaló con Quorb abierto y su PATH aún es el viejo).
    In(PathBuf),
    Missing,
}

/// Busca `program` en dos niveles: primero el PATH heredado (`OnPath`) y,
/// después, el PATH fresco del registro y las carpetas conocidas (`In`), para
/// que `open` pueda anteponer la carpeta encontrada sin tocar el entorno global.
fn find_program_tiers(
    program: &str,
    legacy: &[PathBuf],
    fresh: &[PathBuf],
    known: &[PathBuf],
    windows: bool,
    pathext: &str,
) -> Found {
    if program.is_empty() {
        return Found::Missing;
    }
    let p = Path::new(program);
    if p.is_absolute() || program.contains(['\\', '/']) {
        return if p.is_file() {
            Found::OnPath
        } else {
            Found::Missing
        };
    }
    if legacy
        .iter()
        .any(|d| dir_has_program(d, program, windows, pathext))
    {
        return Found::OnPath;
    }
    if let Some(dir) = fresh
        .iter()
        .find(|d| dir_has_program(d, program, windows, pathext))
    {
        return Found::In(dir.clone());
    }
    known
        .iter()
        .find(|d| dir_has_program(d, program, windows, pathext))
        .cloned()
        .map_or(Found::Missing, Found::In)
}

/// Variante inyectable sin PATH fresco (solo pruebas).
#[cfg(test)]
fn find_program_in(
    program: &str,
    path_dirs: &[PathBuf],
    known_dirs: &[PathBuf],
    windows: bool,
    pathext: &str,
) -> Found {
    find_program_tiers(program, path_dirs, &[], known_dirs, windows, pathext)
}

fn find_program(program: &str) -> Found {
    let legacy: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    find_program_tiers(
        program,
        &legacy,
        &fresh_path_dirs(),
        &known_dirs(),
        cfg!(windows),
        &pathext_env(),
    )
}

/// PATH fresco leído del registro (solo Windows); vacío en el resto.
fn fresh_path_dirs() -> Vec<PathBuf> {
    crate::codex_setup::fresh_windows_path_dirs()
}

/// ¿Hay un `codex` en PATH o carpetas conocidas? Es un metadato de instalación,
/// no la salud de la sesión.
pub fn codex_cli_found() -> bool {
    !matches!(find_program("codex"), Found::Missing)
}

/// PATHEXT del sistema; vacío fuera de Windows (allí no aplica).
fn pathext_env() -> String {
    if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
    } else {
        String::new()
    }
}

/// Nombres de fichero que puede tener un programa: en Windows cada extensión de
/// PATHEXT y, al final, el nombre tal cual; en el resto, solo el nombre.
fn program_candidates(program: &str, windows: bool, pathext: &str) -> Vec<String> {
    let mut names = vec![];
    if windows {
        names.extend(
            pathext
                .split(';')
                .filter(|e| !e.is_empty())
                .map(|e| format!("{program}{e}")),
        );
    }
    names.push(program.to_string());
    names
}

fn dir_has_program(dir: &Path, program: &str, windows: bool, pathext: &str) -> bool {
    program_candidates(program, windows, pathext)
        .iter()
        .any(|name| dir.join(name).is_file())
}

/// Carpetas donde suelen quedar los CLIs: npm global, el instalador nativo de
/// Claude Code y el binario de Codex gestionado por Quorb.
fn known_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    let home = crate::providers::home();
    dirs.push(home.join(".local").join("bin"));
    dirs.push(home.join(".npm-global").join("bin"));
    // `codex.exe` nativo que instala Quorb, sin depender de Node ni del PATH.
    dirs.extend(crate::codex_setup::managed_native_dirs(&home));
    // Una app GUI en macOS no hereda el PATH de la shell: sin esto, un CLI
    // instalado con Homebrew sería invisible para la detección y el login.
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// Instrucción de instalación específica por plataforma (Windows vs Linux).
/// Es solo texto: el usuario la copia y la ejecuta, Quorb nunca la interpola.
fn install_hint(provider: &str, windows: bool) -> &'static str {
    if windows {
        match provider {
            "claude" => {
                "Instala Claude Code (en PowerShell: irm https://claude.ai/install.ps1 | iex)"
            }
            "codex" => {
                "Instala el CLI de Codex con: npm install -g @openai/codex (necesita Node.js)"
            }
            "gemini" => {
                "Instala Gemini CLI con: npm install -g @google/gemini-cli (necesita Node.js)"
            }
            _ => "Instala su CLI o cambia el comando de login en la cuenta principal",
        }
    } else {
        match provider {
            "claude" => "Instala Claude Code (curl -fsSL https://claude.ai/install.sh | bash) o con tu gestor de paquetes (p. ej. sudo apt install claude-code)",
            "codex" => "Instala el CLI de Codex con: npm install -g @openai/codex (necesita Node.js)",
            "gemini" => "Instala Gemini CLI con: npm install -g @google/gemini-cli (necesita Node.js)",
            _ => "Instala su CLI o cambia el comando de login en la cuenta principal",
        }
    }
}

fn not_installed(provider: &str, program: &str) -> String {
    format!(
        "No encuentro «{program}» en este equipo. {} y vuelve a pulsar «Iniciar sesión».",
        install_hint(provider, cfg!(windows))
    )
}

/// Variable de entorno con la carpeta de sesión de una cuenta adicional.
type SessionEnv = Option<(&'static str, std::path::PathBuf)>;

/// Antepone al PATH la carpeta donde se encontró el CLI (si no estaba en el PATH),
/// incluyendo el PATH fresco del registro para que la terminal nueva lo vea.
/// Solo la consume la rama Windows (`spawn_terminal`: inyecta el PATH en la
/// consola nueva): en macOS el PATH viaja dentro del texto del script de
/// Terminal y en Linux la rama usa `path_with_dirs` con los directorios
/// explícitos.
#[cfg(windows)]
fn path_with(extra: Option<PathBuf>) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(fresh_path_dirs());
    path_with_current(extra, std::env::join_paths(dirs).ok())
}

/// Antepone `extra` a `current` (el PATH actual) sin tocar el entorno real.
#[cfg(any(test, windows))]
fn path_with_current(
    extra: Option<PathBuf>,
    current: Option<std::ffi::OsString>,
) -> Option<std::ffi::OsString> {
    let dir = extra?;
    let mut all = vec![dir];
    if let Some(p) = current {
        all.extend(std::env::split_paths(&p));
    }
    std::env::join_paths(all).ok()
}

#[cfg(windows)]
fn spawn_terminal(
    command: &str,
    env: SessionEnv,
    extra_dir: Option<PathBuf>,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new("cmd");
    if let Some(path) = path_with(extra_dir) {
        cmd.env("PATH", path);
    }
    // La consola nueva hereda el entorno, y con él la carpeta de sesión de la cuenta.
    if let Some((var, dir)) = env {
        cmd.env(var, dir);
    }
    // `start` abre una consola nueva; `/K` la deja abierta al terminar.
    cmd.current_dir(dirs::home_dir().unwrap_or_else(|| ".".into()))
        .raw_arg(format!("/C start \"Quorb · login\" cmd /K {command}"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("No pude abrir la terminal: {e}"))
}

#[cfg(target_os = "macos")]
fn spawn_terminal(
    command: &str,
    env: SessionEnv,
    extra_dir: Option<PathBuf>,
) -> Result<(), String> {
    let script = macos_terminal_script(command, env, extra_dir)?;
    let mut cmd = std::process::Command::new("osascript");
    cmd.arg("-e")
        .arg(script)
        .current_dir(dirs::home_dir().unwrap_or_else(|| ".".into()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("No pude abrir la terminal: {e}"))
}

/// Comando AppleScript que abre Terminal.app ejecutando el login.
///
/// La ventana de Terminal no hereda el entorno de Quorb (la lanza launchd, no
/// este proceso), así que el PATH extra y las variables de sesión se inyectan
/// como parte del texto del script. El texto completo se incrusta entre comillas
/// dobles de AppleScript con el escaping correspondiente.
///
/// El comando de login es configurable por el usuario: los caracteres de
/// control se rechazan (un `\n` rompe el quoting de `do script` y puede
/// ejecutar líneas fuera de la intención); y la integridad del script queda
/// protegida por el doble escaping shell+AppleScript. Ojo: los metacaracteres
/// de shell del comando (p. ej. `;`, `$()`) NO quedan inertes — el comando
/// configurable se ejecuta como código de shell por diseño; el escaping
/// protege el contenedor AppleScript, no neutraliza el shell.
///
/// Los helpers puros de quoting también compilan en los builds de test de
/// Windows y Linux: su contracto de escaping es parte de la superficie probada
/// del port y las plataformas sin Terminal deben validarlos igual.
#[cfg(any(test, target_os = "macos"))]
fn macos_terminal_script(
    command: &str,
    env: SessionEnv,
    extra_dir: Option<PathBuf>,
) -> Result<String, String> {
    if command.chars().any(char::is_control) {
        return Err(
            "El comando de login contiene caracteres de control (revísalo en Ajustes)".into(),
        );
    }
    let mut sh = String::new();
    if let Some(dir) = &extra_dir {
        sh.push_str(&format!(
            "export PATH={}:\"$PATH\"; ",
            sh_quote(&dir.to_string_lossy())
        ));
    }
    if let Some((var, dir)) = &env {
        sh.push_str(&format!(
            "export {var}={}; ",
            sh_quote(&dir.to_string_lossy())
        ));
    }
    sh.push_str(command);
    sh.push_str("; exec $SHELL");
    Ok(format!(
        "tell application \"Terminal\" to do script \"{}\"",
        apple_script_quote(&sh)
    ))
}

/// Escapa un texto para insertarlo entre comillas simples de shell.
#[cfg(any(test, target_os = "macos"))]
fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Escapa un texto para insertarlo entre comillas dobles de AppleScript.
#[cfg(any(test, target_os = "macos"))]
fn apple_script_quote(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Script fijo con el que la terminal lanza el login SIN interpolar el comando:
/// el login se pasa como argv (`"$@"`) y solo después de que salga se abre el
/// shell del usuario (`$SHELL`, con `/bin/sh` de respaldo si el entorno no la
/// define, p. ej. al lanzar desde un launcher sin login shell). La cadena de
/// script es una constante: nada del comando configurable llega a código de shell.
#[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
const SHELL_WRAP: &str = "\"$@\"; exec \"${SHELL:-/bin/sh}\"";

/// Separa un comando de login en (programa, argumentos) sin ejecutar la shell.
/// Entiende comillas simples/dobles y `\` de escape (semántica de shell_words,
/// sin dependencias). No expande variables de entorno (`$VAR` queda como texto
/// literal): si el CLI necesita variables, deben definirse fuera del comando.
/// Comillas sin cerrar devuelven `Err` y el login se aborta
/// (fail-closed): el texto del usuario nunca se interpola como código.
/// Lo consumen la terminal de Linux, el argv de WSL (#92) y los tests: en
/// Windows (host) el login va dentro de `cmd /K` y en macOS dentro del
/// script de Terminal.
fn split_login_command(command: &str) -> Result<(String, Vec<String>), String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_token = true;
                let mut closed = false;
                for c2 in chars.by_ref() {
                    if c2 == '\'' {
                        closed = true;
                        break;
                    }
                    current.push(c2);
                }
                if !closed {
                    return Err("Comando de login con comillas simples sin cerrar".into());
                }
            }
            '"' => {
                in_token = true;
                let mut closed = false;
                while let Some(c2) = chars.next() {
                    if c2 == '"' {
                        closed = true;
                        break;
                    }
                    if c2 == '\\' {
                        match chars.next() {
                            // Escape real dentro de comillas dobles: `\\` → `\`,
                            // `\"` → `"`.
                            Some('\\') => current.push('\\'),
                            Some('"') => current.push('"'),
                            // Barra ante carácter ordinario: se conserva literal
                            // (`\p` sigue siendo `\p`, no `p` — rutas tipo
                            // `"C:\\foo\\bar"` deben quedarse intactas).
                            Some(other) => {
                                current.push('\\');
                                current.push(other);
                            }
                            None => current.push('\\'),
                        }
                    } else {
                        current.push(c2);
                    }
                }
                if !closed {
                    return Err("Comando de login con comillas dobles sin cerrar".into());
                }
            }
            '\\' => {
                in_token = true;
                match chars.next() {
                    Some(esc) => current.push(esc),
                    None => current.push('\\'),
                }
            }
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut current));
                    in_token = false;
                }
            }
            _ => {
                in_token = true;
                current.push(c);
            }
        }
    }
    if in_token {
        tokens.push(current);
    }
    let mut tokens = tokens.into_iter();
    let program = tokens.next().unwrap_or_default();
    let args: Vec<String> = tokens.collect();
    Ok((program, args))
}

/// Emuladores de terminal por orden de preferencia (X11/Wayland genéricos).
#[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
const TERMINALS: [&str; 7] = [
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
    "alacritty",
    "kitty",
];

/// Primera terminal disponible; devuelve (nombre, dir si está en una carpeta
/// conocida fuera del PATH). `Found::In(dir)` indica que la terminal está en
/// una carpeta custom (p. ej. Kitty en `~/.local/bin`): conservamos `dir` para
/// lanzar la terminal con su ruta y anteponerla al PATH del proceso hijo.
#[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
fn find_terminal_impl(path_dirs: &[PathBuf], known_dirs: &[PathBuf]) -> Option<(String, PathBuf)> {
    TERMINALS.iter().find_map(|t| {
        match find_program_tiers(t, path_dirs, &[], known_dirs, false, "") {
            Found::Missing => None,
            Found::OnPath => Some((t.to_string(), PathBuf::new())),
            Found::In(dir) => Some((t.to_string(), dir)),
        }
    })
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn find_terminal() -> Option<(String, PathBuf)> {
    let legacy: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    find_terminal_impl(&legacy, &known_dirs())
}

/// Invocación de la terminal para ejecutar `program args...` sin shell:
/// `<flag> sh -c <SHELL_WRAP> sh <program> <args...>`. El flag depende del
/// emulador; la secuencia `sh -c` es fija y recibe el login como argv.
#[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
fn terminal_invocation(terminal: &str, program: &str, args: &[String]) -> Vec<String> {
    let flag = match terminal {
        "gnome-terminal" => "--".to_string(),
        "xfce4-terminal" => "-x".to_string(),
        _ => "-e".to_string(),
    };
    let mut v = vec![
        flag,
        "sh".into(),
        "-c".into(),
        SHELL_WRAP.into(),
        "sh".into(),
        program.into(),
    ];
    v.extend(args.iter().cloned());
    v
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn spawn_terminal(
    command: &str,
    env: SessionEnv,
    extra_dir: Option<PathBuf>,
) -> Result<(), String> {
    let (program, args) = split_login_command(command)?;
    if program.is_empty() {
        return Err("Comando de login vacío (revísalo en Ajustes).".into());
    }
    let (terminal, terminal_dir) = find_terminal().ok_or_else(|| {
        "No encuentro un emulador de terminal (x-terminal-emulator, gnome-terminal o konsole) en este equipo. Instala uno o ejecuta el login a mano en tu terminal.".to_string()
    })?;
    let mut cmd = std::process::Command::new(&terminal);
    // Directorios que deben quedar en el PATH de la terminal: el de la propia
    // terminal si está fuera del PATH (p. ej. ~/.local/bin) y el del CLI si su
    // ejecutable también se encontró fuera del PATH. Si la terminal es un
    // nombre puro (`Found::OnPath`) no hace falta anteponer nada.
    let mut extras: Vec<PathBuf> = vec![];
    if !terminal_dir.as_os_str().is_empty() {
        extras.push(terminal_dir);
    }
    if let Some(dir) = extra_dir {
        extras.push(dir);
    }
    if let Some(path) = path_with_dirs(&extras) {
        cmd.env("PATH", path);
    }
    if let Some((var, dir)) = env {
        cmd.env(var, dir);
    }
    cmd.args(terminal_invocation(&terminal, &program, &args));
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("No pude abrir la terminal ({terminal}): {e}"))
}

/// Antepone `extras` al PATH actual (en orden) sin tocar el entorno real.
#[cfg(all(not(windows), not(target_os = "macos")))]
fn path_with_dirs(extras: &[PathBuf]) -> Option<std::ffi::OsString> {
    if extras.is_empty() {
        return None;
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.splice(0..0, extras.iter().cloned());
    std::env::join_paths(dirs).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Carpeta temporal propia de cada prueba, borrada al terminar.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("quorb-login-{}-{tag}", std::process::id()));
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

    /// Revisión PR #253: un comando que ya lanza `wsl` se reconoce (y no se
    /// envuelve ni se busca dentro del guest).
    #[test]
    fn is_wsl_command_detects_wsl_prefixes() {
        assert!(is_wsl_command("wsl codex login"));
        assert!(is_wsl_command("  WSL.EXE  codex login"));
        assert!(is_wsl_command(
            r#""C:\Windows\System32\wsl.exe" codex login"#
        ));
        assert!(!is_wsl_command("codex login"));
        assert!(!is_wsl_command("wslx codex login"));
        assert!(!is_wsl_command(""));
    }

    /// Revisión PR #253, punto 2: la carpeta de la variable de sesión sale de
    /// la ruta de credenciales personalizada de la cuenta principal, de modo
    /// que el login escribe exactamente donde se lee.
    #[test]
    fn main_session_dir_is_derived_from_the_credentials_path() {
        assert_eq!(
            main_session_dir("claude", "D:\\trabajo\\.credentials.json"),
            Some(PathBuf::from("D:/trabajo"))
        );
        assert_eq!(
            main_session_dir("codex", "/home/user/.codex/auth.json"),
            Some(PathBuf::from("/home/user/.codex"))
        );
        // Gemini guarda el fichero en una subcarpeta de su home: la base no es
        // el padre del fichero, sino el home que lo contiene.
        assert_eq!(
            main_session_dir("gemini", "/home/user/.gemini/oauth_creds.json"),
            Some(PathBuf::from("/home/user"))
        );
        // Una ruta que no termina en el fichero del CLI no permite derivar la
        // carpeta; el llamador decide si conserva el comando o rechaza en WSL.
        assert_eq!(main_session_dir("claude", "D:\\trabajo\\otra.json"), None);
        assert_eq!(main_session_dir("cursor", "/tmp/x"), None);
    }

    /// La cuenta principal con `credentials_path` personalizado exporta la
    /// variable de sesión apuntando a la carpeta de esa ruta (PR #253).
    #[test]
    fn main_account_with_custom_credentials_path_passes_the_session_dir() {
        let tmp = TempDir::new("principal-custom");
        let custom = tmp.path().join(".credentials.json");
        let mut cfg = AppConfig::default();
        cfg.claude.credentials_path = Some(custom.to_string_lossy().into_owned());
        let (provider, env) = account_env("claude", &cfg, None).expect("env");
        assert_eq!(provider, "claude");
        let (var, dir) = env.expect("la cuenta principal usa la carpeta personalizada");
        assert_eq!(var, "CLAUDE_CONFIG_DIR");
        assert_eq!(dir.as_path(), tmp.path());
    }

    /// Sin ruta personalizada, la principal no exporta nada: el CLI usa su
    /// carpeta por defecto (comportamiento de siempre).
    #[test]
    fn main_account_without_custom_path_passes_nothing() {
        let cfg = AppConfig::default();
        let (_, env) = account_env("claude", &cfg, None).expect("env");
        assert!(env.is_none());
    }

    /// Un comando avanzado de host puede escribir un nombre no estándar: no
    /// se deduce una carpeta ni se altera el comando configurado.
    #[test]
    fn main_account_nonstandard_host_filename_keeps_advanced_command_without_override() {
        let tmp = TempDir::new("principal-custom-filename");
        let absent_dir = tmp.path().join("not-created");
        let synthetic = absent_dir.join("auth-work.json");
        let paths = [
            r"C:\work\auth-work.json".to_string(),
            synthetic.to_string_lossy().into_owned(),
        ];
        let mut cfg = AppConfig::default();
        assert!(!absent_dir.exists());
        for path in paths {
            let command = format!("custom-login --output \"{path}\"");
            cfg.codex.credentials_path = Some(path);
            cfg.codex.login_command = command.clone();
            assert_eq!(account_env("codex", &cfg, None), Ok(("codex".into(), None)));
            assert_eq!(cfg.codex.login_command, command);
            assert!(!absent_dir.exists(), "no se crea una carpeta de sesión");
        }
    }

    /// Los nombres estándar conservan su variable y carpeta; el guest rechaza
    /// rutas inválidas o nombres distintos antes de consultar el adaptador.
    #[test]
    fn main_account_standard_filenames_and_guest_validation_are_preserved() {
        let tmp = TempDir::new("principal-standard-filenames");
        for (provider, file, var) in [
            ("claude", ".credentials.json", "CLAUDE_CONFIG_DIR"),
            ("codex", "auth.json", "CODEX_HOME"),
            ("gemini", ".gemini/oauth_creds.json", "GEMINI_CLI_HOME"),
            ("grok", "auth.json", "GROK_HOME"),
        ] {
            let dir = tmp.path().join(provider);
            let credentials = dir.join(file);
            let mut cfg = AppConfig::default();
            let sub = match provider {
                "claude" => &mut cfg.claude,
                "codex" => &mut cfg.codex,
                "gemini" => &mut cfg.gemini,
                "grok" => &mut cfg.grok,
                _ => unreachable!(),
            };
            sub.credentials_path = Some(credentials.to_string_lossy().into_owned());
            assert_eq!(
                account_env(provider, &cfg, None),
                Ok((provider.into(), Some((var, dir.clone()))))
            );
            assert!(dir.is_dir());
            assert!(!credentials.exists(), "no se crea el fichero de sesión");
        }

        // Un nombre estándar sin carpeta deducible ya se rechazaba en host.
        let mut cfg = AppConfig::default();
        cfg.codex.credentials_path = Some("auth.json".into());
        assert_eq!(
            account_env("codex", &cfg, None),
            Err("La ruta de credenciales de codex debe terminar en el fichero del CLI (auth.json): así el login escribe donde Quorb lee".into())
        );

        let mock = crate::wsl::MockWslAdapter::new();
        let wsl = WslLogin {
            adapter: &mock,
            distro: "synthetic-distro",
        };
        let mut cfg = AppConfig::default();
        cfg.gemini.credentials_path = Some("/synthetic/session/.gemini/oauth_creds.json".into());
        assert_eq!(
            account_env("gemini", &cfg, Some(&wsl)),
            Ok((
                "gemini".into(),
                Some(("GEMINI_CLI_HOME", PathBuf::from("/synthetic/session")))
            ))
        );
        for (path, expected) in [
            (
                r"C:\work\auth-work.json",
                r"La ruta de credenciales de codex no es válida en modo WSL: La ruta en modo WSL no puede llevar separadores de Windows (\). Pega la ruta del guest (por ejemplo /home/usuario/...) en su lugar: C:\work\auth-work.json",
            ),
            (
                "relative/auth.json",
                "La ruta de credenciales de codex no es válida en modo WSL: La ruta en modo WSL debe ser absoluta del guest (empieza por '/'), se recibió: relative/auth.json",
            ),
            (
                "/synthetic/session/auth-work.json",
                "La ruta de credenciales de codex debe terminar en el fichero del CLI (auth.json): así el login escribe donde Quorb lee",
            ),
        ] {
            cfg.codex.credentials_path = Some(path.into());
            assert_eq!(open("codex", &cfg, Some(WslLogin { ..wsl })), Err(expected.into()));
            assert!(mock.calls().is_empty(), "el guest no recibe llamadas");
        }
    }

    #[test]
    fn program_of_keeps_quoted_paths_with_spaces() {
        assert_eq!(program_of("codex login"), "codex");
        assert_eq!(program_of("  gemini   --foo"), "gemini");
        assert_eq!(
            program_of("\"/opt/mis herramientas/claude\" login"),
            "/opt/mis herramientas/claude"
        );
        assert_eq!(
            program_of("\"C:\\Program Files\\nodejs\\codex.cmd\""),
            "C:\\Program Files\\nodejs\\codex.cmd"
        );
        assert_eq!(program_of(""), "");
    }

    #[test]
    fn split_login_command_keeps_quotes_and_escapes() {
        assert_eq!(
            split_login_command("codex login"),
            Ok(("codex".into(), vec!["login".into()]))
        );
        assert_eq!(
            split_login_command("  gemini   --foo"),
            Ok(("gemini".into(), vec!["--foo".into()]))
        );
        assert_eq!(
            split_login_command("\"/opt/mis herramientas/claude\" login"),
            Ok(("/opt/mis herramientas/claude".into(), vec!["login".into()]))
        );
        assert_eq!(
            split_login_command("claude 'mi sesión' \"otra\" c\\adena"),
            Ok((
                "claude".into(),
                vec!["mi sesión".into(), "otra".into(), "cadena".into()]
            ))
        );
        // Los metacaracteres de shell quedan como argumentos literales, no como
        // código: la cadena NUNCA se interpola en `sh -c`.
        assert_eq!(
            split_login_command("claude; rm -rf /"),
            Ok((
                "claude;".into(),
                vec!["rm".into(), "-rf".into(), "/".into()]
            ))
        );
    }

    #[test]
    fn split_login_command_fails_closed_on_unbalanced_quotes() {
        assert!(split_login_command("\"sin cerrar").is_err());
        assert!(split_login_command("'sin cerrar").is_err());
    }

    /// P2 owner feedback: dentro de comillas dobles, `\\` y `\"` son escapes
    /// reales; el resto de barras (`\p`, `\n`, `\ `) **se conservan literales** —
    /// el parser nuevo no debe alterarlas como hacía el shell previo.
    #[test]
    fn split_login_command_preserves_backslash_in_double_quotes() {
        // Ruta estilo Windows con barras escapadas: cada `\\` → `\` literal.
        // Un solo token (sin espacios) va como programa, no como arg.
        // Entrada: "C:\\foo\\bar" (con comillas dobles) → token único `C:\foo\bar`.
        assert_eq!(
            split_login_command("\"C:\\\\foo\\\\bar\""),
            Ok(("C:\\foo\\bar".into(), vec![]))
        );
        // Con programa + arg de ruta escapada:
        // `codex "C:\\foo\\bar"` → programa `codex`, arg `C:\foo\bar`.
        assert_eq!(
            split_login_command("codex \"C:\\\\foo\\\\bar\""),
            Ok(("codex".into(), vec!["C:\\foo\\bar".into()]))
        );
        // `\\` aislado dentro de comillas dobles → `\`.
        assert_eq!(split_login_command("\"\\\\\""), Ok(("\\".into(), vec![])));
        // Barra literal ante carácter ordinario (`\p`): se conserva tal cual.
        assert_eq!(
            split_login_command("\"a\\pb\""),
            Ok(("a\\pb".into(), vec![]))
        );
        // `\\` al final de un argumento entre dobles (antes del cierre):
        // entrada `a\\` → arg `a\`
        assert_eq!(split_login_command("\"a\\\\\""), Ok(("a\\".into(), vec![])));
        // Comilla escapada `\"` dentro de dobles → `"` literal.
        // `codex "hola\"mundo"` → programa `codex`, arg `hola"mundo`.
        assert_eq!(
            split_login_command("codex \"hola\\\"mundo\""),
            Ok(("codex".into(), vec!["hola\"mundo".into()]))
        );
    }

    #[test]
    fn install_hint_is_specific_per_platform() {
        assert!(install_hint("claude", false).contains("install.sh"));
        assert!(install_hint("claude", true).contains("PowerShell"));
        assert!(install_hint("gemini", false).contains("@google/gemini-cli"));
        assert!(install_hint("cursor", false).contains("cambia el comando"));
    }

    #[test]
    fn terminal_invocation_passes_login_as_argv_not_shell_code() {
        // gnome-terminal usa `--`; el script de shell es constante y el login
        // llega como argv, no en el script.
        assert_eq!(
            terminal_invocation("gnome-terminal", "codex", &["login".into()]),
            vec!["--", "sh", "-c", SHELL_WRAP, "sh", "codex", "login"]
        );
        assert_eq!(
            terminal_invocation("xterm", "claude", &["/login".into()]),
            vec!["-e", "sh", "-c", SHELL_WRAP, "sh", "claude", "/login"]
        );
        assert_eq!(
            terminal_invocation("xfce4-terminal", "gemini", &[]),
            vec!["-x", "sh", "-c", SHELL_WRAP, "sh", "gemini"]
        );
    }

    #[test]
    fn windows_candidates_append_pathext_before_the_bare_name() {
        assert_eq!(
            program_candidates("codex", true, ".COM;.EXE;.BAT;.CMD"),
            vec!["codex.COM", "codex.EXE", "codex.BAT", "codex.CMD", "codex"]
        );
        // PATHEXT vacío (o solo separadores): solo el nombre tal cual.
        assert_eq!(program_candidates("codex", true, ""), vec!["codex"]);
        assert_eq!(program_candidates("codex", true, ";;"), vec!["codex"]);
    }

    #[test]
    fn non_windows_candidates_ignore_pathext() {
        assert_eq!(program_candidates("codex", false, ".EXE"), vec!["codex"]);
    }

    #[test]
    fn dir_has_program_accepts_files_and_rejects_directories() {
        let dir = TempDir::new("candidates");
        std::fs::create_dir(dir.path().join("claude")).unwrap();
        assert!(!dir_has_program(dir.path(), "claude", false, ""));
        std::fs::write(dir.path().join("codex"), b"#!/bin/sh\n").unwrap();
        assert!(dir_has_program(dir.path(), "codex", false, ""));
        // La lógica de Windows se prueba en Linux inyectando la plataforma.
        std::fs::write(dir.path().join("gemini.EXE"), b"").unwrap();
        assert!(dir_has_program(dir.path(), "gemini", true, ".EXE"));
        assert!(!dir_has_program(dir.path(), "gemini", false, ""));
    }

    #[test]
    fn absolute_directory_is_not_a_program() {
        let dir = TempDir::new("absdir");
        assert_eq!(
            find_program_in(dir.path().to_str().unwrap(), &[], &[], false, ""),
            Found::Missing
        );
    }

    #[test]
    fn program_is_found_on_the_injected_path_then_in_known_dirs() {
        let path_dir = TempDir::new("path");
        std::fs::write(path_dir.path().join("codex"), b"").unwrap();
        assert_eq!(
            find_program_in("codex", &[path_dir.path().to_path_buf()], &[], false, ""),
            Found::OnPath
        );

        let known = TempDir::new("known");
        std::fs::write(known.path().join("gemini"), b"").unwrap();
        assert_eq!(
            find_program_in(
                "gemini",
                &[path_dir.path().to_path_buf()],
                &[known.path().to_path_buf()],
                false,
                ""
            ),
            Found::In(known.path().to_path_buf())
        );

        assert_eq!(
            find_program_in("codex", &[], &[], false, ""),
            Found::Missing
        );
        assert_eq!(
            find_program_in("", &[path_dir.path().to_path_buf()], &[], false, ""),
            Found::Missing
        );
    }

    #[test]
    fn find_program_tiers_prefers_legacy_then_fresh_then_known() {
        let legacy = TempDir::new("tier-legacy");
        let fresh = TempDir::new("tier-fresh");
        let known = TempDir::new("tier-known");
        std::fs::write(fresh.path().join("codex"), b"").unwrap();
        std::fs::write(known.path().join("codex"), b"").unwrap();
        // Sin PATH heredado, el fresco se marca como In para poder anteponerlo.
        assert_eq!(
            find_program_tiers(
                "codex",
                &[],
                &[fresh.path().to_path_buf()],
                &[known.path().to_path_buf()],
                false,
                ""
            ),
            Found::In(fresh.path().to_path_buf())
        );
        // El PATH heredado gana y es OnPath.
        std::fs::write(legacy.path().join("codex"), b"").unwrap();
        assert_eq!(
            find_program_tiers(
                "codex",
                &[legacy.path().to_path_buf()],
                &[fresh.path().to_path_buf()],
                &[known.path().to_path_buf()],
                false,
                ""
            ),
            Found::OnPath
        );
    }

    /// P2 owner feedback: una terminal localizada FUERA del PATH (en una
    /// `known_dir` como `~/.local/bin`) debe devolverse con su `dir` resuelta,
    /// para que `spawn_terminal` la lance con su ruta completa.
    #[test]
    fn find_terminal_returns_dir_when_terminal_is_outside_path() {
        // Creamos un kitty "fuera del PATH" en una known_dir.
        let known = TempDir::new("known");
        std::fs::write(known.path().join("kitty"), b"#!/bin/sh\n").unwrap();
        // La cascada TERMINALS empieza por x-terminal-emulator: con un PATH
        // vacío, ninguno se resuelve por nombre, así que termina en la known_dir
        // con kitty. (Los otros nombres no existen en known.)
        let res = find_terminal_impl(&[], &[known.path().to_path_buf()]);
        let Some((name, dir)) = res else {
            panic!(
                "con un PATH vacío y kitty en known_dir, find_terminal debe encontrar una terminal"
            );
        };
        assert_eq!(
            name, "kitty",
            "la cascada debe llegar a kitty cuando no hay otra"
        );
        assert_eq!(
            dir,
            known.path().to_path_buf(),
            "find_terminal debe conservar la dir de la terminal"
        );
    }

    /// P2 owner feedback: CLI y terminal en carpetas distintas fuera del PATH.
    /// `find_terminal_impl` devuelve kitty con su dir; el CLI codex se resuelve
    /// aparte en su propia carpeta. Propiedad exigida por el owner.
    #[test]
    fn find_terminal_resolves_path_outside_path_for_separate_cli_and_terminal() {
        let terminal_dir = TempDir::new("terminal-dir");
        let cli_dir = TempDir::new("cli-dir");
        std::fs::write(terminal_dir.path().join("kitty"), b"").unwrap();
        std::fs::write(cli_dir.path().join("codex"), b"").unwrap();
        let res = find_terminal_impl(&[], &[terminal_dir.path().to_path_buf()]);
        let Some((name, dir)) = res else {
            panic!("kitty en known_dir y PATH vacío debe localizarse");
        };
        assert_eq!(name, "kitty");
        assert_eq!(dir, terminal_dir.path().to_path_buf());
        // El CLI codex se resuelve por su lado, en cli_dir.
        let codex = find_program_tiers(
            "codex",
            &[],
            &[],
            &[cli_dir.path().to_path_buf()],
            false,
            "",
        );
        assert_eq!(codex, Found::In(cli_dir.path().to_path_buf()));
    }

    #[test]
    fn known_dirs_include_the_managed_native_binary_location() {
        let dirs = known_dirs();
        let managed = crate::codex_setup::managed_native_dirs(&crate::providers::home());
        assert!(!managed.is_empty());
        assert!(managed.iter().all(|d| dirs.contains(d)));
    }

    #[test]
    fn joined_path_prepends_the_extra_dir_and_keeps_the_rest() {
        let extra = PathBuf::from("/opt/mis herramientas/bin");
        let current =
            std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]).unwrap();
        let joined = path_with_current(Some(extra.clone()), Some(current)).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(
            parts,
            vec![extra, PathBuf::from("/usr/bin"), PathBuf::from("/bin")]
        );
        assert!(path_with_current(None, None).is_none());
    }

    #[test]
    fn sh_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(sh_quote("codex"), "'codex'");
        assert_eq!(
            sh_quote("/opt/mis herramientas/bin"),
            "'/opt/mis herramientas/bin'"
        );
        assert_eq!(sh_quote("mi'ruta"), "'mi'\\''ruta'");
    }

    #[test]
    fn apple_script_quote_escapes_backslashes_and_double_quotes() {
        assert_eq!(apple_script_quote("simple"), "simple");
        // cada barra invertida se duplica
        assert_eq!(apple_script_quote("con \\\\ barra"), "con \\\\\\\\ barra");
        // cada comilla doble se escapa
        assert_eq!(apple_script_quote("decir \"hola\""), "decir \\\"hola\\\"");
    }

    #[test]
    fn macos_script_runs_the_command_and_then_the_users_shell() {
        let script = macos_terminal_script("codex login", None, None).unwrap();
        assert!(script.starts_with("tell application \"Terminal\" to do script \""));
        assert!(script.contains("codex login"));
        assert!(script.contains("exec $SHELL"));
    }

    #[test]
    fn macos_script_exports_the_session_env_with_spaces_and_non_ascii() {
        let dir = PathBuf::from("/Users/ju/ Mi Carpeta Ñ");
        let script =
            macos_terminal_script("claude login", Some(("CODEX_HOME", dir.clone())), None).unwrap();
        assert!(script.contains("export CODEX_HOME='/Users/ju/ Mi Carpeta Ñ'"));
        assert!(script.contains("codex") || script.contains("claude"));
    }

    #[test]
    fn macos_script_prepends_the_extra_dir_to_the_path() {
        let extra = PathBuf::from("/opt/mis herramientas/bin");
        let script = macos_terminal_script("codex login", None, Some(extra)).unwrap();
        // las comillas de "$PATH" quedan escapadas en la capa AppleScript
        assert!(script.contains("export PATH='/opt/mis herramientas/bin':\\\"$PATH\\\""));
    }

    /// Entrada hostil pero imprimible (comillas, backticks, $(…), punto y coma):
    /// el contrato que acredita este test es de la CAPA APPLESCRIPT — el
    /// payload no rompe el quoting del script y queda en una sola línea. Los
    /// metacaracteres de shell NO quedan inertes: el comando configurable se
    /// ejecuta como código de shell por diseño (es lo que el usuario pidió);
    /// lo único protegido es la integridad del script que lo contiene.
    #[test]
    fn macos_script_keeps_hostile_printable_input_quoted_and_on_one_line() {
        let script =
            macos_terminal_script("echo 'co\"de'; rm -rf $(x) `y`; ls", None, None).unwrap();
        assert!(
            !script.contains('\n'),
            "el payload no debe contener saltos de línea"
        );
        assert!(
            script.contains("\\\""),
            "las comillas dobles quedan escapadas en AppleScript"
        );
    }

    /// Caracteres de control (newlines, tabs, etc.) en el comando configurable:
    /// se rechazan antes de construir el script. Un `\n` dentro del argumento de
    /// `do script` rompe el quoting de AppleScript y puede ejecutar líneas
    /// adicionales fuera de la intención del usuario.
    #[test]
    fn macos_script_rejects_control_characters_in_the_command() {
        assert!(macos_terminal_script("codex login\nrm -rf ~", None, None).is_err());
        assert!(macos_terminal_script("codex\tlogin", None, None).is_err());
        assert!(macos_terminal_script("\u{1b}[31mrojo", None, None).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn known_dirs_include_homebrew_locations_on_macos() {
        let dirs = known_dirs();
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
    }
}

#[cfg(test)]
mod wsl_login_tests {
    use super::*;
    use crate::cli_process::CommandOutput;
    use crate::wsl::{distro, DistroState, MockWslAdapter, ShellStrategy, WslCall};

    fn wsl_of(mock: &MockWslAdapter) -> WslLogin<'_> {
        WslLogin {
            adapter: mock,
            distro: "Ubuntu-22.04",
        }
    }

    /// En modo WSL, un comando que ya incluye `wsl` no se envuelve: se pide el
    /// comando del CLI con un mensaje accionable (PR #253).
    #[test]
    fn wsl_login_rejects_a_command_that_already_launches_wsl() {
        for command in [
            "wsl codex login",
            "WSL.EXE codex login",
            r#""C:\Windows\System32\wsl.exe" codex login"#,
            "wsl 'unterminated",
            "'wsl' codex login",
            "'wsl.exe' codex login",
        ] {
            let mock = MockWslAdapter::new();
            let result = prepare_wsl_login(&wsl_of(&mock), "codex", command, &None);
            assert_eq!(
                result,
                Err("El comando de login de codex ya incluye `wsl`: en modo WSL escribe el comando del CLI dentro de la distro (por ejemplo `codex login`) y elige la distro en Ajustes; Quorb lo ejecuta dentro de ella.".into()),
                "{command}"
            );
            assert!(mock.calls().is_empty(), "{command}: {:?}", mock.calls());
        }
    }

    #[test]
    fn cli_status_rejects_normalized_wsl_programs_without_guest_probes() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_command_output(CommandOutput {
            code: 0,
            stdout: "/synthetic/cli\n".into(),
            stderr: String::new(),
        });
        let mut cfg = AppConfig::default();
        cfg.claude.login_command = "'wsl' codex login".into();
        cfg.codex.login_command = "'wsl.exe' codex login".into();
        cfg.gemini.login_command = r#""C:\Windows\System32\WSL.EXE" codex login"#.into();
        cfg.grok.login_command = "wsl codex login".into();

        let status = cli_status(&cfg, Some(wsl_of(&mock)));
        assert!(
            status.values().all(|s| *s == CliStatus::Error),
            "{status:?}"
        );
        assert_eq!(status.len(), 4);
        assert_eq!(
            mock.calls(),
            vec![
                WslCall::ListDistributions,
                WslCall::ShellStrategy("Ubuntu-22.04".into()),
            ]
        );
    }

    #[test]
    fn ordinary_guest_cli_detection_and_literal_argv_are_preserved() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_command_output(CommandOutput {
            code: 0,
            stdout: "/synthetic/cli\n".into(),
            stderr: String::new(),
        });
        let mut cfg = AppConfig::default();
        cfg.codex.login_command = r#""/opt/my tools/codex" login --label "ñ&|;$HOME""#.into();

        let status = cli_status(&cfg, Some(wsl_of(&mock)));
        assert_eq!(status["codex"], CliStatus::Ready);
        let expected_probe = WslCall::RunCommand(
            "Ubuntu-22.04".into(),
            [
                "bash",
                "-c",
                wsl::SCRIPT_COMMAND_V,
                "quorb",
                "/opt/my tools/codex",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        );
        assert!(mock.calls().contains(&expected_probe), "{:?}", mock.calls());

        let argv = prepare_wsl_login(&wsl_of(&mock), "codex", &cfg.codex.login_command, &None)
            .expect("ordinary guest login argv");
        assert_eq!(
            argv,
            vec![
                "wsl.exe",
                "-d",
                "Ubuntu-22.04",
                "-e",
                "bash",
                "-lc",
                WSL_LOGIN_WRAP,
                "quorb",
                "/opt/my tools/codex",
                "login",
                "--label",
                "ñ&|;$HOME",
            ]
        );
        assert_eq!(mock.calls().last(), Some(&expected_probe));
    }

    /// #92: la CLI se detecta DENTRO de la distro (Running) con `command -v`.
    #[test]
    fn cli_available_detects_inside_a_running_distro() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_command_output(CommandOutput {
            code: 0,
            stdout: "/usr/bin/codex\n".into(),
            stderr: String::new(),
        });
        assert!(matches!(
            cli_check(&wsl_of(&mock), "codex").expect("sonda"),
            CliCheck::Ready(shell) if shell == ShellStrategy::BashLogin
        ));
        // CLI ausente dentro de la distro (exit 127 de `command -v`).
        mock.set_command_output(CommandOutput {
            code: 127,
            stdout: String::new(),
            stderr: String::new(),
        });
        assert!(matches!(
            cli_check(&wsl_of(&mock), "codex").expect("sonda"),
            CliCheck::Missing
        ));
    }

    /// #92 (criterio 8): una distro STOPPED no se despierta por un sondeo;
    /// se reporta como no disponible sin lanzar nada dentro.
    #[test]
    fn cli_available_does_not_wake_a_stopped_distro() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Stopped)]);
        assert!(matches!(
            cli_check(&wsl_of(&mock), "codex").expect("sin despertar"),
            CliCheck::Stopped
        ));
        assert!(
            mock.calls()
                .iter()
                .all(|c| !matches!(c, WslCall::RunCommand(..) | WslCall::ShellStrategy(..))),
            "no se sondea una distro parada, llamadas: {:?}",
            mock.calls()
        );
    }

    /// Distro configurada que no existe en la enumeración: error explícito.
    #[test]
    fn cli_available_reports_unknown_distro() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Debian", DistroState::Running)]);
        let err = cli_check(&wsl_of(&mock), "codex").unwrap_err();
        assert!(err.contains("no está instalada"), "{err}");
    }

    /// F14: el login se TOKENIZA (no viaja como un único elemento) y cada
    /// token queda como argumento posicional del script `exec "$@"`; la
    /// carpeta de la cuenta viaja con `env` dentro del guest (sin WSLENV).
    #[test]
    fn wsl_login_argv_tokenizes_program_and_args_and_applies_env_inside() {
        let argv = wsl_login_argv(
            "Ubuntu 24.04",
            ShellStrategy::BashLogin,
            "codex login --device-auth",
            &None,
        )
        .expect("argv");
        assert_eq!(
            argv,
            vec![
                "wsl.exe",
                "-d",
                "Ubuntu 24.04",
                "-e",
                "bash",
                "-lc",
                // El login corre con `"$@"` y después se abre el shell: la
                // consola no se cierra si el CLI falla (revisión PR #92).
                "\"$@\"; exec \"${SHELL:-/bin/sh}\"",
                "quorb",
                "codex",
                "login",
                "--device-auth",
            ]
        );
        // AC6: no-ASCII y metacaracteres viajan como DATO (token), no
        // interpretados por el host.
        let odd = wsl_login_argv(
            "Distro Ñandú",
            ShellStrategy::BashLogin,
            "codex login --label \"ñ&|;$HOME\"",
            &None,
        )
        .expect("argv");
        assert!(odd.iter().any(|t| t.to_string_lossy() == "Distro Ñandú"));
        assert!(odd
            .iter()
            .any(|t| t.to_string_lossy().contains("ñ&|;$HOME")));
    }

    /// La carpeta de la cuenta adicional se aplica con `env` DENTRO del
    /// guest: `env CLAUDE_CONFIG_DIR=<ruta> claude …` (sin dependencia de
    /// WSLENV y sin quoting de shell).
    #[test]
    fn wsl_login_argv_applies_the_account_folder_inside_the_guest() {
        let env = Some((
            "CLAUDE_CONFIG_DIR",
            PathBuf::from("/home/user/.quorb/accounts/claude-w1"),
        ));
        let argv = wsl_login_argv(
            "Ubuntu-22.04",
            ShellStrategy::BashLogin,
            "claude --dangerously-skip-permissions",
            &env,
        )
        .expect("argv");
        // La carpeta se asegura ANTES del login (`mkdir -p -- "$1"`): Codex
        // falla si CODEX_HOME no existe (revisión PR #92).
        assert!(
            argv.iter().any(|t| t
                .to_string_lossy()
                .starts_with("mkdir -p -- \"$1\" && shift")),
            "el script asegura la carpeta de sesión: {:?}",
            argv.iter().nth(6)
        );
        // `$1` = carpeta, como dato posicional justo tras el script.
        let folder = argv
            .iter()
            .position(|t| t.to_string_lossy() == "/home/user/.quorb/accounts/claude-w1")
            .expect("carpeta como dato posicional");
        assert_eq!(argv[folder - 1], "quorb", "carpeta es $1");
        assert!(argv.iter().any(
            |t| t.to_string_lossy() == "CLAUDE_CONFIG_DIR=/home/user/.quorb/accounts/claude-w1"
        ));
        let pos = argv.iter().position(|t| t == "env").expect("env presente");
        let prog = argv.iter().position(|t| t == "claude").expect("programa");
        assert!(pos < prog, "env precede al programa");
        assert!(folder < pos, "carpeta ($1) precede a env");
    }

    /// La estrategia de shell DETECTADA llega al argv (bloqueante 3, revisión
    /// 2 PR #92): `ShPosix` → `sh -c`, no `bash -lc` — en una distro sin bash
    /// el login moría en `bash: not found` tras anunciarse la CLI como lista.
    #[test]
    fn wsl_login_argv_uses_the_detected_shell_strategy() {
        let posix =
            wsl_login_argv("Ubuntu-22.04", ShellStrategy::ShPosix, "codex", &None).expect("argv");
        let sh = posix
            .iter()
            .position(|t| t.to_string_lossy() == "sh")
            .expect("sh presente");
        assert_eq!(posix[sh + 1].to_string_lossy(), "-c");
        assert!(
            !posix.iter().any(|t| t.to_string_lossy() == "bash"),
            "sin bash en la distro, el argv no puede invocarlo"
        );
        // BashLogin sigue usando `bash -lc`.
        let login =
            wsl_login_argv("Ubuntu-22.04", ShellStrategy::BashLogin, "codex", &None).expect("argv");
        let bash = login
            .iter()
            .position(|t| t.to_string_lossy() == "bash")
            .expect("bash presente");
        assert_eq!(login[bash + 1].to_string_lossy(), "-lc");
    }

    /// AC7: el comando del usuario se ejecuta DENTRO de la distro y no
    /// recibe un `wsl` adicional; la semántica se documenta aquí (el
    /// ejecutable `wsl.exe` solo aparece UNA vez, como lanzador del host).
    #[test]
    fn wsl_login_argv_has_a_single_launcher_and_no_double_wsl() {
        let argv = wsl_login_argv(
            "Ubuntu-22.04",
            ShellStrategy::BashLogin,
            "codex login --device-auth",
            &None,
        )
        .expect("argv");
        assert_eq!(
            argv.iter().filter(|t| *t == "wsl.exe").count(),
            1,
            "un solo wsl.exe"
        );
        // Si el usuario escribiera un comando que YA empieza por wsl, seguiría
        // siendo un DATO del guest (no se le antepone otro wsl.exe): el token
        // `wsl` vive después de `quorb` (posiciones 2+), nunca como lanzador.
        let double = wsl_login_argv(
            "Ubuntu-22.04",
            ShellStrategy::BashLogin,
            "wsl codex login",
            &None,
        )
        .expect("argv");
        let quorb = double.iter().position(|t| t == "quorb").expect("argv0");
        let guest_wsl = double
            .iter()
            .position(|t| t == "wsl")
            .expect("el token del comando viaja al guest");
        assert!(guest_wsl > quorb, "«wsl» del comando no es el lanzador");
        assert_eq!(
            double.iter().filter(|t| *t == "wsl.exe").count(),
            1,
            "un solo lanzador wsl.exe"
        );
        assert_eq!(
            double.last().map(|t| t.to_string_lossy()),
            Some("login".into())
        );
    }

    /// `cli_status` consulta la distro cuando el entorno es WSL; en host
    /// sigue siendo la detección de Windows de siempre (no rompe).
    #[test]
    fn cli_status_uses_the_distro_when_wsl_and_keeps_host_otherwise() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_command_output(CommandOutput {
            code: 0,
            stdout: "/usr/bin/claude\n".into(),
            stderr: String::new(),
        });
        let mut cfg = AppConfig::default();
        cfg.claude.login_command = "claude".into();
        cfg.codex.login_command = "codex login".into();
        let wsl_status = cli_status(&cfg, Some(wsl_of(&mock)));
        assert_eq!(wsl_status["claude"], CliStatus::Ready);
        // El mock responde 0 a TODO `command -v`; codex/gemini/grok también
        // aparecen detectados (el stub responde igual).
        assert!(wsl_status.len() == 4);
        // En host la detección depende de las CLIs que tenga instaladas el
        // runner; no fijar su resultado. Solo comprobar que devuelve los
        // cuatro proveedores y que la ruta host sigue operativa.
        let host_status = cli_status(&cfg, None);
        assert_eq!(host_status.len(), 4);
        assert!(host_status
            .values()
            .all(|s| matches!(s, CliStatus::Ready | CliStatus::Missing)));
    }

    /// El contrato distingue «distro detenida» (Stopped) de «CLI ausente»
    /// (Missing): con la distro Stopped la UI NO debe proponer instalar la
    /// CLI, y el sondeo NO la despierta (sin `run_command` ni sondeo de
    /// shell). Escenario que el booleano anterior mostraba como «no
    /// instalada» (revisión PR #92).
    #[test]
    fn cli_status_reports_stopped_without_waking_the_distro_or_probing() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Stopped)]);
        let cfg = AppConfig::default();
        let status = cli_status(&cfg, Some(wsl_of(&mock)));
        assert!(
            status.values().all(|s| *s == CliStatus::Stopped),
            "{status:?}"
        );
        assert!(status.len() == 4);
        // No se ha ejecutado nada dentro de la distro: solo enumeración.
        let calls = mock.calls();
        assert!(
            calls
                .iter()
                .all(|c| matches!(c, crate::wsl::WslCall::ListDistributions)),
            "la distro detenida no se despierta: {calls:?}"
        );
    }

    /// El contrato distingue WSL roto/distro inexistente (Error) de «CLI
    /// ausente»: si la distro no está enumerada, no es un problema de
    /// instalación de la CLI.
    #[test]
    fn cli_status_reports_error_for_an_unknown_distro() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        let cfg = AppConfig::default();
        let status = cli_status(
            &cfg,
            Some(WslLogin {
                adapter: &mock,
                distro: "Otra-Distro",
            }),
        );
        assert!(
            status.values().all(|s| *s == CliStatus::Error),
            "{status:?}"
        );
    }

    /// `wslDistro` vacío (sin configuración) cae a Host: `session_env()`
    /// ya lo guarda en config.rs; aquí se verifica que `cli_status`/login
    /// nunca ven una distro vacía (menor de la revisión PR #92).
    #[test]
    fn empty_wsl_distro_never_reaches_the_wsl_path() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        let mut cfg = AppConfig::default();
        // El usuario eligió SESIÓN WSL pero dejó la distro vacía: en
        // producción `session_env()` cae a Host (config.rs) y el login/detección
        // no deben tocar wsl.exe. Este test cubre ESE caso (revisión PR #92,
        // punto 5): antes solo usaba un cfg ya de host.
        cfg.session_env = crate::config::SessionEnvConfig::Wsl;
        cfg.wsl_distro = "".into();
        assert!(matches!(cfg.session_env(), wsl::SessionEnv::Host));
        let host_status = cli_status(&cfg, None);
        assert!(host_status.len() == 4);
        let calls = mock.calls();
        assert!(
            calls.is_empty(),
            "wsl.exe no se toca con distro vacía: {calls:?}"
        );
    }

    /// #92: si la CLI no está dentro de la distro, el login falla con un
    /// mensaje que dirige a instalarla EN LA DISTRO y NO ofrece el
    /// instalador de Windows.
    #[test]
    fn open_in_wsl_requires_the_cli_inside_the_distro() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_command_output(CommandOutput {
            code: 127,
            stdout: String::new(),
            stderr: String::new(),
        });
        let cfg = AppConfig::default(); // codex.login_command por defecto
        let env: SessionEnv = None;
        let err = prepare_wsl_login(
            &wsl_of(&mock),
            "codex",
            cfg.codex.login_command.trim(),
            &env,
        )
        .unwrap_err();
        assert!(err.contains("no está instalado dentro"), "{err}");
        assert!(
            !err.contains("/K wsl"),
            "no se abre la terminal si la CLI falta"
        );
    }

    /// La carpeta LINUX de la cuenta adicional: `config_dir` absoluto del
    /// guest tal cual; separadores del host o relativos rechazados; sin
    /// config_dir → `home_dir` del canal + `accounts/<provider>-<suffix>`
    #[test]
    fn account_session_dir_linux_uses_config_dir_or_host_layout() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/user"));
        let mk = |dir: Option<String>| Account {
            id: "claude:w1".into(),
            provider: "claude".into(),
            config_dir: dir,
            enabled: true,
            ..Default::default()
        };
        assert_eq!(
            account_session_dir_linux(&mk(Some("/mnt/c/Users/yo/quorb".into())), &wsl_of(&mock))
                .expect("absoluta del guest"),
            PathBuf::from("/mnt/c/Users/yo/quorb")
        );
        // Sin config_dir: MISMA carpeta que en host
        // (`home_dir` del canal + `accounts/<provider>-<suffix>`).
        assert_eq!(
            account_session_dir_linux(&mk(None), &wsl_of(&mock)).expect("defecto"),
            PathBuf::from("/home/user/.quorb/accounts/claude-w1")
        );
        let err = account_session_dir_linux(&mk(Some(r"C:\Users\yo\quorb".into())), &wsl_of(&mock))
            .unwrap_err();
        assert!(err.contains("Windows"), "{err}");
        let err = account_session_dir_linux(&mk(Some("accounts/claude-1".into())), &wsl_of(&mock))
            .unwrap_err();
        assert!(err.contains("absoluta"), "{err}");
    }

    /// #92 (review 2026-11-05): una distro DETENIDA no da un «no instalada»
    /// falso: el login explícito la activa (el propio `wsl -d`). El sondeo
    /// no la despierta: no hubo `command -v` dentro.
    #[test]
    fn open_in_wsl_activates_a_stopped_distro_instead_of_saying_missing() {
        let mock = MockWslAdapter::new();
        mock.set_installed(true);
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Stopped)]);
        // El login EXPLÍCITO resuelve la estrategia de shell aunque la
        // distro esté detenida (la despierta el propio `wsl -d`): el argv
        // reutiliza bash/sh detectado, no asume bash (revisión 2 PR #92).
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        let cfg = AppConfig::default();
        let env: SessionEnv = None;
        let argv = prepare_wsl_login(
            &wsl_of(&mock),
            "codex",
            cfg.codex.login_command.trim(),
            &env,
        )
        .expect("login explícito preparado (la distro se activa al lanzar)");
        assert!(!argv
            .iter()
            .any(|t| t.to_string_lossy().contains("no está instalado dentro")));
        assert!(
            mock.calls()
                .iter()
                .all(|c| !matches!(c, WslCall::RunCommand(..))),
            "el sondeo no despierta la distro, llamadas: {:?}",
            mock.calls()
        );
    }

    /// Con la CLI presente, el login llega al lanzador (no al error de CLI
    /// ausente).
    #[test]
    fn open_in_wsl_with_the_cli_present_reaches_the_launcher() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_command_output(CommandOutput {
            code: 0,
            stdout: "/usr/bin/codex\n".into(),
            stderr: String::new(),
        });
        let cfg = AppConfig::default();
        let env: SessionEnv = None;
        let argv = prepare_wsl_login(
            &wsl_of(&mock),
            "codex",
            cfg.codex.login_command.trim(),
            &env,
        )
        .expect("argv del login");
        assert_eq!(
            argv.first().map(|t| t.to_string_lossy().into_owned()),
            Some("wsl.exe".into())
        );
        assert!(!argv
            .iter()
            .any(|t| t.to_string_lossy().contains("no está instalado dentro")));
    }

    /// La detección y la ejecución usan el MISMO tokenizador (revisión 2 PR
    /// #92): una ruta entre comillas con espacios se detecta como presente
    /// y se ejecuta con su argv exacto — no da por ausente lo que luego se
    /// ejecutaría.
    #[test]
    fn detection_and_execution_agree_on_a_quoted_path_with_spaces() {
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_command_output(CommandOutput {
            code: 0,
            stdout: "/opt/mis herramientas/claude\n".into(),
            stderr: String::new(),
        });
        let cmd = "\"/opt/mis herramientas/claude\" login";
        // La sonda recibe el ejecutable tokenizado (con espacios intactos).
        assert!(
            matches!(
                cli_check(&wsl_of(&mock), &program_of(cmd)).expect("sonda"),
                CliCheck::Ready(_)
            ),
            "una ruta entre comillas se detecta como presente"
        );
        // Y la ejecución lanza ESE MISMO programa como token del guest.
        let argv = prepare_wsl_login(&wsl_of(&mock), "claude", cmd, &None).expect("argv del login");
        assert!(
            argv.iter()
                .any(|t| t.to_string_lossy() == "/opt/mis herramientas/claude"),
            "el ejecutable viaja como token con espacios intactos: {argv:?}"
        );
        // El texto del comando NUNCA va como un único elemento (F14).
        assert!(
            !argv.iter().any(|t| t
                .to_string_lossy()
                .contains("mis herramientas/claude\" login")),
            "el comando no viaja como un solo elemento"
        );
    }

    /// El mensaje de CLI ausente no lleva espacios dobles ni saltos Rare
    /// (se muestra en la UI).
    #[test]
    fn missing_cli_message_has_no_double_spaces() {
        let msg = not_installed_wsl("codex", "codex", "Ubuntu-22.04");
        assert!(!msg.contains("  "), "{msg}");
        assert!(
            msg.contains("no está instalado dentro de «Ubuntu-22.04»"),
            "{msg}"
        );
    }

    /// `account_env`: en host la carpeta es la de siempre; en WSL, la ruta
    /// LINUX de la cuenta (misma regla que la resolución de #91).
    #[test]
    fn account_env_uses_the_host_folder_and_the_guest_folder() {
        let dir = std::env::temp_dir().join(format!("quorb-login-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = AppConfig::default();
        cfg.accounts.push(Account {
            id: "claude:w1".into(),
            provider: "claude".into(),
            config_dir: Some(dir.to_string_lossy().into_owned()),
            enabled: true,
            ..Default::default()
        });
        // Host: la carpeta configurada, tal cual.
        let (provider, env) = account_env("claude:w1", &cfg, None).expect("host");
        assert_eq!(provider, "claude");
        let (var, folder) = env.expect("variable de sesión");
        assert_eq!(var, "CLAUDE_CONFIG_DIR");
        assert_eq!(folder, dir);
        // El MISMO config_dir (ruta del host con `\` o `C:\`) en modo WSL
        // se rechaza: no es una carpeta que el guest pueda leer (diseño de
        // #92/#91).
        let mock = MockWslAdapter::new();
        mock.set_distributions(vec![distro("Ubuntu-22.04", DistroState::Running)]);
        mock.set_shell("Ubuntu-22.04", ShellStrategy::BashLogin);
        mock.set_home("Ubuntu-22.04", PathBuf::from("/home/user"));
        cfg.accounts[0].config_dir = Some(r"C:\Users\yo\quorb".into());
        let err = account_env("claude:w1", &cfg, Some(&wsl_of(&mock))).unwrap_err();
        assert!(
            err.contains("separadores de Windows") || err.contains("absoluta"),
            "{err}"
        );
        // En WSL, un `config_dir` POSIX del guest se usa tal cual: el login
        // escribe donde la resolución de #91 lee.
        cfg.accounts[0].config_dir = Some("/mnt/c/Users/yo/quorb".into());
        let (_, env) = account_env("claude:w1", &cfg, Some(&wsl_of(&mock))).expect("wsl");
        let (_, folder) = env.expect("variable de sesión");
        assert_eq!(folder, PathBuf::from("/mnt/c/Users/yo/quorb"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// EVIDENCIA REAL en Windows + WSL (issue #92, AC9).
///
/// Estos tests NO corren en el CI normal: llevan `#[ignore]` y solo se
/// ejecutan en el lab `wsl-login-evidence.yml` (runner Windows con WSL2),
/// donde la distro y sus shims son reales. Simulan nada: hablan con
/// `wsl.exe` de verdad.
#[cfg(windows)]
#[cfg(test)]
mod wsl_evidence {
    use super::*;
    use crate::wsl::{RealWslAdapter, SessionResolver, WslAdapter};

    fn distro() -> String {
        std::env::var("QUORB_WSL_EVIDENCE_DISTRO").expect(
            "el workflow debe exportar QUORB_WSL_EVIDENCE_DISTRO (distro real de la evidencia)",
        )
    }

    /// GAP1 — Una CLI presente SOLO dentro de la distro se reconoce sin
    /// requerir la misma CLI en Windows (AC1).
    #[test]
    #[ignore = "requiere WSL real (evidencia #92)"]
    fn gap1_detects_a_cli_that_only_exists_inside_the_distro() {
        let adapter = RealWslAdapter::new();
        let d = distro();
        let wsl = WslLogin {
            adapter: &adapter,
            distro: &d,
        };
        // Los shims se plantan SOLO en el guest (el PATH de Windows no los
        // tiene): la detección debe encontrarlos dentro de la distro.
        for cli in ["codex", "claude"] {
            assert!(
                matches!(cli_check(&wsl, cli), Ok(CliCheck::Ready(_))),
                "«{cli}» debe estar Ready dentro de la distro"
            );
        }
        // Y el PATH de Windows no los tiene: la detección no viene de ahí.
        let out = std::process::Command::new("where.exe")
            .arg("codex")
            .output()
            .expect("where.exe");
        assert!(
            !out.status.success(),
            "codex no debe estar en el PATH de Windows (si lo está, el shim no era exclusivo del guest)"
        );
    }

    /// GAP2 — El comando de login se ejecuta DENTRO de la distro y escribe
    /// allí (AC2/AC3): el shim deja un marker en el guest.
    #[test]
    #[ignore = "requiere WSL real (evidencia #92)"]
    fn gap2_login_command_runs_inside_the_distro() {
        let d = distro();
        // Mismo argv que compone la app (script constante + comando como dato).
        let argv =
            wsl_login_argv(&d, ShellStrategy::BashLogin, "codex", &None).expect("argv del login");
        let out = std::process::Command::new("wsl.exe")
            .args(argv.iter().skip(1))
            .output()
            .expect("wsl.exe");
        assert!(
            out.status.success(),
            "el login debe ejecutarse en la distro: {:?} {:?}",
            out.stdout,
            out.stderr
        );
        // El marker del shim está DENTRO de la distro.
        let check = std::process::Command::new("wsl.exe")
            .args(["-d", &d, "-e", "test", "-f", "/tmp/quorb-evidence-login"])
            .output()
            .expect("wsl.exe");
        assert!(
            check.status.success(),
            "el shim debe haber escrito dentro de la distro"
        );
    }

    /// GAP3 — La lectura de sesión usa la ruta EXACTA que la resolución
    /// espera (AC3): `<home>/.quorb/accounts/claude-w1/.credentials.json`.
    #[test]
    #[ignore = "requiere WSL real (evidencia #92)"]
    fn gap3_session_read_uses_the_resolved_path_inside_the_distro() {
        let adapter: std::sync::Arc<dyn WslAdapter> = std::sync::Arc::new(RealWslAdapter::new());
        let d = distro();
        let home = adapter.resolve_home(&d).expect("home de la distro");
        let r = SessionResolver::for_wsl(adapter, d.clone(), home, crate::i18n::Locale::Es);
        let path = r.default_path(&crate::wsl::guest_relative(&[
            ".quorb",
            "accounts",
            "claude-w1",
            ".credentials.json",
        ]));
        // `read` (no `read_async`) a propósito: este test no tiene runtime
        // de tokio, y la evidencia es la ruta resuelta DENTRO de la distro —
        // `read` y `read_async` comparten el mismo `adapter.read_file`.
        let contents = r
            .read(&path)
            .expect("la sesión plantada dentro de la distro debe leerse");
        assert!(
            contents.contains("v-evidencia-92"),
            "contenido inesperado: {contents}"
        );
    }

    /// GAP4 — Login real de una cuenta ADICIONAL dentro de la distro
    /// (revisión PR #253: evidencia pedida para cerrar #92, sin datos
    /// personales). El argv lleva la carpeta de la cuenta, el CLI (shim)
    /// escribe ahí y la MISMA ruta que lee la app encuentra la sesión.
    #[test]
    #[ignore = "requiere WSL real (evidencia #92)"]
    fn gap4_extra_account_login_writes_inside_its_guest_folder() {
        let adapter: std::sync::Arc<dyn WslAdapter> = std::sync::Arc::new(RealWslAdapter::new());
        let d = distro();
        let home = adapter.resolve_home(&d).expect("home de la distro");
        let wsl = WslLogin {
            adapter: adapter.as_ref(),
            distro: &d,
        };
        let cfg = AppConfig {
            accounts: vec![Account {
                id: "claude:w2".into(),
                provider: "claude".into(),
                enabled: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let (_, env) = account_env("claude:w2", &cfg, Some(&wsl)).expect("entorno de la cuenta");
        let (var, dir) = env.expect("la cuenta adicional lleva su carpeta");
        assert_eq!(var, "CLAUDE_CONFIG_DIR");
        assert!(
            dir.starts_with("/"),
            "la carpeta debe ser POSIX del guest: {}",
            dir.display()
        );
        // Mismo argv que compone la app, con la carpeta de la cuenta.
        let argv = wsl_login_argv(
            &d,
            ShellStrategy::BashLogin,
            "claude",
            &Some((var, dir.clone())),
        )
        .expect("argv del login");
        let out = std::process::Command::new("wsl.exe")
            .args(argv.iter().skip(1))
            .output()
            .expect("wsl.exe");
        assert!(
            out.status.success(),
            "el login debe ejecutarse en la distro: {:?} {:?}",
            out.stdout,
            out.stderr
        );
        // El CLI escribió en la carpeta de la CUENTA (no en la del host). La
        // ruta se compone con POSIX: `PathBuf::join` en Windows pondría `\`
        // y el guest lo leería como parte del nombre (hallazgo del lab).
        let file = format!(
            "{}/.credentials.json",
            dir.to_string_lossy().trim_end_matches('/')
        );
        let check = std::process::Command::new("wsl.exe")
            .args(["-d", &d, "-e", "cat", &file])
            .output()
            .expect("wsl.exe cat");
        assert!(
            check.status.success(),
            "el fichero de la cuenta debe existir en el guest: {:?}",
            check.stderr
        );
        let contents = String::from_utf8_lossy(&check.stdout);
        assert!(
            contents.contains("v-adicional-92"),
            "contenido inesperado: {contents}"
        );
        // Y la MISMA ruta que usa la app (resolución de sesiones) la lee.
        let r = SessionResolver::for_wsl(adapter, d.clone(), home, crate::i18n::Locale::Es);
        let path = crate::providers::account_session_path(&cfg.accounts[0], Some(&r))
            .expect("ruta de la cuenta")
            .expect("la cuenta tiene sesión");
        let read = r
            .read(std::path::Path::new(&path))
            .expect("leer la sesión de la cuenta adicional");
        assert!(read.contains("v-adicional-92"), "{read}");
    }
}
