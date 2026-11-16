//! Antigravity (IDE de Google) — cuota por modelo de su agente.
//!
//! Antigravity no guarda una sesión reutilizable en disco (como `oauth_creds.json`
//! de Gemini CLI) y su cuota es un grupo propio, distinto del de Gemini CLI. Lo que
//! sí hace es arrancar un servidor de lenguaje local que expone el estado del
//! usuario, el mismo que pinta el panel de cuotas del IDE (NO OFICIAL):
//!   · `POST http://127.0.0.1:<puerto>/exa.language_server_pb.LanguageServerService/GetUserStatus`
//!
//! Solo funciona con Antigravity abierto. Se descubre así:
//!   · token CSRF → argumento `--csrf_token` del proceso `language_server`
//!     lanzado con `--app_data_dir antigravity` (sin él responde 401);
//!   · puerto HTTP → línea «listening on random port at N for HTTP» del log
//!     `language_server.log`, que se reescribe en cada arranque.
//!
//! En macOS se intenta primero esa detección del IDE de escritorio. El log del
//! agy CLI (`~/.gemini/antigravity-cli/log/cli-*.log`) solo se usa como
//! alternativa, y únicamente si el proceso sigue vivo, su ejecutable es `agy`
//! o `language_server`, y la línea de comandos trae `--csrf_token`. El puerto se
//! toma de ese mismo log, nunca de otro que repita el PID. El endpoint
//! local responde 401 `missing CSRF token` si el header va vacío: no se envía
//! un token vacío ni se anuncia soporte del CLI mientras no lo exponga.
//!
//! Nada sale de la máquina: la petición va a localhost y el token no se guarda.

use super::{net_error, Who};
use crate::config::AntigravityConfig;
use crate::model::{Kind, Meter, Status, UsageReport};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

const FIVE_HOURS: i64 = 5 * 3600;
const WEEK: i64 = 7 * 86_400;
/// Margen para el desfase entre el reloj de Antigravity y el nuestro.
const TOLERANCE: i64 = 120;

/// Último reinicio visto por medidor, la ventana deducida para él y cuándo se vio.
#[derive(Clone, Debug, PartialEq)]
struct Seen {
    reset: String,
    window: Option<i64>,
    seen_at: chrono::DateTime<chrono::Utc>,
}

/// Memoria entre consultas (clave: id del medidor). Solo en memoria: al reiniciar
/// Quorb se vuelve a deducir desde cero.
static SEEN: Mutex<BTreeMap<String, Seen>> = Mutex::new(BTreeMap::new());

const METHOD: &str = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const NOT_RUNNING: &str =
    "Abre Antigravity para leer su cuota (solo se consulta con el IDE abierto).";

/// Proceso del servidor de lenguaje de Antigravity.
#[derive(Debug, PartialEq)]
struct Server {
    pid: u32,
    csrf: String,
    /// Puerto HTTP leído del mismo log que identificó el proceso (agy CLI).
    /// `None` en el IDE, cuyo puerto se busca en `language_server.log`.
    port: Option<u16>,
}

/// No usa el cliente HTTP compartido: ese respeta HTTP_PROXY/ALL_PROXY y el token
/// CSRF acabaría en el proxy. La consulta va con `local_client`.
pub async fn fetch(_cfg: &AntigravityConfig, who: Who<'_>, _http: &reqwest::Client) -> UsageReport {
    let report = who.report("Antigravity", Kind::Subscription);
    // Listar procesos lanza un comando externo: fuera del hilo del runtime.
    let server = tokio::task::spawn_blocking(find_server)
        .await
        .ok()
        .flatten();
    let Some(server) = server else {
        return report.fail(Status::Warning, NOT_RUNNING);
    };
    let port = server_port(&server, || std::fs::read_to_string(ide_log_path()).ok());
    let Some(port) = port else {
        return report.fail(
            Status::Warning,
            "Antigravity está arrancando: aún no publica el puerto de su servidor local.",
        );
    };

    let client = match local_client(reqwest::Client::builder()) {
        Ok(c) => c,
        Err(e) => {
            return report.fail(
                Status::Error,
                format!("No puedo preparar la consulta local: {e}"),
            )
        }
    };
    let res = post_status(&client, port, &server.csrf).await;
    let res = match res {
        Ok(r) => r,
        Err(e) => return report.fail(Status::Warning, format!("{NOT_RUNNING} ({})", net_error(e))),
    };
    let v: Value = match res.status().as_u16() {
        200 => match res.json().await {
            Ok(v) => v,
            Err(e) => return report.fail(Status::Error, format!("Respuesta inesperada: {e}")),
        },
        401 | 403 => {
            return report.fail(
                Status::Warning,
                "Antigravity ha rechazado la consulta local. Reinícialo e inténtalo de nuevo.",
            )
        }
        code => return report.fail(Status::Error, format!("HTTP {code} en GetUserStatus")),
    };
    let mut memory = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    build_report(report, &v, chrono::Utc::now(), &mut memory)
}

