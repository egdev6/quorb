//! Envío concreto de avisos por Resend; sin cola, replay ni reintentos.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum EmailStatus {
    #[default]
    Idle,
    Accepted,
    Disabled,
    ConsentRequired,
    ConfigurationMissing,
    KeyMissing,
    KeyringError,
    AuthenticationError,
    SenderRejected,
    RequestRejected,
    RateLimited,
    ServiceError,
    AcceptanceUnknown,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Exceeded,
    Reset,
}

/// No acepta informes completos, nombres de cuentas ni etiquetas configurables.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmailEvent {
    pub provider: String,
    pub meter: String,
    pub window: String,
    pub percent: f64,
    pub kind: EventKind,
}

impl EmailEvent {
    fn valid(&self) -> bool {
        [
            "claude",
            "codex",
            "gemini",
            "cursor",
            "grok",
            "copilot",
            "openrouter",
            "anthropic_api",
            "openai_api",
            "zai",
            "nan",
            "minimax",
            "nine_router",
            "opencode_go",
            "antigravity",
        ]
        .contains(&self.provider.as_str())
            && !self.meter.is_empty()
            && self.meter.len() <= 64
            && self
                .meter
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            && (self.window == "none"
                || (!self.window.is_empty()
                    && self.window.len() <= 16
                    && self.window.bytes().all(|b| b.is_ascii_digit())))
            && self.percent.is_finite()
            && (0.0..=10000.0).contains(&self.percent)
    }
    fn text(&self, locale: crate::i18n::Locale) -> String {
        let (labels, kinds) = crate::i18n::email_event_words(locale);
        let kind = match self.kind {
            EventKind::Exceeded => kinds.0,
            EventKind::Reset => kinds.1,
        };
        [
            (labels.0, self.provider.as_str()),
            (labels.1, self.meter.as_str()),
            (labels.2, self.window.as_str()),
            (labels.3, self.percent.to_string().as_str()),
            (labels.4, kind),
        ]
        .map(|(label, value)| format!("{label}: {value}"))
        .join("\n")
    }
}

/// Primera fase: dirección simple, sin display-name, listas ni cabeceras.
fn valid_address(value: &str) -> bool {
    value.len() <= 254
        && value.is_ascii()
        && !value
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control() || b"<>,;\"\\".contains(&b))
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.contains('@')
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        })
}

pub async fn send(
    cfg: &crate::config::AlertsConfig,
    locale: crate::i18n::Locale,
    event: Option<EmailEvent>,
) -> EmailStatus {
    send_with(
        cfg,
        locale,
        event,
        crate::secrets::get_resend_api_key,
        "https://api.resend.com/emails",
        Duration::from_secs(10),
    )
    .await
}

