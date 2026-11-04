// Harness F14 para el lab W3 (issue #90).
//
// Mide la DOBLE FRONTERA con la vía de lanzamiento REAL del adaptador:
//   pwsh -> este binario (Rust `Command::args` -> CreateProcessW con quoting
//   MSVCRT/CommandLineToArgvW) -> wsl.exe -> sh -c <script CONSTANTE> -> exec.
// El punto que el reviewer reclamó: los argumentos ORIGINALES (espacios,
// comillas, $, backtick, newline, glob, --, ;, C:\...) deben atravesar esa
// frontera byte a byte; el harness pwsh anterior no podía medirlo porque
// `& wsl.exe` de PowerShell no aplica el quoting MSVCRT y wsl.exe re-parsea
// la línea (microsoft/WSL WslClient.cpp, ParseLegacyArguments).
//
// SCRIPT_EXEC_PIDFILE es IDÉNTICO al de src-tauri/src/wsl/process.rs
// (5bb622b): script constante, datos como parámetros posicionales, nada se
// interpola. El pidfile no altera la salida: solo fija el PID de la sesión
// remota y se limpia al final.
//
// Uso: wsl-f14-probe.exe <distro> <value>
// Emite JSON plano: {"exit":N,"stdout_b64":"..","stdout_len":N,"stderr_b64":".."}
// (sin serde; b64 de la salida cruda para transporte seguro del log).
use std::process::{Command, ExitCode, Output};

const SCRIPT_EXEC_PIDFILE: &str = "b=\"$1\" && shift && mkdir -m 700 \"$b\" && d=$(mktemp -d \"$b/XXXXXX\") && umask 077 && echo $$ > \"$d/pid\" && exec \"$@\"";

fn base64(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn run(distro: &str, value: &str) -> Output {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = format!("/tmp/quorb-f14-{}-{nanos}", std::process::id());
    // Igual que shell_args(ShPosix) + run_scoped del adaptador: el script va
    // como ELEMENTO de argv y el valor como posicional ($1 tras argv0 "quorb"
    // y el base). Command::args aplica el quoting MSVCRT de CreateProcessW.
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-d", distro, "-e", "sh", "-c", SCRIPT_EXEC_PIDFILE, "quorb", &base, "printf", "%s", value]);
    let out = cmd
        .output()
        .unwrap_or_else(|e| panic!("spawn wsl.exe: {e}"));
    // Limpieza del base (igual que el adaptador: rm -rf en exito/error).
    let _ = Command::new("wsl.exe")
        .args(["-d", distro, "-e", "sh", "-c", "rm -rf \"$1\"", "quorb", &base])
        .output();
    out
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    // argv[0] = exe; argv[1] = distro; argv[2] = UN solo valor (con o sin
    // espacios/comillas: el runtime MSVCRT ya lo cotizó al parsear argv).
    if argv.len() != 3 {
        eprintln!("uso: wsl-f14-probe <distro> <value>");
        return ExitCode::from(2);
    }
    let distro = &argv[1];
    let value = &argv[2];
    let out = run(distro, value);
    let exit = out.status.code().unwrap_or(-1);
    let stdout_b64 = base64(&out.stdout);
    let stderr_b64 = base64(&out.stderr);
    println!(
        "{{\"exit\":{exit},\"stdout_b64\":\"{stdout_b64}\",\"stdout_len\":{},\"stderr_b64\":\"{stderr_b64}\"}}",
        out.stdout.len()
    );
    ExitCode::SUCCESS
}