/// Cliente solo para la consulta local: el token CSRF no debe salir de la máquina.
/// Sin proxies (ni los del sistema ni los configurados en `builder`) y sin seguir
/// redirecciones, que podrían llevar el token a otro destino.
fn local_client(builder: reqwest::ClientBuilder) -> reqwest::Result<reqwest::Client> {
    builder
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
}

/// `GetUserStatus` contra el servidor local del IDE.
async fn post_status(
    client: &reqwest::Client,
    port: u16,
    csrf: &str,
) -> reqwest::Result<reqwest::Response> {
    client
        .post(format!("http://127.0.0.1:{port}{METHOD}"))
        .header("X-Codeium-Csrf-Token", csrf)
        .header("Connect-Protocol-Version", "1")
        .json(&json!({
            "metadata": { "ideName": "antigravity", "extensionName": "antigravity", "locale": "en" }
        }))
        .send()
        .await
}

/// Informe final a partir de la respuesta de `GetUserStatus`. Puro, sin red.
fn build_report(
    mut report: UsageReport,
    v: &Value,
    now: chrono::DateTime<chrono::Utc>,
    memory: &mut BTreeMap<String, Seen>,
) -> UsageReport {
    let status = v.get("userStatus").unwrap_or(v);
    report.plan = plan_name(status);
    report.meters = parse_models(status, now, memory);
    if report.meters.is_empty() {
        report.status = Status::Warning;
        report.message = Some(
            "Antigravity no ha devuelto cuotas por modelo. ¿Has iniciado sesión en el IDE?".into(),
        );
    }
    report
}

/// «Google AI Pro» (nivel de la suscripción) o, si falta, el plan interno («Pro»).
fn plan_name(status: &Value) -> Option<String> {
    let tier = status
        .pointer("/userTier/description")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let plan = status
        .pointer("/planStatus/planInfo/planName")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    tier.or(plan).map(str::to_string)
}

/// Un medidor por modelo (el % gastado es 1 − remainingFraction). Las variantes de
/// esfuerzo («(High)», «(Low)»…) comparten cuota: nos quedamos con la más gastada.
fn parse_models(
    status: &Value,
    now: chrono::DateTime<chrono::Utc>,
    memory: &mut BTreeMap<String, Seen>,
) -> Vec<Meter> {
    let mut by_model: BTreeMap<String, Meter> = BTreeMap::new();
    for c in status
        .pointer("/cascadeModelConfigData/clientModelConfigs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(label) = c.get("label").and_then(Value::as_str) else {
            continue;
        };
        let Some(q) = c.get("quotaInfo") else {
            continue;
        };
        // Sin `remainingFraction` el modelo está agotado (proto3 omite el 0).
        let remaining = q
            .get("remainingFraction")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if !remaining.is_finite() {
            continue;
        }
        let name = base_label(label);
        let resets_at = q
            .get("resetTime")
            .and_then(Value::as_str)
            .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
            .map(str::to_string);
        let id = format!("model:{}", slug(&name));
        let window_seconds = resets_at
            .as_deref()
            .and_then(|r| window_for(memory.get(&id), r, now));
        let meter = Meter {
            id,
            label: name.clone(),
            percent: Some(((1.0 - remaining) * 100.0).clamp(0.0, 100.0)),
            used: None,
            limit: None,
            unit: None,
            window_seconds,
            resets_at,
            quota_source: None,
        };
        let keep = by_model
            .get(&name)
            .map(|m| m.percent < meter.percent)
            .unwrap_or(true);
        if keep {
            by_model.insert(name, meter);
        }
    }
    let mut out: Vec<Meter> = by_model.into_values().collect();
    settle_windows(&mut out, memory, now);
    out.sort_by(|a, b| {
        b.percent
            .partial_cmp(&a.percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// «Claude Opus 5.5 (High)» → «Claude Opus 5.5».
fn base_label(label: &str) -> String {
    let t = label.trim();
    match t.rfind(" (") {
        Some(i) if t.ends_with(')') => t[..i].trim_end().to_string(),
        _ => t.to_string(),
    }
}

/// «Claude Opus 5.5» → «claude_opus_5_5».
fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
}

/// Antigravity no dice la duración de la ventana. Las cuotas que conocemos son de
/// 5 h y semanales, y un solo instante no basta para distinguirlas: a una semanal
/// le llega un momento en que le quedan menos de 5 h. Señales que sí son fiables:
///   · faltan más de 5 h → solo puede ser semanal;
///   · ya vimos este mismo reinicio → se mantiene la ventana deducida entonces;
///   · el reinicio cambió, el nuevo cae dentro de 5 h y la consulta anterior es de
///     hace menos de 7 días − 5 h → ventana de 5 h. Si el reinicio cambió, la ventana
///     nueva empezó después de esa consulta; si fuera semanal acabaría al menos 7 días
///     después de ella, y no podrían quedarle ≤ 5 h antes de 7 días − 5 h. Tras una
///     pausa más larga (Antigravity cerrado) el cambio es ambiguo.
/// Sin ninguna de ellas, `None`: mejor sin ritmo que con uno equivocado.
fn window_for(prev: Option<&Seen>, reset: &str, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
    let at = chrono::DateTime::parse_from_rfc3339(reset).ok()?;
    let left = (at.with_timezone(&chrono::Utc) - now).num_seconds();
    if left <= 0 {
        return None;
    }
    if left > FIVE_HOURS + TOLERANCE {
        return (left <= WEEK + TOLERANCE).then_some(WEEK);
    }
    match prev {
        Some(p) if p.reset == reset => p.window,
        Some(p) if (now - p.seen_at).num_seconds() < WEEK - FIVE_HOURS - 2 * TOLERANCE => {
            Some(FIVE_HOURS)
        }
        _ => None,
    }
}

/// Completa las ventanas desconocidas con las de los modelos del mismo grupo
/// (mismo `resetTime` exacto) y guarda lo deducido para la próxima consulta.
fn settle_windows(
    meters: &mut [Meter],
    memory: &mut BTreeMap<String, Seen>,
    now: chrono::DateTime<chrono::Utc>,
) {
    let known: BTreeMap<String, i64> = meters
        .iter()
        .filter_map(|m| Some((m.resets_at.clone()?, m.window_seconds?)))
        .collect();
    for m in meters.iter_mut() {
        if m.window_seconds.is_none() {
            m.window_seconds = m.resets_at.as_ref().and_then(|r| known.get(r).copied());
        }
        if let Some(reset) = &m.resets_at {
            memory.insert(
                m.id.clone(),
                Seen {
                    reset: reset.clone(),
                    window: m.window_seconds,
                    seen_at: now,
                },
            );
        }
    }
}

/// Log del IDE de escritorio. En macOS es `~/Library/Application Support/…`.
fn ide_log_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(super::home)
        .join("Antigravity")
        .join("logs")
        .join("language_server.log")
}

/// Puerto del servidor elegido. Si vino del log del agy CLI se usa ese, aunque
/// el log del IDE repita el PID; si no, el del IDE.
fn server_port(server: &Server, ide_log: impl FnOnce() -> Option<String>) -> Option<u16> {
    match server.port {
        Some(port) => Some(port),
        None => http_port(&ide_log()?, server.pid),
    }
}

/// Logs `cli-*.log` del agy CLI, del nombre más reciente al más antiguo.
#[cfg(target_os = "macos")]
fn cli_log_paths() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let log_dir = home.join(".gemini").join("antigravity-cli").join("log");
    let mut logs: Vec<PathBuf> = std::fs::read_dir(log_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.starts_with("cli-") && name.ends_with(".log")
        })
        .map(|e| e.path())
        .collect();
    logs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    logs
}

