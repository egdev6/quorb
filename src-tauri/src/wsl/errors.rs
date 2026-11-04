//! Parseo de la salida de `wsl.exe` y clasificación de errores.
//!
//! Contrato fijado por el lab W0 (W0-EVIDENCE.md):
//! - **F1 — encoding dual**: sin `WSL_UTF8=1`, `wsl.exe` escribe **UTF-16LE
//!   sin BOM** cuando la salida está redirigida; con `WSL_UTF8=1` escribe
//!   UTF-8 plano. El runner reutilizable entrega `String` con
//!   `from_utf8_lossy`, así que una salida UTF-16 llega con los bytes
//!   originales convertidos en caracteres de reemplazo: **no es
//!   recuperable**. Por eso `WSL_UTF8=1` es obligatorio en los hijos; si
//!   aun así la salida viene entrelazada, se reporta como error
//!   accionable en vez de parsear basura.
//! - **F2 — exit codes ruidosos**: hay que distinguir por el token de
//!   texto `Wsl/Service/WSL_E_DISTRO_NOT_FOUND`, "no installed
//!   distributions" e "Invalid command line argument".

use super::{Distribution, DistroState, WslError};
use crate::cli_process::CommandOutput;

/// ¿La salida viene entrelazada en UTF-16 (bytes con NUL intercalados)?
///
/// Es la forma que `wsl.exe` produce sin `WSL_UTF8=1` (F1). Con el runner
/// de texto el contenido original ya está perdido (`from_utf8_lossy`),
/// así que solo podemos detectarlo y fallar con un diagnóstico claro.
pub fn looks_utf16(raw: &str) -> bool {
    let chars: Vec<char> = raw.chars().collect();
    if chars.len() < 4 {
        return false;
    }
    // En UTF-16LE cada carácter ASCII va seguido de su NUL, así que la
    // salida llega con NUL intercalados. Se mide la DENSIDAD de NUL en vez
    // de la paridad: con no-ASCII (p. ej. cirílico) los bytes ya no caen en
    // posiciones alternas, y un texto UTF-8 legítimo no contiene NUL.
    let nuls = chars.iter().filter(|c| **c == '\0').count();
    nuls > 0 && nuls * 3 >= chars.len()
}

/// Clasifica la salida de un comando fallido de `wsl.exe`.
///
/// `distro` es el nombre de la distro objetivo (para el error
/// `DistroNotFound`); puede ser `None` en comandos sin distro.
///
/// El payload de los errores es una etiqueta saneada, nunca la salida
/// cruda (W1 §7: sin tokens en UI/logs).
pub fn classify(output: &CommandOutput, distro: Option<&str>) -> Option<WslError> {
    let text = format!("{}{}", output.stdout, output.stderr);
    let lower = text.to_lowercase();

    if text.contains("WSL_E_DISTRO_NOT_FOUND")
        || lower.contains("not registered")
        || lower.contains("no such distribution")
    {
        return Some(WslError::DistroNotFound(
            distro.unwrap_or_default().to_string(),
        ));
    }
    if lower.contains("no installed distributions")
        || lower.contains("has no installed distributions")
    {
        return Some(WslError::NoDistributions);
    }
    if lower.contains("invalid command line argument") {
        return Some(WslError::InvalidArgument(
            "wsl.exe rechazó los argumentos (Invalid command line argument)".into(),
        ));
    }
    // `wsl.exe` existe (p. ej. en una imagen de Windows sin el subsistema
    // habilitado) pero el propio WSL no está disponible: `--version` sale
    // con "Windows Subsystem for Linux is not installed". Es el mismo
    // estado que el spawn fallido (F6).
    if lower.contains("is not installed") || lower.contains("not enabled") {
        return Some(WslError::WslNotInstalled);
    }
    None
}

/// Parsea `wsl --list --verbose`.
///
/// Formato por línea: `NOMBRE  ESTADO  VERSIÓN`, con la cabecera
/// `NAME STATE VERSION` al principio. El nombre va por delante del
/// estado y la versión, así que se separa desde la derecha: un nombre con
/// espacios se conserva entero.
///
/// La distro por defecto lleva un `*` delante (evidencia F12 del lab:
/// `* quorb_w0`); se quita del nombre, que no puede empezar por `*`
/// (los nombres válidos de F3 no lo permiten).
///
/// Se ignoran las líneas que no encajan (cabecera, notas al pie, avisos):
/// solo cuentan las que terminan en un estado conocido y una versión.
pub fn parse_list_verbose(raw: &str) -> Vec<Distribution> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 3 {
            continue;
        }
        let version = tokens[tokens.len() - 1];
        let state = tokens[tokens.len() - 2];
        let name = tokens[..tokens.len() - 2].join(" ");
        let Some(state) = parse_state(state) else {
            continue;
        };
        let Ok(version) = version.parse::<u8>() else {
            continue;
        };
        // `wsl --list --verbose` marca la distro por defecto con `*`.
        let name = name.strip_prefix('*').map(str::trim).unwrap_or(&name);
        if name.is_empty() {
            continue;
        }
        out.push(Distribution {
            name: name.to_string(),
            state,
            version,
        });
    }
    out
}

fn parse_state(token: &str) -> Option<DistroState> {
    match token {
        "Running" => Some(DistroState::Running),
        "Stopped" => Some(DistroState::Stopped),
        "Installing" => Some(DistroState::Installing),
        "Converting" => Some(DistroState::Converting),
        "Uninstalling" => Some(DistroState::Uninstalling),
        _ => None,
    }
}