async fn send_with(
    cfg: &crate::config::AlertsConfig,
    locale: crate::i18n::Locale,
    event: Option<EmailEvent>,
    read_key: impl FnOnce() -> Result<Option<String>, String>,
    endpoint: &str,
    timeout: Duration,
) -> EmailStatus {
    if event.is_some() && (!cfg.enabled || !cfg.email.enabled) {
        return EmailStatus::Disabled;
    }
    if !cfg.email.consent {
        return EmailStatus::ConsentRequired;
    }
    if !valid_address(&cfg.email.sender) || !valid_address(&cfg.email.recipient) {
        return EmailStatus::ConfigurationMissing;
    }
    if event.as_ref().is_some_and(|e| !e.valid()) {
        return EmailStatus::RequestRejected;
    }
    let key = match read_key() {
        Ok(Some(key)) if !key.trim().is_empty() => key,
        Ok(_) => return EmailStatus::KeyMissing,
        Err(_) => return EmailStatus::KeyringError,
    };
    // Cliente nuevo por intento: sin conexiones reutilizadas, HTTP/2, redirecciones
    // ni reenvíos de credenciales. Ningún endpoint se recibe desde el frontend.
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .http1_only()
        .timeout(timeout)
        .build()
    {
        Ok(client) => client,
        Err(_) => return EmailStatus::ServiceError,
    };
    let text = event
        .map(|e| e.text(locale))
        .unwrap_or_else(|| crate::i18n::email_test_body(locale).into());
    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .json(&serde_json::json!({
            "from": cfg.email.sender, "to": [cfg.email.recipient],
            "subject": crate::i18n::email_subject(locale), "text": text,
        }))
        .send()
        .await;
    match response {
        Ok(response) => match response.status().as_u16() {
            200..=299 => EmailStatus::Accepted,
            401 => EmailStatus::AuthenticationError,
            403 => EmailStatus::SenderRejected,
            429 => EmailStatus::RateLimited,
            500..=599 => EmailStatus::ServiceError,
            _ => EmailStatus::RequestRejected,
        },
        // No se devuelve reqwest::Error ni cuerpo/URL/headers de Resend.
        Err(_) => EmailStatus::AcceptanceUnknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Locale;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn config() -> crate::config::AlertsConfig {
        let mut cfg = crate::config::AlertsConfig::default();
        cfg.email.enabled = true;
        cfg.email.consent = true;
        cfg.email.sender = "sender@example.test".into();
        cfg.email.recipient = "recipient@example.test".into();
        cfg
    }
    fn event() -> EmailEvent {
        EmailEvent {
            provider: "claude".into(),
            meter: "five_hour".into(),
            window: "12345".into(),
            percent: 95.0,
            kind: EventKind::Exceeded,
        }
    }
    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }
    struct ServerHandle {
        shutdown: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl ServerHandle {
        fn join(mut self) -> std::thread::Result<()> {
            // Preserve the observation window for unexpected extra requests.
            std::thread::sleep(Duration::from_millis(350));
            self.shutdown.store(true, Ordering::Release);
            self.thread.take().unwrap().join()
        }
    }

    impl Drop for ServerHandle {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                // Do not double-panic while unwinding a failed assertion.
                let _ = thread.join();
            }
        }
    }

    fn server(status: u16, delay: Duration) -> (String, Arc<Mutex<Vec<String>>>, ServerHandle) {
        server_with_accept(status, delay, |_| {})
    }

    fn server_with_accept(
        status: u16,
        delay: Duration,
        on_accept: impl Fn(&std::net::TcpStream) + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<String>>>, ServerHandle) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/emails", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let requests = captured.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let stopping = shutdown.clone();
        let handle = std::thread::spawn(move || {
            // The owning test controls lifetime, not thread startup time.
            while !stopping.load(Ordering::Acquire) {
                if let Ok((mut stream, _)) = listener.accept() {
                    on_accept(&stream);
                    // Winsock inherits the listener mode; request I/O must block.
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        let n = stream.read(&mut buf).unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                            let length = header
                                .lines()
                                .find_map(|s| {
                                    s.strip_prefix("content-length: ")
                                        .and_then(|s| s.parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    requests
                        .lock()
                        .unwrap()
                        .push(String::from_utf8(bytes).unwrap());
                    std::thread::sleep(delay);
                    let body = "private-api-detail recipient@example.test secret-key";
                    let _ = write!(stream, "HTTP/1.1 {status} response\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:1/forbidden\r\n\r\n{body}", body.len());
                } else {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        });
        (
            url,
            captured,
            ServerHandle {
                shutdown,
                thread: Some(handle),
            },
        )
    }

    #[test]
    fn old_config_defaults_email_off_without_a_fixed_sender() {
        let cfg: crate::config::AlertsConfig = serde_json::from_str("{}").unwrap();
        assert!(!cfg.email.enabled);
        assert!(!cfg.email.consent);
        assert!(cfg.email.sender.is_empty());
        assert!(cfg.email.recipient.is_empty());
        assert!(cfg.enabled && cfg.native);
    }

    #[test]
    fn gates_reject_before_reading_credentials_or_network() {
        let mut cfg = config();
        cfg.email.consent = false;
        assert_eq!(
            run(send_with(
                &cfg,
                Locale::En,
                None,
                || panic!("credential read"),
                "http://127.0.0.1:1",
                Duration::from_secs(5)
            )),
            EmailStatus::ConsentRequired
        );
        cfg.email.consent = true;
        cfg.email.sender = "injected\r\nBcc:x@example.test".into();
        assert_eq!(
            run(send_with(
                &cfg,
                Locale::En,
                None,
                || panic!("credential read"),
                "http://127.0.0.1:1",
                Duration::from_secs(5)
            )),
            EmailStatus::ConfigurationMissing
        );
        cfg = config();
        cfg.enabled = false;
        assert_eq!(
            run(send_with(
                &cfg,
                Locale::En,
                Some(event()),
                || panic!("credential read"),
                "http://127.0.0.1:1",
                Duration::from_secs(5)
            )),
            EmailStatus::Disabled
        );
        cfg.enabled = true;
        cfg.email.enabled = false;
        assert_eq!(
            run(send_with(
                &cfg,
                Locale::En,
                Some(event()),
                || panic!("credential read"),
                "http://127.0.0.1:1",
                Duration::from_secs(5)
            )),
            EmailStatus::Disabled
        );
    }

    #[test]
    fn key_absence_and_store_failure_are_different_and_safe() {
        for (key, expected) in [
            (Ok(None), EmailStatus::KeyMissing),
            (Err("private-detail".into()), EmailStatus::KeyringError),
        ] {
            assert_eq!(
                run(send_with(
                    &config(),
                    Locale::En,
                    None,
                    || key,
                    "http://127.0.0.1:1",
                    Duration::from_secs(5)
                )),
                expected
            );
            assert!(!serde_json::to_string(&expected)
                .unwrap()
                .contains("private"));
        }
    }

    #[test]
    fn one_minimal_request_accepted_with_native_off() {
        let (url, requests, handle) = server(200, Duration::ZERO);
        let mut cfg = config();
        cfg.native = false;
        let result = run(send_with(
            &cfg,
            Locale::En,
            Some(event()),
            || Ok(Some("synthetic-key".into())),
            &url,
            Duration::from_secs(5),
        ));
        handle.join().unwrap();
        assert_eq!(result, EmailStatus::Accepted);
        let req = requests.lock().unwrap();
        assert_eq!(req.len(), 1);
        assert!(req[0].starts_with("POST /emails HTTP/1.1"));
        assert!(req[0]
            .to_lowercase()
            .contains("authorization: bearer synthetic-key\r\n"));
        let body: serde_json::Value =
            serde_json::from_str(req[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"from":"sender@example.test", "to":["recipient@example.test"], "subject":"Quorb: usage alert", "text":"Provider: claude\nMeter: five_hour\nWindow: 12345\nPercent: 95\nEvent: exceeded"})
        );
        assert!(!body.to_string().contains("synthetic-key"));
    }

    /// S21 (#245): asunto y cuerpo siguen el locale de la config; el inglés
    /// conserva los literales originales byte a byte.
    #[test]
    fn email_texts_follow_configured_locale() {
        for (locale, subject, text) in [
            (
                Locale::Es,
                "Quorb: alerta de consumo",
                "Proveedor: claude\nMedidor: five_hour\nVentana: 12345\nPorcentaje: 95\nEvento: superado",
            ),
            (
                Locale::En,
                "Quorb: usage alert",
                "Provider: claude\nMeter: five_hour\nWindow: 12345\nPercent: 95\nEvent: exceeded",
            ),
        ] {
            let (url, requests, handle) = server(200, Duration::ZERO);
            let result = run(send_with(
                &config(),
                locale,
                Some(event()),
                || Ok(Some("synthetic-key".into())),
                &url,
                Duration::from_secs(5),
            ));
            handle.join().unwrap();
            assert_eq!(result, EmailStatus::Accepted);
            let req = requests.lock().unwrap();
            let body: serde_json::Value =
                serde_json::from_str(req[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(
                body,
                serde_json::json!({"from":"sender@example.test", "to":["recipient@example.test"], "subject": subject, "text": text})
            );
        }
    }

    /// S21 (#245): el cuerpo de la prueba explícita también se traduce.
    #[test]
    fn test_email_body_follows_locale() {
        for (locale, text) in [
            (
                Locale::Es,
                "Quorb: prueba explícita de email (sin datos de consumo).",
            ),
            (Locale::En, "Quorb: explicit email test (no usage data)."),
        ] {
            let (url, requests, handle) = server(200, Duration::ZERO);
            let result = run(send_with(
                &config(),
                locale,
                None,
                || Ok(Some("synthetic-key".into())),
                &url,
                Duration::from_secs(5),
            ));
            handle.join().unwrap();
            assert_eq!(result, EmailStatus::Accepted);
            let req = requests.lock().unwrap();
            let body: serde_json::Value =
                serde_json::from_str(req[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!(body["text"], text);
        }
    }

    #[test]
    fn explicit_test_works_while_disabled_without_activating() {
        let (url, requests, handle) = server(200, Duration::ZERO);
        let mut cfg = config();
        cfg.enabled = false;
        cfg.email.enabled = false;
        let before = cfg.clone();
        assert_eq!(
            run(send_with(
                &cfg,
                Locale::En,
                None,
                || Ok(Some("synthetic-key".into())),
                &url,
                Duration::from_secs(5)
            )),
            EmailStatus::Accepted
        );
        handle.join().unwrap();
        assert_eq!(cfg, before);
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    /// Model Winsock's inherited nonblocking mode even on Unix hosts.
    #[test]
    fn nonblocking_accepted_socket_waits_for_complete_request() {
        let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
        let (url, requests, handle) = server_with_accept(200, Duration::ZERO, move |stream| {
            stream.set_nonblocking(true).unwrap();
            accepted_tx.send(()).unwrap();
        });
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/emails")
            .unwrap();
        let mut client = std::net::TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        accepted_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut byte = [0u8; 1];
        let expect_no_response = |client: &mut std::net::TcpStream, byte: &mut [u8]| {
            let result = client.read(byte);
            assert!(
                matches!(result, Err(ref error) if matches!(error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)),
                "fixture responded before the complete request: {result:?}"
            );
        };
        expect_no_response(&mut client, &mut byte);
        let header = "POST /emails HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\n";
        client.write_all(header.as_bytes()).unwrap();
        client.write_all(b"te").unwrap();
        expect_no_response(&mut client, &mut byte);
        client.write_all(b"st").unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        handle.join().unwrap();
        assert_eq!(response, format!("HTTP/1.1 200 response\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:1/forbidden\r\n\r\n{}",
            "private-api-detail recipient@example.test secret-key".len(),
            "private-api-detail recipient@example.test secret-key"));
        assert_eq!(*requests.lock().unwrap(), vec![format!("{header}test")]);
    }

    /// S23 (#245): pin del backend, no del guardado de Ajustes. Con email
    /// deshabilitado, el gate del propio backend rechaza el envío automático
    /// antes de leer llavero o red; al re-habilitar se reutiliza la clave
    /// disponible sin exigir `set_secret` de nuevo (solo un set vacío explícito
    /// la borra en `secrets.rs`). La conservación a través del flujo real de
    /// guardado (patchEmail → runMixedSave → api.saveConfig) se cubre en
    /// `src/lib/email.test.ts`; la persistencia del llavero del SO es manual
    /// por plataforma (S24) y queda fuera de este test.
    #[test]
    fn backend_gates_disabled_email_and_reuses_available_key() {
        let (url, requests, handle) = server(200, Duration::ZERO);
        let store = Arc::new(Mutex::new(Some("synthetic-key".to_string())));
        let mut cfg = config();
        let reader = || Ok(store.lock().unwrap().clone());
        assert_eq!(
            run(send_with(
                &cfg,
                Locale::En,
                Some(event()),
                reader,
                &url,
                Duration::from_secs(5)
            )),
            EmailStatus::Accepted
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(store.lock().unwrap().as_deref(), Some("synthetic-key"));

        // Guardado de config con email desactivado: el round-trip de serde no
        // altera el almacén ni pierde el interruptor.
        cfg.email.enabled = false;
        let saved: crate::config::AlertsConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert!(!saved.email.enabled);
        assert_eq!(store.lock().unwrap().as_deref(), Some("synthetic-key"));

        // Desactivado, el gate del backend rechaza antes de leer la clave:
        // ni petición HTTP ni acceso al almacén.
        assert_eq!(
            run(send_with(
                &saved,
                Locale::En,
                Some(event()),
                reader,
                &url,
                Duration::from_secs(5)
            )),
            EmailStatus::Disabled
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(store.lock().unwrap().as_deref(), Some("synthetic-key"));

        // Re-habilitar reutiliza la clave disponible: segunda y última petición.
        let mut reenabled = saved;
        reenabled.email.enabled = true;
        assert_eq!(
            run(send_with(
                &reenabled,
                Locale::En,
                Some(event()),
                reader,
                &url,
                Duration::from_secs(5)
            )),
            EmailStatus::Accepted
        );
        handle.join().unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        assert_eq!(store.lock().unwrap().as_deref(), Some("synthetic-key"));
    }

    /// A loaded test runner may not poll the first request within 350 ms.
    #[test]
    fn late_first_request_is_still_served() {
        let (url, requests, handle) = server(200, Duration::ZERO);
        std::thread::sleep(Duration::from_millis(400));
        let status = run(send_with(
            &config(),
            Locale::En,
            Some(event()),
            || Ok(Some("synthetic-key".into())),
            &url,
            Duration::from_secs(5),
        ));
        handle.join().unwrap();
        assert_eq!(status, EmailStatus::Accepted);
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn errors_redirects_and_timeout_never_retry_or_expose_response() {
        for (code, delay, expected) in [
            (401, Duration::ZERO, EmailStatus::AuthenticationError),
            (403, Duration::ZERO, EmailStatus::SenderRejected),
            (422, Duration::ZERO, EmailStatus::RequestRejected),
            (429, Duration::ZERO, EmailStatus::RateLimited),
            (500, Duration::ZERO, EmailStatus::ServiceError),
            (302, Duration::ZERO, EmailStatus::RequestRejected),
            (200, Duration::from_secs(3), EmailStatus::AcceptanceUnknown),
        ] {
            let (url, requests, handle) = server(code, delay);
            let status = run(send_with(
                &config(),
                Locale::En,
                None,
                || Ok(Some("synthetic-key".into())),
                &url,
                if delay.is_zero() {
                    Duration::from_secs(5)
                } else {
                    Duration::from_secs(2)
                },
            ));
            handle.join().unwrap();
            assert_eq!(status, expected);
            assert_eq!(requests.lock().unwrap().len(), 1);
            let diagnostic = serde_json::to_string(&status).unwrap();
            for private in ["private-api-detail", "recipient@example.test", "secret-key"] {
                assert!(!diagnostic.contains(private));
            }
        }
    }

    #[test]
    fn event_rejects_account_identity_and_arbitrary_content_before_key_read() {
        for bad in [
            EmailEvent {
                provider: "claude:private-account".into(),
                ..event()
            },
            EmailEvent {
                meter: "prompt or session content".into(),
                ..event()
            },
            EmailEvent {
                percent: f64::NAN,
                ..event()
            },
            EmailEvent {
                window: "private".into(),
                ..event()
            },
        ] {
            assert_eq!(
                run(send_with(
                    &config(),
                    Locale::En,
                    Some(bad),
                    || panic!("credential read"),
                    "http://127.0.0.1:1",
                    Duration::from_secs(5)
                )),
                EmailStatus::RequestRejected
            );
        }
    }
}