/// Puerto HTTP que anunció en el log el proceso `pid`. Solo se mira el bloque de
/// su último arranque (hasta el siguiente «Starting…»), con el pid completo: así
/// nunca se toma el puerto de otro proceso.
fn http_port(log: &str, pid: u32) -> Option<u16> {
    const START: &str = "Starting language server process with pid ";
    let start_pid = |l: &str| -> Option<u32> { l.split(START).nth(1)?.trim().parse().ok() };
    let lines: Vec<&str> = log.lines().collect();
    let from = lines.iter().rposition(|l| start_pid(l) == Some(pid))?;
    lines[from + 1..]
        .iter()
        .take_while(|l| !l.contains(START))
        .find_map(|l| {
            let rest = l.split("listening on random port at ").nth(1)?;
            let (port, kind) = rest.split_once(' ')?;
            kind.trim_end()
                .ends_with("for HTTP")
                .then(|| port.parse().ok())?
        })
}

/// Valor de `--flag valor` o `--flag=valor` en una línea de comandos.
fn arg_value<'a>(cmdline: &'a str, flag: &str) -> Option<&'a str> {
    let mut it = cmdline.split_whitespace();
    while let Some(tok) = it.next() {
        if tok == flag {
            return it.next();
        }
        if let Some(v) = tok.strip_prefix(flag).and_then(|r| r.strip_prefix('=')) {
            return Some(v);
        }
    }
    None
}

/// Servidor de Antigravity entre `(pid, línea de comandos)`. Windsurf y otros
/// IDEs de Codeium lanzan el mismo binario: se filtra por `--app_data_dir antigravity`.
fn pick_server<'a>(procs: impl IntoIterator<Item = (u32, &'a str)>) -> Option<Server> {
    procs.into_iter().find_map(|(pid, cmd)| {
        if !cmd.to_ascii_lowercase().contains("language_server") {
            return None;
        }
        if !arg_value(cmd, "--app_data_dir").is_some_and(|d| d.eq_ignore_ascii_case("antigravity"))
        {
            return None;
        }
        let csrf = arg_value(cmd, "--csrf_token")?
            .trim_matches('"')
            .to_string();
        (!csrf.is_empty()).then_some(Server {
            pid,
            csrf,
            port: None,
        })
    })
}