/// Extrae el campo 6 de una línea de `getent passwd` (el home).
///
/// `getent passwd quorbuser` → `quorbuser:x:1000:1000::/home/quorbuser:/bin/sh`
/// El pipe `| cut -d: -f6` del comando canónico queda descartado: exigiría
/// un pipeline de shell, y F14 exige que los datos viajen como parámetros
/// (el parseo va en Rust).
pub fn parse_passwd_home(line: &str) -> Option<String> {
    let mut fields = line.split(':');
    let home = fields.nth(5)?;
    if home.is_empty() {
        None
    } else {
        Some(home.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_verbose_list_table() {
        let raw = "\
NAME            STATE           VERSION
Ubuntu-22.04   Running         2
Debian          Stopped         2
Alpine          Installing      1
";
        let distros = parse_list_verbose(raw);
        assert_eq!(distros.len(), 3);
        assert_eq!(distros[0].name, "Ubuntu-22.04");
        assert_eq!(distros[0].state, DistroState::Running);
        assert_eq!(distros[0].version, 2);
        assert_eq!(distros[1].state, DistroState::Stopped);
        assert_eq!(distros[2].state, DistroState::Installing);
        assert_eq!(distros[2].version, 1);
    }

    /// El nombre va por delante del estado: uno con espacios se conserva
    /// entero (el parseo es desde la derecha).
    #[test]
    fn keeps_names_with_spaces() {
        let raw = "NAME         STATE     VERSION\nHello World  Running   2\n";
        let distros = parse_list_verbose(raw);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Hello World");
    }

    /// La cabecera y el ruido al pie no son distros.
    #[test]
    fn ignores_header_and_trailing_noise() {
        let raw = "\
NAME            STATE           VERSION
Ubuntu-22.04   Running         2

WSL2 is not installed with this build.
";
        let distros = parse_list_verbose(raw);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu-22.04");
    }

    /// F2: los tokens de texto distinguen los estados; el exit code no
    /// basta (-1 en todos los casos de error).
    #[test]
    fn classifies_error_tokens() {
        let out = |stdout: &str, stderr: &str| CommandOutput {
            code: -1,
            stdout: stdout.into(),
            stderr: stderr.into(),
        };
        assert_eq!(
            classify(
                &out("", "Wsl/Service/WSL_E_DISTRO_NOT_FOUND"),
                Some("Debian")
            ),
            Some(WslError::DistroNotFound("Debian".into()))
        );
        assert_eq!(
            classify(
                &out(
                    "Windows Subsystem for Linux has no installed distributions.",
                    ""
                ),
                None
            ),
            Some(WslError::NoDistributions)
        );
        assert_eq!(
            classify(&out("", "Invalid command line argument"), None),
            Some(WslError::InvalidArgument(
                "wsl.exe rechazó los argumentos (Invalid command line argument)".into()
            ))
        );
        // Una salida sin token conocido no se clasifica: el llamador decide.
        assert_eq!(classify(&out("whatever", ""), None), None);
    }

    /// F1: la forma entrelazada (UTF-16) se detecta; la UTF-8 normal no.
    #[test]
    fn detects_utf16_interleaved_output() {
        assert!(looks_utf16("U\0b\0u\0n\0t\0u\0"));
        assert!(!looks_utf16("Ubuntu-22.04\nDebian\n"));
        assert!(!looks_utf16(""));
    }

    /// F1 con no-ASCII: los bytes ya no caen en posiciones alternas, pero
    /// la densidad de NUL sigue delatando el UTF-16 (si no, se parsearía
    /// basura en vez de reportar el error accionable).
    #[test]
    fn detects_utf16_with_non_ascii_names() {
        // "Quorb-Проверка" en UTF-16LE pasa por el runner de texto como
        // caracteres alternos con NUL.
        let raw: String = "Quorb-Проверка".chars().flat_map(|c| [c, '\0']).collect();
        assert!(looks_utf16(&raw));
    }

    /// `wsl --list --verbose` marca la distro por defecto con `*` (F12):
    /// el nombre debe quedar limpio, si no la distro más común parece
    /// ausente.
    #[test]
    fn strips_the_default_distro_marker() {
        let raw = "NAME            STATE           VERSION\n* quorb_w0      Stopped         2\nDebian          Running         2\n";
        let distros = parse_list_verbose(raw);
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "quorb_w0");
        assert_eq!(distros[1].name, "Debian");
    }

    /// F6: `wsl.exe` presente pero con el subsistema no habilitado es el
    /// mismo estado que el binario ausente.
    #[test]
    fn classifies_wsl_not_installed_token() {
        let out = CommandOutput {
            code: -1,
            stdout: String::new(),
            stderr: "Windows Subsystem for Linux is not installed.".into(),
        };
        assert_eq!(classify(&out, None), Some(WslError::WslNotInstalled));
    }

    /// El home es el campo 6 de `getent passwd`.
    #[test]
    fn extracts_the_home_field() {
        assert_eq!(
            parse_passwd_home("quorbuser:x:1000:1000::/home/quorbuser:/bin/sh").as_deref(),
            Some("/home/quorbuser")
        );
        assert_eq!(parse_passwd_home("quorbuser:x:1000:1000:::/bin/sh"), None);
        assert_eq!(parse_passwd_home("basura"), None);
    }
}
