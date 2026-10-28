//! Login OAuth delegado en los CLIs oficiales.
//!
//! Anthropic y OpenAI no permiten registrar clientes OAuth de terceros para
//! las suscripciones de consumo, así que la app abre el flujo oficial
//! (`claude` / `codex login`) en una terminal nueva: el navegador hace el
//! OAuth con el proveedor y el CLI guarda la sesión, que luego leemos.
//!
//! Las cuentas adicionales usan el mismo comando con su propia carpeta de sesión
//! (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` o `GEMINI_CLI_HOME`), así no pisan la principal.

use crate::config::AppConfig;
use std::path::{Path, PathBuf};

/// `id`: el proveedor (cuenta principal) o el id de una cuenta adicional.
pub fn open(id: &str, cfg: &AppConfig) -> Result<(), String> {
    let mut env = None;
    let provider = match cfg.accounts.iter().find(|a| a.id == id) {
        Some(a) => {
            let var = a
                .session_env()
                .ok_or_else(|| format!("La cuenta «{}» no tiene login por CLI", a.label))?;
            let dir = a.session_dir(&crate::providers::home());
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("No pude crear {}: {e}", dir.display()))?;
            env = Some((var, dir));
            a.provider.as_str()
        }
        None => id,
    };
    let command = match provider {
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
    // Antes de abrir la terminal se comprueba que el CLI está instalado: si no, la
    // consola solo diría «no se reconoce como un comando» y no sabrías qué hacer.
    let program = program_of(command);
    let extra_dir = match find_program(&program) {
        Found::OnPath => None,
        Found::In(dir) => Some(dir),
        Found::Missing => return Err(not_installed(provider, &program)),
    };
    spawn_terminal(command, env, extra_dir)
}

/// ¿Está instalado el CLI de login de cada proveedor que lo usa? Para avisar en
/// Ajustes antes de que pulses «Iniciar sesión».
pub fn cli_status(cfg: &AppConfig) -> std::collections::BTreeMap<String, bool> {
    [
        ("claude", &cfg.claude.login_command),
        ("codex", &cfg.codex.login_command),
        ("gemini", &cfg.gemini.login_command),
        ("grok", &cfg.grok.login_command),
    ]
    .into_iter()
    .map(|(p, c)| {
        (
            p.to_string(),
            !matches!(find_program(&program_of(c)), Found::Missing),
        )
    })
    .collect()
}

/// Primer elemento del comando (`codex login` → `codex`), sin comillas.
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
/// Solo la consumen las ramas Windows/Linux: en macOS el PATH viaja dentro del
/// texto del script de Terminal, no por herencia del entorno.
#[cfg(any(test, not(target_os = "macos")))]
fn path_with(extra: Option<PathBuf>) -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(fresh_path_dirs());
    path_with_current(extra, std::env::join_paths(dirs).ok())
}

/// Antepone `extra` a `current` (el PATH actual) sin tocar el entorno real.
#[cfg(any(test, not(target_os = "macos")))]
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