#[cfg(not(windows))]
fn find_server_from_ps() -> Option<Server> {
    let out = std::process::Command::new("ps")
        .args(["-ww", "-eo", "pid=,args="])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let procs: Vec<(u32, &str)> = text
        .lines()
        .filter_map(|l| {
            let (pid, cmd) = l.trim_start().split_once(' ')?;
            Some((pid.parse().ok()?, cmd))
        })
        .collect();
    pick_server(procs)
}

#[cfg(windows)]
fn find_server() -> Option<Server> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%'\" | \
             Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    // Un solo proceso llega como objeto; varios, como lista.
    let list = match v {
        Value::Array(a) => a,
        other => vec![other],
    };
    let procs: Vec<(u32, String)> = list
        .iter()
        .filter_map(|p| {
            let pid = p.get("ProcessId")?.as_u64()? as u32;
            Some((pid, p.get("CommandLine")?.as_str()?.to_string()))
        })
        .collect();
    pick_server(procs.iter().map(|(p, c)| (*p, c.as_str())))
}

/// En macOS, el IDE de escritorio primero. El agy CLI solo entra si el proceso
/// del log es el language server y publica `--csrf_token`.
#[cfg(target_os = "macos")]
fn find_server() -> Option<Server> {
    find_server_from_ps().or_else(|| {
        let logs = cli_log_paths()
            .into_iter()
            .filter_map(|path| std::fs::read_to_string(path).ok());
        server_from_cli_logs(logs, |pid| {
            let comm = process_field(pid, "comm=")?;
            Some((comm, process_field(pid, "args=").unwrap_or_default()))
        })
    })
}

#[cfg(target_os = "macos")]
fn process_field(pid: u32, field: &str) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-ww", "-o", field])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn find_server() -> Option<Server> {
    find_server_from_ps()
}

/// `comm` del proceso: el IDE se llama `language_server…` y el agy CLI, `agy`.
#[cfg(any(target_os = "macos", test))]
fn comm_is_antigravity_server(comm: &str) -> bool {
    let base = comm.rsplit(['/', '\\']).next().unwrap_or(comm).trim();
    base.starts_with("language_server") || base == "agy"
}

/// Primer log del CLI (del más reciente al más antiguo) cuyo último proceso es
/// un servidor utilizable. `probe` da `(comm, args)` del PID si sigue vivo.
#[cfg(any(target_os = "macos", test))]
fn server_from_cli_logs(
    logs: impl IntoIterator<Item = String>,
    probe: impl Fn(u32) -> Option<(String, String)>,
) -> Option<Server> {
    logs.into_iter().find_map(|log| {
        let (comm, args) = probe(latest_server_pid(&log)?)?;
        server_from_cli(&log, &comm, &args)
    })
}

/// Servidor leído del log del CLI, con el puerto de ese mismo log. Sin token, o
/// si el PID ya no es ese proceso, no hay servidor utilizable: un PID reutilizado
/// no debe consultarse.
#[cfg(any(target_os = "macos", test))]
fn server_from_cli(log: &str, comm: &str, args: &str) -> Option<Server> {
    let pid = latest_server_pid(log)?;
    if !comm_is_antigravity_server(comm) {
        return None;
    }
    let port = http_port(log, pid)?;
    let csrf = arg_value(args, "--csrf_token")?
        .trim_matches('"')
        .to_string();
    (!csrf.is_empty()).then_some(Server {
        pid,
        csrf,
        port: Some(port),
    })
}

