//! Harness WSLENV del lab W3 (issue #90) — VÍA REAL DEL ADAPTADOR.
//!
//! Sustituye al binario antiguo (`src-tauri/src/bin/wsl-wslenv-probe.rs`,
//! eliminado): ese duplicaba la política de `env_with` en un `match` y el
//! spawn seguía yendo por PowerShell. Este ejemplo:
//!
//! 1. Construye `RealWslAdapter::new()` (ProcessRunner REAL, `wsl.exe`
//!    descubierto) y detecta el shell real con `shell_strategy` (F12).
//! 2. Reporta el WSLENV que produce el CÓDIGO REAL (`env_with`, la misma
//!    función que `run_command` usa internamente) para el lote de
//!    variables de sesión.
//! 3. Ejecuta `run_command(distro, shell, &["env"], &session)`: el remoto
//!    corre el `env` constante y el harness parsea la salida en Rust.
//!    Distingue AUSENTE (sin línea), VACÍO (línea `KEY=`) y PRESENTE
//!    (valor) — el equivalente de `${VAR+set}`, sin confundir ausente con
//!    vacía.
//!
//! Así se ejercita de verdad el camino de producción: `base_env()`,
//! `env_with()` con varias variables, `env_clear().envs()` del
//! ProcessRunner y `run_scoped()` con su cancelación acotada.
//!
//! Uso: `wsl-wslenv-probe.exe <distro> <KEY=VALUE>... --probe <KEY>...`
//!
//! Emite JSON: `{"wslenv":"<cadena>","probes":{"KEY":{"present":bool,"value":"..."}}}`.
//! Se compila como ejemplo (no entra en el producto): `cargo build -p quorb
//! --example wsl-wslenv-probe`, y vive en `src-tauri/examples/`.

use quorb_lib::wsl::{RealWslAdapter, WslAdapter};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::ExitCode;

fn parse_env(raw: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in raw.lines() {
        if let Some((k, v)) = line.split_once('=') {
            // La última ocurrencia gana (como en un entorno real).
            map.insert(k.to_string(), v.to_string());
        }
    }
    map
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 4 {
        eprintln!("uso: wsl-wslenv-probe <distro> <KEY=VALUE>... --probe <KEY>...");
        return ExitCode::from(2);
    }
    let distro = argv[1].clone();

    let mut session: Vec<(&str, &str)> = Vec::new();
    let mut probes: Vec<&str> = Vec::new();
    let mut i = 2;
    let mut in_probe = false;
    while i < argv.len() {
        match argv[i].as_str() {
            "--probe" => in_probe = true,
            tok if in_probe => probes.push(tok),
            tok => {
                let (k, v) = tok.split_once('=').unwrap_or((tok, ""));
                session.push((k, v));
            }
        }
        i += 1;
    }
    if session.is_empty() || probes.is_empty() {
        eprintln!("uso: wsl-wslenv-probe <distro> <KEY=VALUE>... --probe <KEY>...");
        return ExitCode::from(2);
    }

    let adapter = RealWslAdapter::new();

    // WSLENV producido por el CÓDIGO REAL (env_with, la fusión que
    // run_command aplica de verdad).
    let merged = adapter.env_with(&session);
    let wslenv = merged.get("WSLENV").cloned().unwrap_or_default();

    // Shell real de la distro (F12: command -v bash).
    let shell = match adapter.shell_strategy(&distro) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("shell_strategy falló para {distro}: {e:?}");
            return ExitCode::from(1);
        }
    };

    // Comando remoto CONSTANTE: `env`. Los datos (variables de sesión) van
    // por el env del proceso, no interpolados en ningún script.
    let output = match adapter.run_command(&distro, shell, &["env"], &session) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("run_command falló para {distro}: {e:?}");
            return ExitCode::from(1);
        }
    };

    let remote_env = parse_env(&output.stdout);
    let mut probes_json = serde_json::Map::new();
    for key in &probes {
        let entry = match remote_env.get(*key) {
            Some(v) => json!({ "present": true, "value": v }),
            None => json!({ "present": false, "value": null }),
        };
        probes_json.insert((*key).to_string(), entry);
    }

    let result: Value = json!({
        "distro": distro,
        "shell": format!("{shell:?}"),
        "wslenv": wslenv,
        "probes": probes_json,
    });
    println!("{result}");
    ExitCode::SUCCESS
}
