//! TEMPORAL (diagnóstico, no para `main`): traza de por qué la tira se oculta
//! sola en Windows.
//!
//! El síntoma: la ventana deja de verse tras un rato de inactividad y el owner
//! la recupera con un clic en la bandeja. Este módulo escribe una línea por
//! cada cambio de estado observable de la ventana, más el origen de cada
//! `hide`/`show` que la app pide. La idea es que el problema deje de ser
//! intermitente: cuando vuelva a pasar, el log dice qué estado tenía la
//! ventana y quién la cambió.
//!
//! Se usa sólo en Windows (`start` se llama bajo `cfg(windows)`), pero el
//! módulo se compila en todas las plataformas para poder verificarlo aquí.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::WIDGET;

/// Cada cuánto el vigilante mira el estado de la ventana.
const POLL_MS: u64 = 1_000;

/// El fichero de la traza, en el directorio de configuración de la app.
pub(crate) const TRACE_FILE: &str = "visibility-trace.log";

/// El último estado escrito, para escribir sólo cuando cambia.
static LAST: Mutex<Option<String>> = Mutex::new(None);

/// ¿Hay que escribir esta lectura? Sólo si difiere de la anterior.
///
/// Sin esta regla el fichero crece una línea por segundo durante horas y el
/// momento del cambio queda enterrado entre el ruido.
pub(crate) fn should_log(previous: Option<&str>, next: &str) -> bool {
    match previous {
        Some(p) => p != next,
        None => true,
    }
}

/// La lectura del estado, armada a partir de valores ya recogidos.
///
/// Distingue las causas posibles del síntoma:
/// - `visible=0`: la ventana está oculta (alguien pidió `hide` o Windows le
///   quitó `WS_VISIBLE`).
/// - `min=1`: está minimizada.
/// - `onMonitor=0`: sigue "visible" pero fuera de todo monitor (el caso #147,
///   `-32000,-32000`).
/// - `visible=1 min=0 onMonitor=1`: la ventana existe y está en su sitio,
///   así que lo que falla es que otra ventana la tapa o está cloaked.
pub(crate) fn format_reading(
    visible: u8,
    min: u8,
    focus: u8,
    pos: &str,
    size: &str,
    scale: f64,
    on_monitor: bool,
    monitors: usize,
) -> String {
    format!(
        "visible={visible} min={min} focus={focus} pos={pos} size={size} scale={scale} onMonitor={} monitors={monitors}",
        on_monitor as u8
    )
}

fn trace_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    dir.join(TRACE_FILE)
}

fn append(app: &AppHandle, line: &str) {
    let path = trace_path(app);
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{stamp} {line}");
    }
}

/// El estado observable de la ventana, en una línea.
pub(crate) fn snapshot(w: &WebviewWindow) -> String {
    // `2` cuando la lectura falla: un bool no distingue "no" de "no se pudo
    // preguntar" y esa diferencia es justamente la que separa un hide de la
    // app de un estado que Windows cambió por su cuenta.
    let visible = w.is_visible().map(|v| v as u8).unwrap_or(2);
    let min = w.is_minimized().map(|v| v as u8).unwrap_or(2);
    let focus = w.is_focused().map(|v| v as u8).unwrap_or(2);
    let pos = w.outer_position().ok();
    let size = w.outer_size().ok();
    let scale = w.scale_factor().unwrap_or(0.0);
    let monitors: Vec<_> = w
        .available_monitors()
        .map(|m| m.to_vec())
        .unwrap_or_default();
    let on_monitor = match (pos.as_ref(), size.as_ref()) {
        (Some(p), Some(s)) => monitors.iter().any(|m| {
            let mp = m.position();
            let ms = m.size();
            let (x0, y0) = (p.x, p.y);
            let (x1, y1) = (p.x + s.width as i32, p.y + s.height as i32);
            x1 > mp.x && y1 > mp.y && x0 < mp.x + ms.width as i32 && y0 < mp.y + ms.height as i32
        }),
        _ => false,
    };
    let pos = pos.map(|p| format!("{},{}", p.x, p.y)).unwrap_or_default();
    let size = size
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_default();
    format_reading(
        visible,
        min,
        focus,
        &pos,
        &size,
        scale,
        on_monitor,
        monitors.len(),
    )
}

/// Escribe una línea con el origen de la acción y el estado actual.
pub(crate) fn trace(app: &AppHandle, origin: &str, window: &WebviewWindow) {
    let line = format!("{origin} {}", snapshot(window));
    append(app, &line);
}

/// Vigila el estado cada segundo y escribe sólo cuando cambia.
///
/// Es lo que atrapa el evento aunque nadie haga clic: en el momento en que la
/// ventana pierde `visible`, queda registrado con la hora exacta.
pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        let Some(w) = app.get_webview_window(WIDGET) else {
            append(&app, "watch window-missing");
            continue;
        };
        let now = snapshot(&w);
        let previous = LAST.lock().ok().and_then(|g| g.clone());
        if should_log(previous.as_deref(), &now) {
            append(&app, &format!("watch {now}"));
            if let Ok(mut guard) = LAST.lock() {
                *guard = Some(now);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_reading_is_always_written() {
        assert!(should_log(None, "visible=1 min=0"));
    }

    #[test]
    fn an_identical_reading_is_not_repeated() {
        // Sin esta regla el log crece una línea por segundo durante horas y el
        // cambio queda enterrado entre el ruido.
        assert!(!should_log(Some("visible=1 min=0"), "visible=1 min=0"));
    }

    #[test]
    fn any_change_is_written() {
        assert!(should_log(Some("visible=1 min=0"), "visible=0 min=0"));
        assert!(should_log(
            Some("visible=1 min=0"),
            "visible=1 min=0 pos=-32000,-32000"
        ));
    }

    #[test]
    fn the_reading_names_every_state_that_explains_the_symptom() {
        let reading = format_reading(1, 0, 1, "1300,60", "420x44", 1.25, true, 2);
        for (key, value) in [
            ("visible", "1"),
            ("min", "0"),
            ("focus", "1"),
            ("pos", "1300,60"),
            ("size", "420x44"),
            ("onMonitor", "1"),
            ("monitors", "2"),
        ] {
            assert!(
                reading.contains(&format!("{key}={value}")),
                "falta {key}={value} en: {reading}"
            );
        }
    }

    #[test]
    fn an_unknown_reading_is_visible_as_unknown() {
        // `2` = la lectura falló. Un `false` disfrazado de `0` haría indistinguible
        // un hide de la app de un fallo al preguntar.
        let reading = format_reading(2, 2, 2, "", "", 0.0, false, 0);
        assert!(reading.contains("visible=2"));
        assert!(reading.contains("min=2"));
        assert!(reading.contains("onMonitor=0"));
    }
}