/// Extrae el PID más reciente de la línea «Starting language server process with pid NNN».
/// Se recorre el log al revés para tomar siempre el último arranque.
#[cfg(any(target_os = "macos", test))]
fn latest_server_pid(log: &str) -> Option<u32> {
    const START: &str = "Starting language server process with pid ";
    log.lines().rev().find_map(|l| {
        l.split(START)
            .nth(1)?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc
            .with_ymd_and_hms(2026, 10, 29, 15, 37, 41)
            .unwrap()
    }

    const CMD: &str = r"C:\Users\u\AppData\Local\Programs\antigravity\resources\bin\language_server.exe --standalone --override_ide_name antigravity --https_server_port 0 --csrf_token abc-123 --app_data_dir antigravity --enable_sidecars";

    #[test]
    fn picks_antigravity_server_and_ignores_other_ides() {
        let windsurf = "language_server_windows_x64.exe --csrf_token zzz --app_data_dir windsurf";
        let other = "node server.js --csrf_token nope";
        let got = pick_server([(1, other), (2, windsurf), (3, CMD)]);
        assert_eq!(
            got,
            Some(Server {
                pid: 3,
                csrf: "abc-123".into(),
                port: None,
            })
        );
        assert_eq!(pick_server([(2, windsurf)]), None);
        // `--flag=valor` también vale.
        let eq = "language_server --app_data_dir=antigravity --csrf_token=t1";
        assert_eq!(pick_server([(9, eq)]).map(|s| s.csrf), Some("t1".into()));
        // Sin token no hay servidor utilizable.
        assert_eq!(
            pick_server([(4, "language_server --app_data_dir antigravity")]),
            None
        );
    }

    #[test]
    fn port_lookup_matches_the_whole_pid() {
        let log = "I1029 server.go:1631] Starting language server process with pid 1234
I1029 server.go:657] Language server listening on random port at 40001 for HTTP
";
        // «pid 123» no es «pid 1234».
        assert_eq!(http_port(log, 123), None);
        assert_eq!(http_port(log, 1234), Some(40001));
    }

    #[test]
    fn port_lookup_stops_at_the_next_start() {
        let log = "I1029 server.go:1631] Starting language server process with pid 222
I1029 server.go:649] Language server listening on random port at 51182 for HTTPS (gRPC)
I1029 server.go:1631] Starting language server process with pid 333
I1029 server.go:657] Language server listening on random port at 60001 for HTTP
";
        // El bloque de 222 no publica puerto HTTP: no se toma el de 333.
        assert_eq!(http_port(log, 222), None);
        assert_eq!(http_port(log, 333), Some(60001));
    }

    /// Servidor HTTP mínimo en loopback: atiende una conexión con `response` y
    /// devuelve lo que recibió. `None` si nadie se conecta en `wait`.
    fn one_shot(response: String) -> (u16, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                s.set_read_timeout(Some(std::time::Duration::from_millis(500)))
                    .ok();
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = s.write_all(response.as_bytes());
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            }
        });
        (port, rx)
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    const EMPTY_OK: &str = "HTTP/1.1 200 OK
Content-Length: 2
Connection: close

{}";

    #[test]
    fn csrf_token_never_goes_through_a_proxy() {
        let (proxy, proxy_rx) = one_shot(
            "HTTP/1.1 502 Bad Gateway
Content-Length: 0

"
            .into(),
        );
        let (server, server_rx) = one_shot(EMPTY_OK.into());
        // Mismo efecto que HTTP_PROXY/ALL_PROXY sin NO_PROXY para loopback.
        let builder = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{proxy}")).unwrap());
        let client = local_client(builder).unwrap();
        let res = block_on(post_status(&client, server, "token-ficticio")).unwrap();
        assert_eq!(res.status().as_u16(), 200);
        let wait = std::time::Duration::from_secs(2);
        assert!(server_rx
            .recv_timeout(wait)
            .unwrap()
            .contains("token-ficticio"));
        assert!(
            proxy_rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_err(),
            "el proxy recibió la consulta"
        );
    }

    #[test]
    fn local_query_does_not_follow_redirects() {
        let (other, other_rx) = one_shot(EMPTY_OK.into());
        let (server, _server_rx) = one_shot(format!(
            "HTTP/1.1 307 Temporary Redirect
Location: http://127.0.0.1:{other}/x
Content-Length: 0
Connection: close

"
        ));
        let client = local_client(reqwest::Client::builder()).unwrap();
        let res = block_on(post_status(&client, server, "token-ficticio")).unwrap();
        assert_eq!(res.status().as_u16(), 307);
        assert!(
            other_rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_err(),
            "se siguió la redirección"
        );
    }

    #[test]
    fn reads_http_port_of_the_current_process_only() {
        let log = "\
I1029 server.go:1631] Starting language server process with pid 111
I1029 server.go:649] Language server listening on random port at 40000 for HTTPS (gRPC)
I1029 server.go:657] Language server listening on random port at 40001 for HTTP
I1029 server.go:1631] Starting language server process with pid 222
I1029 server.go:649] Language server listening on random port at 51182 for HTTPS (gRPC)
I1029 server.go:657] Language server listening on random port at 51183 for HTTP\r
";
        assert_eq!(http_port(log, 222), Some(51183));
        assert_eq!(http_port(log, 111), Some(40001));
        assert_eq!(http_port(log, 333), None);
        assert_eq!(http_port("", 222), None);
    }

    #[test]
    fn groups_effort_variants_and_sorts_by_usage() {
        let v = json!({"userStatus": {
            "userTier": {"id": "g1-pro-tier", "description": "Google AI Pro"},
            "planStatus": {"planInfo": {"planName": "Pro"}},
            "cascadeModelConfigData": {"clientModelConfigs": [
                {"label": "Gemini 4 Argon (High)", "quotaInfo": {"remainingFraction": 1, "resetTime": "2026-11-05T15:37:41Z"}},
                {"label": "Claude Opus 5.5 (Medium)", "quotaInfo": {"remainingFraction": 0.6, "resetTime": "2026-10-29T20:37:41Z"}},
                {"label": "Claude Opus 5.5 (High)", "quotaInfo": {"remainingFraction": 0.25, "resetTime": "2026-10-29T20:37:41Z"}},
                {"label": "Sin cuota"},
                {"label": "Gemini 3.8 Flash (Low)", "quotaInfo": {"resetTime": "2026-10-29T20:37:41Z"}}
            ]}
        }});
        let r = build_report(
            UsageReport::new("antigravity", "Antigravity", Kind::Subscription),
            &v,
            now(),
            &mut BTreeMap::new(),
        );
        assert_eq!(r.status, Status::Ok);
        assert_eq!(r.plan.as_deref(), Some("Google AI Pro"));
        let ids: Vec<&str> = r.meters.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "model:gemini_3_8_flash",
                "model:claude_opus_5_5",
                "model:gemini_4_argon"
            ]
        );
        // Sin remainingFraction = agotado.
        assert_eq!(r.meters[0].percent, Some(100.0));
        assert_eq!(r.meters[1].label, "Claude Opus 5.5");
        assert_eq!(r.meters[1].percent, Some(75.0));
        // Primera consulta, faltan justo 5 h y sin historial: ventana desconocida.
        assert_eq!(r.meters[1].window_seconds, None);
        assert_eq!(r.meters[2].percent, Some(0.0));
        assert_eq!(r.meters[2].window_seconds, Some(7 * 86_400));
        assert_eq!(
            r.meters[2].resets_at.as_deref(),
            Some("2026-11-05T15:37:41Z")
        );
    }

    #[test]
    fn plan_falls_back_to_plan_name() {
        let v = json!({"planStatus": {"planInfo": {"planName": "Pro"}}});
        assert_eq!(plan_name(&v).as_deref(), Some("Pro"));
        assert_eq!(plan_name(&json!({})), None);
    }

    #[test]
    fn empty_response_is_a_warning() {
        let r = build_report(
            UsageReport::new("antigravity", "Antigravity", Kind::Subscription),
            &json!({"userStatus": {}}),
            now(),
            &mut BTreeMap::new(),
        );
        assert_eq!(r.status, Status::Warning);
        assert!(r.meters.is_empty());
        assert!(r.message.is_some());
    }

    #[test]
    fn invalid_reset_is_dropped_but_percent_kept() {
        let v = json!({"cascadeModelConfigData": {"clientModelConfigs": [
            {"label": "GPT-OSS 120B (Medium)", "quotaInfo": {"remainingFraction": 0.5, "resetTime": "mañana"}}
        ]}});
        let m = parse_models(&v, now(), &mut BTreeMap::new());
        assert_eq!(m[0].id, "model:gpt_oss_120b");
        assert_eq!(m[0].percent, Some(50.0));
        assert_eq!(m[0].resets_at, None);
        assert_eq!(m[0].window_seconds, None);
    }

    /// Una sola cuota con su reinicio, como la devuelve GetUserStatus.
    fn one(label: &str, reset: &str) -> Value {
        json!({"cascadeModelConfigData": {"clientModelConfigs": [
            {"label": label, "quotaInfo": {"remainingFraction": 0.5, "resetTime": reset}}
        ]}})
    }

    fn at(h: i64) -> chrono::DateTime<chrono::Utc> {
        now() + chrono::Duration::hours(h)
    }

    #[test]
    fn weekly_quota_near_reset_is_not_taken_for_five_hours() {
        // Semanal con menos de 5 h para el reinicio y sin historial: sin señal fiable.
        let reset = "2026-10-29T18:37:41Z"; // now() + 3 h
        let m = parse_models(
            &one("Gemini 4 Argon (High)", reset),
            now(),
            &mut BTreeMap::new(),
        );
        assert_eq!(m[0].window_seconds, None);

        // La misma semanal vista antes con días por delante conserva su ventana
        // hasta el reinicio, aunque ya le queden menos de 5 h.
        let mut memory = BTreeMap::new();
        let m = parse_models(&one("Gemini 4 Argon (High)", reset), at(-48), &mut memory);
        assert_eq!(m[0].window_seconds, Some(WEEK));
        let m = parse_models(&one("Gemini 4 Argon (High)", reset), now(), &mut memory);
        assert_eq!(m[0].window_seconds, Some(WEEK));
        let m = parse_models(&one("Gemini 4 Argon (High)", reset), at(2), &mut memory);
        assert_eq!(m[0].window_seconds, Some(WEEK));
    }

    #[test]
    fn five_hour_window_needs_a_changed_reset() {
        let mut memory = BTreeMap::new();
        // Cuota sin usar: el reinicio se desliza con el reloj (siempre ahora + 5 h).
        let m = parse_models(
            &one("Claude Opus 5.5", "2026-10-29T20:37:41Z"),
            now(),
            &mut memory,
        );
        assert_eq!(m[0].window_seconds, None);
        let m = parse_models(
            &one("Claude Opus 5.5", "2026-10-29T20:42:41Z"),
            now() + chrono::Duration::minutes(5),
            &mut memory,
        );
        assert_eq!(m[0].window_seconds, Some(FIVE_HOURS));
        // Ya en uso, el reinicio queda fijo y la ventana aprendida se conserva.
        let m = parse_models(
            &one("Claude Opus 5.5", "2026-10-29T20:42:41Z"),
            at(4),
            &mut memory,
        );
        assert_eq!(m[0].window_seconds, Some(FIVE_HOURS));
        // Pasado el reinicio no se inventa ventana.
        let m = parse_models(
            &one("Claude Opus 5.5", "2026-10-29T20:42:41Z"),
            at(6),
            &mut memory,
        );
        assert_eq!(m[0].window_seconds, None);
    }

    #[test]
    fn weekly_reset_after_a_pause_is_not_taken_for_five_hours() {
        let utc = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .with_timezone(&chrono::Utc)
        };
        let mut memory = BTreeMap::new();
        // 27 oct 15:37: semanal que reinicia el 29 oct 18:37 → se aprende WEEK.
        let m = parse_models(
            &one("Gemini 4 Argon", "2026-10-29T18:37:41Z"),
            utc("2026-10-27T15:37:41Z"),
            &mut memory,
        );
        assert_eq!(m[0].window_seconds, Some(WEEK));
        // Antigravity cerrado hasta el 5 nov 15:37. El siguiente reinicio semanal es
        // el 5 nov 18:37 (7 días después del anterior): cambió y quedan 3 h, pero tras
        // la pausa no hay evidencia de que sea una ventana de 5 h.
        let m = parse_models(
            &one("Gemini 4 Argon", "2026-11-05T18:37:41Z"),
            utc("2026-11-05T15:37:41Z"),
            &mut memory,
        );
        assert_eq!(m[0].window_seconds, None);
        // Y no se aprende 5 h para las consultas siguientes del mismo reinicio.
        let m = parse_models(
            &one("Gemini 4 Argon", "2026-11-05T18:37:41Z"),
            utc("2026-11-05T16:37:41Z"),
            &mut memory,
        );
        assert_eq!(m[0].window_seconds, None);
    }

    #[test]
    fn five_hour_inference_is_bounded_by_the_gap_since_last_seen() {
        let bound = WEEK - FIVE_HOURS - 2 * TOLERANCE;
        let prev = |gap: i64| Seen {
            reset: "2026-10-01T00:00:00Z".into(),
            window: Some(FIVE_HOURS),
            seen_at: now() - chrono::Duration::seconds(gap),
        };
        let reset = "2026-10-29T18:37:41Z"; // now() + 3 h, distinto del anterior
                                            // Una semanal no puede haber cambiado de reinicio y quedarse en ≤ 5 h tan pronto.
        assert_eq!(
            window_for(Some(&prev(bound - 1)), reset, now()),
            Some(FIVE_HOURS)
        );
        // Con una pausa mayor ya podría ser el siguiente reinicio semanal: ambiguo.
        assert_eq!(window_for(Some(&prev(bound)), reset, now()), None);
        assert_eq!(window_for(Some(&prev(10 * 86_400)), reset, now()), None);
    }

    #[test]
    fn models_sharing_a_reset_share_the_window() {
        let reset = "2026-10-29T18:37:41Z"; // now() + 3 h
        let mut memory = BTreeMap::from([(
            "model:gemini_4_argon".to_string(),
            Seen {
                reset: reset.into(),
                window: Some(WEEK),
                seen_at: at(-1),
            },
        )]);
        let v = json!({"cascadeModelConfigData": {"clientModelConfigs": [
            {"label": "Gemini 4 Argon (High)", "quotaInfo": {"remainingFraction": 0.2, "resetTime": reset}},
            {"label": "Gemini 4 Nuevo", "quotaInfo": {"remainingFraction": 0.9, "resetTime": reset}},
            {"label": "Otro", "quotaInfo": {"remainingFraction": 0.9, "resetTime": "2026-10-29T17:00:00Z"}}
        ]}});
        let m = parse_models(&v, now(), &mut memory);
        let w = |id: &str| m.iter().find(|x| x.id == id).unwrap().window_seconds;
        assert_eq!(w("model:gemini_4_nuevo"), Some(WEEK));
        assert_eq!(w("model:otro"), None);
        // Lo deducido por el grupo queda guardado para la próxima consulta.
        assert_eq!(memory["model:gemini_4_nuevo"].window, Some(WEEK));
    }

    #[test]
    fn far_or_past_resets_have_no_window() {
        assert_eq!(window_for(None, "2026-11-05T15:37:41Z", now()), Some(WEEK));
        assert_eq!(window_for(None, "2026-12-01T00:00:00Z", now()), None);
        assert_eq!(window_for(None, "2026-10-29T10:00:00Z", now()), None);
    }

    #[test]
    fn labels_and_slugs() {
        assert_eq!(base_label("Claude Sonnet 5.5 (Low)"), "Claude Sonnet 5.5");
        assert_eq!(base_label("GPT-OSS 120B"), "GPT-OSS 120B");
        assert_eq!(slug("GPT-OSS 120B"), "gpt_oss_120b");
        assert_eq!(arg_value("a --x 1", "--x"), Some("1"));
        assert_eq!(arg_value("a --xy 1", "--x"), None);
    }

    // ── Tests for macOS log-based PID extraction ─────────────────────────────

    #[test]
    fn latest_server_pid_returns_last_pid_on_multiple_restarts() {
        // Simula un log del agy CLI con dos arranques del language server.
        // Se espera el PID del arranque más reciente.
        let log = "\
I1102 08:48:08.031915  37 server.go:1585] Starting language server process with pid 11111
I1102 08:48:08.038616  37 server.go:639]  Language server listening on random port at 50001 for HTTP
I1102 09:00:00.000000  37 server.go:1585] Starting language server process with pid 22222
I1102 09:00:00.004000  37 server.go:639]  Language server listening on random port at 50002 for HTTP
";
        assert_eq!(latest_server_pid(log), Some(22222));
    }

    #[test]
    fn latest_server_pid_returns_none_on_empty_log() {
        assert_eq!(latest_server_pid(""), None);
        assert_eq!(latest_server_pid("no relevant lines here\n"), None);
    }

    #[test]
    fn latest_server_pid_ignores_malformed_pid() {
        // Si el PID no es un número válido no debe panicar.
        let log = "Starting language server process with pid NOT_A_NUMBER\n\
Starting language server process with pid 99999\n";
        assert_eq!(latest_server_pid(log), Some(99999));
    }

    #[test]
    fn http_port_works_with_agy_cli_log_format() {
        // El log real del agy CLI en macOS usa el mismo formato de línea que el IDE de Windows.
        let log = "\
I1102 08:48:08.031915      37 server.go:1585] Starting language server process with pid 96831
I1102 08:48:08.034829      37 server.go:1636] Language server version: 1.2.13
I1102 08:48:08.034844      37 server.go:616] Language server will attempt to listen on host localhost
I1102 08:48:08.038186      37 server.go:631] Language server listening on random port at 57614 for HTTPS (gRPC)
I1102 08:48:08.038616      37 server.go:639] Language server listening on random port at 57615 for HTTP
";
        assert_eq!(http_port(log, 96831), Some(57615));
        // El puerto gRPC (HTTPS) no se debe devolver.
        assert_ne!(http_port(log, 96831), Some(57614));
    }

    #[test]
    fn cli_server_requires_the_language_server_process_and_a_csrf_token() {
        let log = "\
Starting language server process with pid 97576
Language server listening on random port at 57748 for HTTP
";
        let with_token = "agy --csrf_token abc-123";
        assert_eq!(
            server_from_cli(log, "agy", with_token),
            Some(Server {
                pid: 97576,
                csrf: "abc-123".into(),
                port: Some(57748),
            })
        );
        // El proceso `agy` no publica el token: no se consulta con el header vacío.
        assert_eq!(server_from_cli(log, "agy", "agy"), None);
        // Un PID reutilizado deja de ser el language server.
        assert_eq!(
            server_from_cli(
                log,
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                with_token
            ),
            None
        );
        assert_eq!(
            server_from_cli(
                log,
                "/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm",
                with_token
            )
            .map(|s| s.csrf),
            Some("abc-123".into())
        );
    }

    #[test]
    fn port_comes_from_the_log_that_selected_the_server() {
        // Dos logs del CLI con el mismo PID (reutilizado) y puertos distintos, más
        // un log del IDE que también lo repite. El más reciente es el vigente.
        let newest = "\
Starting language server process with pid 4242
Language server listening on random port at 50002 for HTTP
"
        .to_string();
        let oldest = "\
Starting language server process with pid 4242
Language server listening on random port at 50001 for HTTP
"
        .to_string();
        let ide = "\
Starting language server process with pid 4242
Language server listening on random port at 40001 for HTTP
";
        let probe = |pid: u32| {
            (pid == 4242).then(|| ("agy".to_string(), "agy --csrf_token t1".to_string()))
        };
        let server = server_from_cli_logs([newest.clone(), oldest.clone()], probe).unwrap();
        assert_eq!(server.port, Some(50002));
        assert_eq!(server_port(&server, || Some(ide.to_string())), Some(50002));
        // En el orden inverso manda el primer log que identifica el servidor.
        let server = server_from_cli_logs([oldest, newest], probe).unwrap();
        assert_eq!(server_port(&server, || Some(ide.to_string())), Some(50001));
        // El servidor del IDE sigue leyendo su puerto de `language_server.log`.
        let ide_server = Server {
            pid: 4242,
            csrf: "t1".into(),
            port: None,
        };
        assert_eq!(
            server_port(&ide_server, || Some(ide.to_string())),
            Some(40001)
        );
        assert_eq!(server_port(&ide_server, || None), None);
    }
}
