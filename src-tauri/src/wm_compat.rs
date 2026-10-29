//! Detección de compositor y caveats de Ajustes para el port nativo a Linux.
//!
//! Lee las variables de entorno estándar (`WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`,
//! `DESKTOP_SESSION`, `XDG_CURRENT_DESKTOP`) y devuelve un resumen accionable
//! para Ajustes. El frontend usa esto para mostrar el bloque "Compatibilidad"
//! y degradar comportamientos no soportados por el compositor actual.
//!
//! Issue ODD #107 (escritorio y widget nativos): este módulo es **solo
//! informativo**; las decisiones de fallback (saltar always-on-top, ocultar
//! click-through) las toma el frontend a partir de la `recommendation`.
//!
//! La función pública es `detect_wm_info_from_env` (pura) — toma las 4
//! env vars como `&Env` y devuelve un `WindowManagerInfo`. Los tests la usan
//! directamente, sin tocar `std::env` global (evita race entre threads en
//! `cargo test`). `detect_wm_info` la envuelve con `std::env::var` para uso
//! desde el command Tauri y desde el frontend vía `invoke('get_wm_info')`.

use serde::Serialize;

/// Effective GDK display backend (issue #180, WU1/WU4 maintainer correction):
/// drag mode and the `windowPositioning` surface branch on THIS value — the
/// backend GTK actually uses at runtime — never on the session type. E.g. a
/// full Wayland session with `GDK_BACKEND=x11` is X11.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayBackend {
    X11,
    Wayland,
}

/// Resumen de compositor y caveats para Ajustes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowManagerInfo {
    /// `Some` si `WAYLAND_DISPLAY` está set; el widget está corriendo bajo Wayland.
    pub wayland_display: Option<String>,
    /// `Some` si `XDG_SESSION_TYPE` está set; valores esperados: `wayland`, `x11`, `tty`, `mir`.
    pub xdg_session_type: Option<String>,
    /// `Some` si `DESKTOP_SESSION` está set (p. ej. `gnome`, `plasma`, `hyprland`).
    pub desktop_session: Option<String>,
    /// `Some` si `XDG_CURRENT_DESKTOP` está set (p. ej. `GNOME`, `KDE`, `Hyprland`).
    pub xdg_current_desktop: Option<String>,
    /// `true` si el protocolo de sesión es Wayland: `WAYLAND_DISPLAY` set,
    /// `XDG_SESSION_TYPE=wayland`, o un compositor solo-Wayland en
    /// `XDG_CURRENT_DESKTOP`. GNOME/KDE son protocolo-agnóstico (X11/Wayland),
    /// así que su presencia no prueba Wayland.
    pub is_wayland: bool,
    /// `true` si detectamos Hyprland (siempre-on-top especialmente estricto).
    pub is_hyprland: bool,
    /// Recomendación accionable para Ajustes: qué hacer con always-on-top,
    /// click-through y edge-docking en este entorno.
    pub recommendation: &'static str,
    /// Backend GDK efectivo (issue #180): decide drag mode y la superficie
    /// `windowPositioning`. Corresponde al display de GDK en runtime (sonda
    /// best-effort) o, si no resolvió, al fallback por `GDK_BACKEND`/sesión.
    pub display_backend: DisplayBackend,
    /// Estado y nota por superficie (widget, bandeja, atajos, autostart,
    /// notificaciones y transparencia) según la sesión detectada. Solo
    /// informativo: el frontend lo muestra tal cual en Ajustes.
    pub surfaces: DesktopSurfaces,
}

/// Estado de una superficie de escritorio para la sesión detectada.
/// `Default` es derivable para encadenar `..Default::default()` en literales
/// (la superficie nueva `window_positioning` siempre se recálcula explícita).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct SurfaceStatus {
    /// `ok` si la superficie se espera completa; `limited` límites explícitos.
    pub state: &'static str,
    /// Límite observado por sesión/compositor, con qué hacer. Sin promises.
    pub note: &'static str,
}

/// Snapshot de superficies del escritorio (issue #107). Comónico a
/// X11/compositores Wayland: la variación se concentra en las notas.
/// `Default` es derivable para `surfaces_for`: las ramas por sesión no
/// necesitan repetir el literal de `window_positioning` (ver wrapper).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSurfaces {
    pub always_on_top: SurfaceStatus,
    pub click_through: SurfaceStatus,
    pub tray_icon: SurfaceStatus,
    pub global_shortcuts: SurfaceStatus,
    pub autostart: SurfaceStatus,
    pub notifications: SurfaceStatus,
    pub transparency: SurfaceStatus,
    /// Posicionamiento/arrastre de la tira (issue #180): SOLO decide por el
    /// backend GDK efectivo, nunca por el tipo de sesión. Bajo XWayland
    /// (`GDK_BACKEND=x11`) debe reportar `ok`.
    pub window_positioning: SurfaceStatus,
}

/// Las 5 env vars que miramos, normalizadas: `None` si ausentes o vacías.
/// `gdk_backend` es `GDK_BACKEND` (issue #180): GTK lo acepta como lista
/// separada por comas (p. ej. `"x11,*"`) y decide el backend GDK efectivo.
#[derive(Debug, Default, Clone)]
pub struct Env {
    pub wayland_display: Option<String>,
    pub xdg_session_type: Option<String>,
    pub desktop_session: Option<String>,
    pub xdg_current_desktop: Option<String>,
    pub gdk_backend: Option<String>,
}

impl Env {
    /// Lee las env vars del proceso y las normaliza (vacía → None).
    pub fn from_process() -> Self {
        Self {
            wayland_display: std::env::var("WAYLAND_DISPLAY")
                .ok()
                .filter(|s| !s.is_empty()),
            xdg_session_type: std::env::var("XDG_SESSION_TYPE")
                .ok()
                .filter(|s| !s.is_empty()),
            desktop_session: std::env::var("DESKTOP_SESSION")
                .ok()
                .filter(|s| !s.is_empty()),
            xdg_current_desktop: std::env::var("XDG_CURRENT_DESKTOP")
                .ok()
                .filter(|s| !s.is_empty()),
            gdk_backend: std::env::var("GDK_BACKEND").ok().filter(|s| !s.is_empty()),
        }
    }
}

/// Versión pura: toma un `&Env` y devuelve el resumen. Sin globales, sin
/// efectos secundarios, **thread-safe** (los tests la llaman directamente
/// sin tocar `std::env`).
pub fn detect_wm_info_from_env(env: &Env, tray: TrayDiagnostics) -> WindowManagerInfo {
    // Normaliza el string vacío como "ausente" para TODOS los checks, igual
    // que `Env::from_process`: si el caller construye el `Env` a mano y le
    // pasa `Some("")` (los tests lo hacen), un string vacío no debe contar
    // como señal de Wayland ni aparecer en el struct.
    let env_n = normalize_env(env);

    // Single-source session signals: reused verbatim by the display-backend
    // fallback and the runtime-probe override so nothing drifts.
    let is_hyprland = is_hyprland_signal(&env_n);
    // Protocolo Wayland: solo evidencia de protocolo, no de escritorio.
    // GNOME/KDE cotidianamente corren sobre Xorg: su token en
    // XDG_CURRENT_DESKTOP no debe marcar Wayland. Sway/Hyprland/wlroots y
    // el resto de tokens solo-Wayland no tienen X11, así que sí lo señalan.
    let is_wayland = is_wayland_protocol(&env_n, is_hyprland);
    let is_gnome = is_gnome_signal(&env_n);
    let display_backend = display_backend_from_env(&env_n);
    let is_kde = env_n
        .desktop_session
        .as_deref()
        .map(|s| {
            matches!(
                s.to_ascii_lowercase().as_str(),
                "kde"
                    | "kde-5"
                    | "kde-6"
                    | "kde-plasma"
                    | "plasma"
                    | "plasma5"
                    | "plasma6"
                    | "kde_x11"
                    | "kde5-19"
                    | "default.desktop"
            )
        })
        .unwrap_or(false)
        || env_n
            .xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(is_kde_token))
            .unwrap_or(false);

    let recommendation = recommendation(
        is_wayland,
        is_hyprland,
        is_kde,
        env_n.desktop_session.as_deref(),
        env_n.xdg_current_desktop.as_deref(),
    );

    WindowManagerInfo {
        wayland_display: env_n.wayland_display,
        xdg_session_type: env_n.xdg_session_type,
        desktop_session: env_n.desktop_session,
        xdg_current_desktop: env_n.xdg_current_desktop,
        is_wayland,
        is_hyprland,
        recommendation,
        display_backend,
        surfaces: surfaces_for(
            is_wayland,
            is_hyprland,
            is_gnome,
            is_kde,
            display_backend,
            tray,
        ),
    }
}

/// Normaliza strings vacíos como "ausente" en TODOS los campos, igual que
/// `Env::from_process`: si el caller construye el `Env` a mano y le pasa
/// `Some("")` (los tests lo hacen), un string vacío no debe contar como señal.
fn normalize_env(env: &Env) -> Env {
    let non_empty = |opt: &Option<String>| opt.clone().filter(|s| !s.is_empty());
    Env {
        wayland_display: non_empty(&env.wayland_display),
        xdg_session_type: non_empty(&env.xdg_session_type),
        desktop_session: non_empty(&env.desktop_session),
        xdg_current_desktop: non_empty(&env.xdg_current_desktop),
        gdk_backend: non_empty(&env.gdk_backend),
    }
}

/// Señal Hyprland (`DESKTOP_SESSION=hyprland` o token `Hyprland` en
/// `XDG_CURRENT_DESKTOP`). Extraída de `detect_wm_info_from_env` para que el
/// fallback del backend efectivo la reutilice sin duplicar los matches.
fn is_hyprland_signal(env_n: &Env) -> bool {
    env_n
        .desktop_session
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("hyprland"))
        .unwrap_or(false)
        || env_n
            .xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(|p| p.eq_ignore_ascii_case("Hyprland")))
            .unwrap_or(false)
}

/// ¿La sesión habla protocolo Wayland? Semática idéntica a la rama de
/// `detect_wm_info_from_env` (evidencia de protocolo, no de escritorio).
fn is_wayland_protocol(env_n: &Env, is_hyprland: bool) -> bool {
    env_n.wayland_display.is_some()
        || env_n
            .xdg_session_type
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
        || env_n
            .xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(is_wayland_only_session))
            .unwrap_or(false)
        || is_hyprland
}

/// Señal GNOME (`DESKTOP_SESSION=gnome` o token `GNOME` en
/// `XDG_CURRENT_DESKTOP`). Única fuente para la rama de superficies y para el
/// recálculo de `windowPositioning` en el override de la sonda runtime.
fn is_gnome_signal(env_n: &Env) -> bool {
    env_n
        .desktop_session
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("gnome"))
        .unwrap_or(false)
        || env_n
            .xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(|p| p.eq_ignore_ascii_case("GNOME")))
            .unwrap_or(false)
}

/// Effective GDK display backend from environment evidence (issue #180,
/// WU1/WU4 maintainer correction). Pure; approximation of GTK semantics:
/// GTK walks the comma-separated `GDK_BACKEND` list and initializes the first
/// backend it can successfully set up (`*` means the platform default order).
/// We approximate without initializing GTK: the first decisive token in the
/// list decides (`x11` → X11, `wayland` → Wayland); any other token (`*`,
/// unknown backend names) is skipped, i.e. "let the GTK default happen". With
/// no decisive token the session-based default applies: Wayland when the
/// session signals the Wayland protocol, else X11 (same detection as
/// `is_wayland_session_from_env`).
///
/// Known approximation limits (accepted; the fallback must stand alone):
/// an `"x11,wayland"` list resolves to X11 even if no X server exists and
/// GTK would have fallen through to Wayland. The runtime probe applied in
/// `get_wm_info` is the authoritative refinement when it resolves.
pub fn display_backend_from_env(env: &Env) -> DisplayBackend {
    let env_n = normalize_env(env);
    if let Some(raw) = env_n.gdk_backend.as_deref() {
        for token in raw.split(',') {
            match token.trim().to_ascii_lowercase().as_str() {
                "x11" => return DisplayBackend::X11,
                "wayland" => return DisplayBackend::Wayland,
                // "*" and unknown names: keep walking (GTK default order).
                _ => continue,
            }
        }
    }
    let is_hyprland = is_hyprland_signal(&env_n);
    if is_wayland_protocol(&env_n, is_hyprland) {
        DisplayBackend::Wayland
    } else {
        DisplayBackend::X11
    }
}

/// Runtime override of the effective display backend (issue #180, WU4): the
/// live GDK probe, when it resolves, MUST win over the env fallback. Pure
/// helper, applied at the command level: rewrites `display_backend` and
/// recomputes ONLY `surfaces.window_positioning`; every other surface stays
/// untouched.
pub fn with_display_backend(
    mut info: WindowManagerInfo,
    backend: DisplayBackend,
) -> WindowManagerInfo {
    info.display_backend = backend;
    let desktop_env = Env {
        wayland_display: None,
        xdg_session_type: None,
        desktop_session: info.desktop_session.clone(),
        xdg_current_desktop: info.xdg_current_desktop.clone(),
        gdk_backend: None,
    };
    info.surfaces.window_positioning =
        window_positioning_status(backend, is_gnome_signal(&desktop_env));
    info
}

/// Token de escritorio KDE en `XDG_CURRENT_DESKTOP` (lista separada por `:`).
fn is_kde_token(token: &str) -> bool {
    matches!(
        token.trim().to_ascii_lowercase().as_str(),
        "kde" | "kdeapp" | "plasma" | "kde-plasma"
    )
}

/// Límites por superficie derivados de la sesión detectada. Pura y
/// determinista: los tests fijan lo que Ajustes va a mostrar. El diagnóstico
/// de bandeja (`tray`) se inyecta: solo la rama GNOME lo consume.
///
/// Issue #180 (WU4): `display_backend` es el backend GDK efectivo, ya
/// calculado por `display_backend_from_env`; `surfaces_for` lo recibe para
/// poblar SOLO la superficie nueva `window_positioning`, el resto de ramas
/// sigue dependiendo del tipo de sesión/compositor como siempre.
fn surfaces_for(
    is_wayland: bool,
    is_hyprland: bool,
    is_gnome: bool,
    is_kde: bool,
    display_backend: DisplayBackend,
    tray: TrayDiagnostics,
) -> DesktopSurfaces {
    // windowPositioning NO depende del tipo de sesión: solo del backend GDK
    // efectivo (el input de compositor solo refina la nota en GNOME).
    DesktopSurfaces {
        window_positioning: window_positioning_status(display_backend, is_gnome),
        ..desktop_surfaces_by_session(is_wayland, is_hyprland, is_gnome, is_kde, tray)
    }
}

/// Superficies por sesión/compositor (el cuerpo histórico de `surfaces_for`).
fn desktop_surfaces_by_session(
    is_wayland: bool,
    is_hyprland: bool,
    is_gnome: bool,
    is_kde: bool,
    tray: TrayDiagnostics,
) -> DesktopSurfaces {
    if !is_wayland {
        // X11 (la común en la matriz): siempre-encima, click-through, bandeja,
        // atajos y transparencia dependen del compositor de Windows, pero los
        // escritorios evaluados (GNOME, KDE, XFCE) compositan.
        return DesktopSurfaces {
            always_on_top: SurfaceStatus { state: "ok", note: "En X11 la tira se mantiene sobre las demás ventanas." },
            click_through: SurfaceStatus { state: "limited", note: "Click-through del widget no implementado: el ratón no atraviesa la tira; solo el overlay de efectos lo usa." },
            tray_icon: SurfaceStatus { state: "ok", note: "El icono de bandeja se muestra en los gestores que la evalúan." },
            global_shortcuts: SurfaceStatus { state: "ok", note: "Los atajos globales funcionan desde cualquier app." },
            autostart: SurfaceStatus { state: "ok", note: "Arranque al iniciar sesión vía XDG autostart (.desktop)." },
            notifications: SurfaceStatus { state: "ok", note: "Notificaciones por org.freedesktop.Notifications (daemon del escritorio)." },
            transparency: SurfaceStatus { state: "ok", note: "Requiere composición activa (GNOME, KDE y XFCE la traen)." },
            ..Default::default()
        };
    }
    if is_hyprland {
        return DesktopSurfaces {
            always_on_top: SurfaceStatus { state: "limited", note: "Hyprland aplica siempre-encima de forma estricta; si la tira se oculta, usa «Auto-hide»." },
            click_through: SurfaceStatus { state: "limited", note: "Click-through del widget no implementado: el ratón no atraviesa la tira; solo el overlay de efectos lo usa." },
            tray_icon: SurfaceStatus { state: "limited", note: "Sin una barra que muestre AppIndicator, el icono no se ve: vuelve a abrir Quorb para recuperar la tira." },
            global_shortcuts: SurfaceStatus { state: "limited", note: "Los atajos globales dependen del registro por portal; si falla, el error se ve en Ajustes › Atajos." },
            autostart: SurfaceStatus { state: "ok", note: "Arranque al iniciar sesión vía XDG autostart (.desktop)." },
            notifications: SurfaceStatus { state: "ok", note: "Notificaciones por org.freedesktop.Notifications (daemon del escritorio)." },
            transparency: SurfaceStatus { state: "ok", note: "El compositor aplica transparencia." },
            ..Default::default()
        };
    }
    if is_gnome {
        return DesktopSurfaces {
            always_on_top: SurfaceStatus { state: "limited", note: "Mutter admite hints de siempre-encima de forma parcial; si la tira se oculta tras ventanas, usa «Auto-hide»." },
            click_through: SurfaceStatus { state: "limited", note: "Mutter puede ignorar la región de input: el ratón puede quedar capturado en el hueco; prueba a mover la tira." },
            // #181 (ajuste 1): el estado primario es del host StatusNotifier
            // (presente/ausente/desconocido); la extensión es complementaria.
            // Con host solo se acredita disponibilidad, no visibilidad del icono.
            tray_icon: SurfaceStatus { state: gnome_tray_state(tray), note: gnome_tray_note(tray) },
            global_shortcuts: SurfaceStatus { state: "limited", note: "El registro puede denegarse en Wayland: el error se muestra en Ajustes › Atajos." },
            autostart: SurfaceStatus { state: "ok", note: "Arranque al iniciar sesión vía XDG autostart (.desktop)." },
            notifications: SurfaceStatus { state: "ok", note: "Notificaciones por org.freedesktop.Notifications (daemon del escritorio)." },
            transparency: SurfaceStatus { state: "ok", note: "El compositor aplica transparencia." },
            ..Default::default()
        };
    }
    if is_kde {
        return DesktopSurfaces {
            always_on_top: SurfaceStatus { state: "ok", note: "KWin respeta siempre-encima." },
            click_through: SurfaceStatus { state: "limited", note: "Click-through del widget no implementado: el ratón no atraviesa la tira; solo el overlay de efectos lo usa." },
            tray_icon: SurfaceStatus { state: "ok", note: "KDE soporta bandeja AppIndicator/StatusNotifier de forma nativa." },
            global_shortcuts: SurfaceStatus { state: "limited", note: "El registro puede denegarse en Wayland: el error se muestra en Ajustes › Atajos." },
            autostart: SurfaceStatus { state: "ok", note: "Arranque al iniciar sesión vía XDG autostart (.desktop)." },
            notifications: SurfaceStatus { state: "ok", note: "Notificaciones por org.freedesktop.Notifications (daemon del escritorio)." },
            transparency: SurfaceStatus { state: "ok", note: "El compositor aplica transparencia." },
            ..Default::default()
        };
    }
    // Wayland genérico (sway, wlroots, otros de la matriz): notas prudentes
    // mientras la verificación no confirme cada compositor.
    DesktopSurfaces {
        always_on_top: SurfaceStatus { state: "limited", note: "El soporte de siempre-encima depende del compositor; si la tira se oculta, usa «Auto-hide»." },
        click_through: SurfaceStatus { state: "limited", note: "Click-through del widget no implementado: el ratón no atraviesa la tira; solo el overlay de efectos lo usa." },
        tray_icon: SurfaceStatus { state: "limited", note: "Solo se muestra el icono si la barra admite StatusNotifier/AppIndicator." },
        global_shortcuts: SurfaceStatus { state: "limited", note: "El registro puede denegarse en Wayland: el error se muestra en Ajustes › Atajos." },
        autostart: SurfaceStatus { state: "ok", note: "Arranque al iniciar sesión vía XDG autostart (.desktop)." },
        notifications: SurfaceStatus { state: "ok", note: "Notificaciones por org.freedesktop.Notifications (daemon del escritorio)." },
        transparency: SurfaceStatus { state: "ok", note: "El compositor aplica transparencia." },
        ..Default::default()
    }
}

/// Estado de `windowPositioning` (issue #180, WU4): las ramas deciden SOLO
/// por el backend GDK efectivo, nunca por el tipo de sesión; el input de
/// compositor (`is_gnome`) solo refina la nota bajo Wayland.
pub fn window_positioning_status(display_backend: DisplayBackend, is_gnome: bool) -> SurfaceStatus {
    match display_backend {
        DisplayBackend::X11 => SurfaceStatus { state: "ok", note: "En X11 (y bajo XWayland con GDK_BACKEND=x11) el anclaje al borde y el arrastre con imán funcionan; la tira alcanza el borde del área de trabajo (#205)." },
        DisplayBackend::Wayland if is_gnome => SurfaceStatus { state: "limited", note: "Mutter no expone posicionamiento absoluto de ventanas (gtk_window_move no tiene efecto): el arrastre usa el gesto del compositor y, al soltar, no hay imán ni se persiste la posición." },
        DisplayBackend::Wayland => SurfaceStatus { state: "limited", note: "El posicionamiento absoluto de ventanas no está disponible bajo xdg-shell en Wayland: el arrastre de la tira se delega al compositor." },
    }
}

/// Estado de bandeja GNOME (issue #181, ajuste 1): el primario es el host.
/// #183 (revisión R1): la presencia del host prevalece independientemente de
/// la extensión concreta (otra implementación puede proveerlo); nunca se
/// acredita visibilidad del icono, solo disponibilidad del host.
fn gnome_tray_state(tray: TrayDiagnostics) -> &'static str {
    match tray.host {
        HostProbe::Present => "ok",
        _ => "limited",
    }
}

/// Nota de bandeja GNOME: matriz completa host × extensión (issue #181).
/// Sin host, nunca se recomienda reinstalar una extensión que ya existe; con
/// sondeo fallido, se declara desconocido en vez de inferir ausencia.
/// #183 (revisión R1): con host presente no se exige ni recomienda la
/// extensión concreta (otra implementación puede proveer el host); la nota
/// declara qué acredita la sonda por UUID, que solo reconoce la extensión
/// «AppIndicator» de Ubuntu.
fn gnome_tray_note(tray: TrayDiagnostics) -> &'static str {
    match (tray.host, tray.extension) {
        (HostProbe::Present, ExtensionProbe::Enabled) => {
            "Host StatusNotifier detectado en la sesión: hay dónde mostrar el icono. La extensión «AppIndicator» de Ubuntu está habilitada. Solo se acredita la disponibilidad del host, no la visibilidad del icono."
        }
        (HostProbe::Present, ExtensionProbe::Disabled) => {
            "Host StatusNotifier detectado en la sesión: hay dónde mostrar el icono. La extensión «AppIndicator» de Ubuntu está instalada pero deshabilitada; el host puede provener de otra implementación. Solo se acredita la disponibilidad del host, no la visibilidad del icono."
        }
        (HostProbe::Present, ExtensionProbe::Absent) => {
            "Host StatusNotifier detectado en la sesión: hay dónde mostrar el icono. La sonda de extensión solo reconoce la «AppIndicator» de Ubuntu y no la encontró: el host puede provener de otra implementación. Solo se acredita la disponibilidad del host, no la visibilidad del icono."
        }
        (HostProbe::Present, ExtensionProbe::Unknown) => {
            "Host StatusNotifier detectado en la sesión: hay dónde mostrar el icono. No se pudo determinar el estado de la extensión «AppIndicator» de Ubuntu: queda desconocido (sonda complementaria); el host puede provener de otra implementación. Solo se acredita la disponibilidad del host, no la visibilidad del icono."
        }
        (HostProbe::Absent, ExtensionProbe::Enabled) => {
            "No se detectó ningún host StatusNotifier en la sesión: no hay dónde mostrar el icono de bandeja. La extensión «AppIndicator» está habilitada, pero la barra activa no provee el host (¿el dock fue reemplazado?)."
        }
        (HostProbe::Absent, ExtensionProbe::Disabled) => {
            "No se detectó ningún host StatusNotifier en la sesión: no hay dónde mostrar el icono. La extensión «AppIndicator» está instalada pero deshabilitada: habilitala."
        }
        (HostProbe::Absent, ExtensionProbe::Absent) => {
            "No se detectó ningún host StatusNotifier en la sesión: no hay dónde mostrar el icono. Instalá la extensión «AppIndicator» de Ubuntu para proveerlo."
        }
        (HostProbe::Absent, ExtensionProbe::Unknown) => {
            "No se detectó ningún host StatusNotifier en la sesión: no hay dónde mostrar el icono. No se pudo determinar el estado de la extensión «AppIndicator»."
        }
        (HostProbe::Unknown, ExtensionProbe::Enabled) => {
            "No se pudo sondear el host StatusNotifier de la sesión (diagnóstico desconocido). La extensión «AppIndicator» está habilitada."
        }
        (HostProbe::Unknown, ExtensionProbe::Disabled) => {
            "No se pudo sondear el host StatusNotifier de la sesión (diagnóstico desconocido). La extensión «AppIndicator» está instalada pero deshabilitada: habilitala."
        }
        (HostProbe::Unknown, ExtensionProbe::Absent) => {
            "No se pudo sondear el host StatusNotifier de la sesión (diagnóstico desconocido). La extensión «AppIndicator» no está instalada."
        }
        (HostProbe::Unknown, ExtensionProbe::Unknown) => {
            "No se pudo sondear el host StatusNotifier ni el estado de la extensión «AppIndicator»: diagnóstico de bandeja desconocido."
        }
    }
}

/// Resultado de una sonda acotada (issue #181, ajuste 2 del mantenedor).
/// `Unknown` degrada honestamente: un fallo o timeout de sondeo **nunca** se
/// reporta como ausencia.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HostProbe {
    Present,
    Absent,
    #[default]
    Unknown,
}

/// Estado de la extensión AppIndicator de GNOME: info complementaria al
/// diagnóstico del host. Solo se acredita cuando se determina de forma
/// fiable (`Unknown` si no).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExtensionProbe {
    Enabled,
    Disabled,
    Absent,
    #[default]
    Unknown,
}

/// Diagnóstico de bandeja inyectable en `detect_wm_info_from_env` (issue
/// #181): el estado primario es del host `StatusNotifier`; la extensión es
/// complementaria. Puro: los tests fijan los valores sin D-Bus real.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TrayDiagnostics {
    pub host: HostProbe,
    pub extension: ExtensionProbe,
}

const STATUS_NOTIFIER_WATCHER: &str = "org.kde.StatusNotifierWatcher";
const APPINDICATOR_UUID: &str = "ubuntu-appindicators@ubuntu.com";

/// Timeout de las sondas de bandeja (issue #181, ajuste 2): acotado para no
/// colgar Ajustes; si excede o falla, la sonda degrada a `Unknown`.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(750);

/// Sonda acotada (issue #183, revisión R2): delega en el runner compartido
/// `cli_process::run_inherited_env`, que garantiza cota dura total sobre
/// spawn + espera + reap + drenaje (`timeout + 2 * DRAIN_GRACE`), captura
/// limitada por stream y terminación del árbol completo (grupo de procesos
/// propio), con reap del hijo tras la terminación. Devuelve stdout solo si
/// el proceso salió con código 0; cualquier fallo, salida con error o plazo
/// excedido degrada a `None` (diagnóstico desconocido), sin colgar Ajustes.
fn run_with_timeout(program: &str, args: &[&str], timeout: std::time::Duration) -> Option<String> {
    let output = crate::cli_process::run_inherited_env(program, args, timeout).ok()?;
    (output.code == 0).then_some(output.stdout)
}

/// Sonda del host `StatusNotifier`: lista los nombres del bus de sesión vía
/// `gdbus` y busca `org.kde.StatusNotifierWatcher`. Fallo/timeout → `Unknown`.
fn probe_status_notifier_host() -> HostProbe {
    let output = run_with_timeout(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.ListNames",
        ],
        PROBE_TIMEOUT,
    );
    parse_host_probe(output.as_deref())
}

/// Parseo puro del resultado de `ListNames` (`None` = sondeo fallido).
fn parse_host_probe(output: Option<&str>) -> HostProbe {
    match output {
        Some(out) if out.contains(STATUS_NOTIFIER_WATCHER) => HostProbe::Present,
        Some(_) => HostProbe::Absent,
        None => HostProbe::Unknown,
    }
}

/// Sonda de la extensión AppIndicator vía `gnome-extensions list` (UUIDs, uno
/// por línea: salida independiente del locale, a diferencia de `info`).
/// Habilitada si aparece en la lista de habilitadas; instalada pero
/// deshabilitada si aparece en la lista completa; binario ausente, fallo o
/// timeout → `Unknown` (nunca un error de diagnóstico se reporta como ausencia).
fn probe_appindicator_extension() -> ExtensionProbe {
    let enabled = run_with_timeout("gnome-extensions", &["list", "--enabled"], PROBE_TIMEOUT);
    if let Some(list) = enabled.as_deref() {
        if list.lines().any(|l| l.trim() == APPINDICATOR_UUID) {
            return ExtensionProbe::Enabled;
        }
    }
    let all = run_with_timeout("gnome-extensions", &["list"], PROBE_TIMEOUT);
    parse_extension_probe(enabled.as_deref(), all.as_deref())
}

/// Parseo puro de las listas de `gnome-extensions` (`None` = sondeo fallido).
fn parse_extension_probe(enabled: Option<&str>, all: Option<&str>) -> ExtensionProbe {
    match (enabled, all) {
        (Some(enabled), _) if enabled.lines().any(|l| l.trim() == APPINDICATOR_UUID) => {
            ExtensionProbe::Enabled
        }
        (Some(_), Some(all)) if all.lines().any(|l| l.trim() == APPINDICATOR_UUID) => {
            ExtensionProbe::Disabled
        }
        (Some(_), Some(_)) => ExtensionProbe::Absent,
        _ => ExtensionProbe::Unknown,
    }
}

/// Diagnóstico real de bandeja (solo se llama si la sesión es GNOME).
fn probe_tray_diagnostics() -> TrayDiagnostics {
    TrayDiagnostics {
        host: probe_status_notifier_host(),
        extension: probe_appindicator_extension(),
    }
}

/// ¿La sesión es GNOME? Mismo criterio que usa `detect_wm_info_from_env`
/// para elegir la rama de `surfaces_for`; extraído para que el wrapper real
/// decida si sondear la bandeja sin duplicar la lógica.
fn is_gnome_from_env(env: &Env) -> bool {
    let non_empty = |opt: &Option<String>| opt.clone().filter(|s| !s.is_empty());
    let desktop_session = non_empty(&env.desktop_session);
    let xdg_current_desktop = non_empty(&env.xdg_current_desktop);
    desktop_session
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("gnome"))
        .unwrap_or(false)
        || xdg_current_desktop
            .as_deref()
            .map(|s| s.split(':').any(|p| p.eq_ignore_ascii_case("GNOME")))
            .unwrap_or(false)
}

/// Wrapper que lee `std::env::var` y delega en `detect_wm_info_from_env`.
/// El command Tauri usa este; el frontend nunca lo llama directamente.
pub fn detect_wm_info() -> WindowManagerInfo {
    let env = Env::from_process();
    // Solo se sondea la bandeja en GNOME: es la única rama que consume el
    // diagnóstico. #183 (revisión R3): el trabajo bloqueante sale del hilo de
    // UI porque el command `get_wm_info` es async y delega en spawn_blocking;
    // un command Tauri síncrono no garantiza esa separación.
    let tray = if is_gnome_from_env(&env) {
        probe_tray_diagnostics()
    } else {
        TrayDiagnostics::default()
    };
    detect_wm_info_from_env(&env, tray)
}

/// ¿La sesión actual es Wayland? Misma semántica que `WindowManagerInfo::is_wayland`
/// (`WAYLAND_DISPLAY` set, `XDG_SESSION_TYPE=wayland`, token solo-Wayland en
/// `XDG_CURRENT_DESKTOP` o Hyprland) sin construir el resumen completo. Para
/// decisiones puntuales como los avisos de atajos bajo Wayland (issue #181).
pub fn is_wayland_session() -> bool {
    is_wayland_session_from_env(&Env::from_process())
}

/// Versión pura e inyectable de `is_wayland_session`: los tests la llaman
/// directamente sin tocar `std::env` global (thread-safe bajo `cargo test`).
pub fn is_wayland_session_from_env(env: &Env) -> bool {
    detect_wm_info_from_env(env, TrayDiagnostics::default()).is_wayland
}

/// Tokens de `XDG_CURRENT_DESKTOP` que solo existen bajo Wayland. GNOME/KDE
/// corren sobre X11 o Wayland, así que no pertenecen a esta lista.
fn is_wayland_only_session(token: &str) -> bool {
    matches!(
        token.trim().to_ascii_lowercase().as_str(),
        "wayland"
            | "hyprland"
            | "sway"
            | "wlroots"
            | "niri"
            | "river"
            | "wayfire"
            | "labwc"
            | "cosmic"
    )
}

/// Recomendación estática derivada del compositor detectado. Pura: el caller
/// la copia al JSON sin hacer formatting (es &'static str). `is_kde` se recibe
/// del mismo cálculo que `surfaces_for` (única fuente de verdad; no duplicar
/// aquí el match de `desktop_session`).
fn recommendation(
    is_wayland: bool,
    is_hyprland: bool,
    is_kde: bool,
    desktop_session: Option<&str>,
    _xdg_current_desktop: Option<&str>,
) -> &'static str {
    if is_hyprland {
        "Hyprland es particularmente estricto con always-on-top. \
         Si la tira se ve normal pero se oculta tras otras ventanas, \
         activa «Auto-hide» en Ajustes como Plan B."
    } else if is_wayland {
        match (desktop_session, is_kde) {
            (Some(d), _) if d.eq_ignore_ascii_case("gnome") => {
                "GNOME Wayland (Mutter) puede ignorar hints de always-on-top en \
                 algunos escenarios. La tira recurre a posición fija + skip_taskbar."
            }
            (_, true) => {
                "KDE Wayland suele respetar always-on-top; click-through puede \
                 fallar — usa la posición fija como fallback."
            }
            _ => {
                "Wayland detectado. Si siempre-encima o clic-a-través fallan, \
                 activa «Auto-hide» en Ajustes."
            }
        }
    } else {
        "X11 (u otro). Compatibilidad completa con always-on-top y click-through."
    }
}

/// Tauri command expuesto al frontend (`invoke('get_wm_info')`).
/// #183 (revisión R3): async con `spawn_blocking` — las sondas acotadas
/// (spawn + espera + drenaje, hasta ~2,25 s nominales) corren en el pool de
/// tareas bloqueantes y nunca en el hilo de UI; los commands Tauri síncronos
/// NO garantizan sacar el trabajo del hilo principal.
///
/// Issue #180 (revisión del mantenedor, una sola detección del backend GDK):
/// la sonda runtime del backend GDK efectivo es la de `widget_placement`
/// (`display_backend_on_ui`, hilo de UI + caché `OnceLock` compartida con
/// `transport()`); aquí solo la consumimos. Cuando resuelve manda sobre el
/// fallback por env; si no (`Unknown`, sin display, o el hilo de UI no
/// responde a tiempo), decide `display_backend_from_env`. Sólo Linux tiene
/// sonda: las sondas de bandeja viven igualmente fuera del hilo de UI.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn get_wm_info(window: tauri::WebviewWindow) -> WindowManagerInfo {
    let mut info = tauri::async_runtime::spawn_blocking(detect_wm_info)
        .await
        .expect("la tarea de sondeo no debe fallar antes del cierre de la app");
    if let Some(backend) = crate::widget_placement::display_backend_on_ui(&window).await {
        info = with_display_backend(info, backend);
    }
    info
}

/// Non-Linux: command equal to the pre-#180 one; no probe exists and the
/// env fallback (`display_backend_from_env`, baked into `detect_wm_info`)
/// decides.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn get_wm_info() -> WindowManagerInfo {
    tauri::async_runtime::spawn_blocking(detect_wm_info)
        .await
        .expect("la tarea de sondeo no debe fallar antes del cierre de la app")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(
        wayland_display: Option<&str>,
        xdg_session_type: Option<&str>,
        desktop_session: Option<&str>,
        xdg_current_desktop: Option<&str>,
    ) -> Env {
        Env {
            wayland_display: wayland_display.map(str::to_string),
            xdg_session_type: xdg_session_type.map(str::to_string),
            desktop_session: desktop_session.map(str::to_string),
            xdg_current_desktop: xdg_current_desktop.map(str::to_string),
            gdk_backend: None,
        }
    }

    /// Diagnóstico de bandeja por defecto para tests que no lo consumen
    /// (ramas X11/Hyprland/KDE/Wayland genérico): host y extensión desconocidos.
    fn tray() -> TrayDiagnostics {
        TrayDiagnostics::default()
    }

    #[test]
    fn empty_env_returns_no_wayland() {
        let info = detect_wm_info_from_env(&env(None, None, None, None), tray());
        assert_eq!(info.wayland_display, None);
        assert!(!info.is_wayland);
        assert!(!info.is_hyprland);
        assert!(info.recommendation.contains("X11") || info.recommendation.contains("completa"));
    }

    #[test]
    fn wayland_display_signals_wayland() {
        let info = detect_wm_info_from_env(&env(Some("wayland-0"), None, None, None), tray());
        assert!(info.is_wayland);
        assert_eq!(info.wayland_display.as_deref(), Some("wayland-0"));
        assert!(info.recommendation.contains("Wayland"));
    }

    #[test]
    fn xdg_session_type_wayland_signals_wayland() {
        let info = detect_wm_info_from_env(&env(None, Some("wayland"), None, None), tray());
        assert!(info.is_wayland);
        assert!(!info.is_hyprland);
    }

    #[test]
    fn xdg_current_desktop_hyprland_signals_hyprland() {
        let info = detect_wm_info_from_env(&env(None, None, None, Some("Hyprland")), tray());
        assert!(info.is_hyprland);
        // Hyprland es compositor Wayland-only, así que esperarse `is_wayland=true`.
        assert!(info.is_wayland);
        assert!(info.recommendation.contains("Hyprland"));
    }

    #[test]
    fn desktop_session_hyprland_signals_hyprland() {
        // Solo DESKTOP_SESSION=hyprland sin XDG_SESSION_TYPE ni XDG_CURRENT_DESKTOP.
        // Hyprland es un compositor Wayland-only, por lo que el usuario está
        // en Wayland y `surfaces_for` debe tomar la rama Hyprland (no la X11).
        let info = detect_wm_info_from_env(&env(None, None, Some("hyprland"), None), tray());
        assert!(info.is_hyprland, "is_hyprland debe ser true");
        assert!(
            info.is_wayland,
            "is_wayland debe ser true: Hyprland es solo-Wayland"
        );
        // Las superficies deben ser las de Hyprland: bandeja y always-on-top con `limited`.
        assert_eq!(
            info.surfaces.always_on_top.state, "limited",
            "always_on_top limited en Hyprland"
        );
        assert_eq!(
            info.surfaces.tray_icon.state, "limited",
            "tray_icon limited en Hyprland"
        );
        assert!(
            info.surfaces
                .tray_icon
                .note
                .contains("vuelve a abrir Quorb"),
            "nota de tray en Hyprland"
        );
        assert_eq!(
            info.surfaces.click_through.state, "limited",
            "click_through limited en Hyprland"
        );
        assert_eq!(info.surfaces.global_shortcuts.state, "limited");
        assert_eq!(info.surfaces.autostart.state, "ok");
    }

    #[test]
    fn empty_strings_are_treated_as_absent() {
        let info = detect_wm_info_from_env(&env(Some(""), Some(""), None, None), tray());
        assert_eq!(info.wayland_display, None);
        assert_eq!(info.xdg_session_type, None);
        assert!(!info.is_wayland);
    }

    /// #181: la detección de sesión Wayland para los avisos de atajos delega en
    /// la misma semántica que `WindowManagerInfo::is_wayland` (WAYLAND_DISPLAY
    /// set, XDG_SESSION_TYPE=wayland, token solo-Wayland o Hyprland), sin
    /// tocar `std::env` global.
    #[test]
    fn is_wayland_session_from_env_follows_wm_info_semantics() {
        // Protocolo Wayland explícito.
        assert!(is_wayland_session_from_env(&env(
            Some("wayland-0"),
            None,
            None,
            None
        )));
        assert!(is_wayland_session_from_env(&env(
            None,
            Some("wayland"),
            None,
            None
        )));
        // Compositor solo-Wayland en XDG_CURRENT_DESKTOP.
        assert!(is_wayland_session_from_env(&env(
            None,
            None,
            None,
            Some("sway")
        )));
        // Hyprland es Wayland-only incluso sin más señales.
        assert!(is_wayland_session_from_env(&env(
            None,
            None,
            Some("hyprland"),
            None
        )));
    }

    #[test]
    fn is_wayland_session_from_env_rejects_x11_and_empty_strings() {
        // X11 explícito: no es Wayland aunque el escritorio sea GNOME/KDE.
        assert!(!is_wayland_session_from_env(&env(
            None,
            Some("x11"),
            Some("gnome"),
            Some("GNOME")
        )));
        assert!(!is_wayland_session_from_env(&env(
            None,
            Some("x11"),
            Some("plasma"),
            Some("KDE")
        )));
        // Env vacío o strings vacíos: nada señalado.
        assert!(!is_wayland_session_from_env(&env(None, None, None, None)));
        assert!(!is_wayland_session_from_env(&env(
            Some(""),
            Some(""),
            Some(""),
            Some("")
        )));
    }

    #[test]
    fn xdg_current_desktop_can_combine_desktop_sessions() {
        // `XDG_CURRENT_DESKTOP:GNOME:Hyprland` debe reconocer Hyprland en la lista.
        let info = detect_wm_info_from_env(&env(None, None, None, Some("GNOME:Hyprland")), tray());
        assert!(info.is_hyprland);
        assert!(info.is_wayland);
    }

    #[test]
    fn xdg_current_desktop_minor_compositors_signal_wayland() {
        for token in ["niri", "river", "wayfire"] {
            let info = detect_wm_info_from_env(&env(None, None, None, Some(token)), tray());
            assert!(info.is_wayland, "{token} debe señalar Wayland");
            assert!(!info.is_hyprland, "{token} no es Hyprland");
        }
    }

    #[test]
    fn gnome_xorg_is_not_wayland() {
        let info = detect_wm_info_from_env(
            &env(None, Some("x11"), Some("gnome"), Some("GNOME")),
            tray(),
        );
        assert!(!info.is_wayland, "GNOME sobre Xorg no es Wayland");
        assert!(
            info.recommendation.contains("completa"),
            "recomendación X11"
        );
        // Sesión X11: superficies completas esperadas (salvo click_through:
        // el widget no implementa click-through hoy — solo el overlay de efectos).
        let surfaces: Vec<(&'static str, SurfaceStatus)> = info.surfaces.into_iter();
        for (name, status) in surfaces.iter() {
            if *name == "click_through" {
                assert_eq!(
                    status.state, "limited",
                    "click_through debe ser limited hasta implementar el widget"
                );
                continue;
            }
            assert_eq!(status.state, "ok", "{name} debería estar ok en X11");
        }
    }

    #[test]
    fn plasma_x11_is_not_wayland() {
        let info = detect_wm_info_from_env(
            &env(None, Some("x11"), Some("plasma"), Some("KDE:plasma")),
            tray(),
        );
        assert!(!info.is_wayland, "Plasma sobre X11 no es Wayland");
        assert_eq!(
            info.surfaces.global_shortcuts.state, "ok",
            "atajos completos en X11"
        );
    }

    #[test]
    fn recommendation_for_gnome_wayland_mentions_mutter() {
        let info =
            detect_wm_info_from_env(&env(None, Some("wayland"), Some("gnome"), None), tray());
        assert!(info.recommendation.contains("GNOME Wayland"));
        assert!(info.recommendation.contains("Mutter"));
    }

    #[test]
    fn x11_surfaces_are_all_expected_complete() {
        let surfaces: Vec<(&'static str, SurfaceStatus)> = detect_wm_info_from_env(
            &env(None, Some("x11"), Some("gnome-xorg-errors"), None),
            tray(),
        )
        .surfaces
        .into_iter();
        for (name, status) in surfaces.iter() {
            // Click-through del widget es `limited` en todas las sesiones hoy:
            // solo el overlay de efectos llama set_ignore_cursor_events, no la tira.
            if *name == "click_through" {
                assert_eq!(
                    status.state, "limited",
                    "click_through debe ser limited hasta implementar el widget"
                );
                continue;
            }
            assert_eq!(status.state, "ok", "{name} debería estar ok en X11");
        }
        // Nota honesta sobre composición (la tira es transparente).
        let transparency = surfaces
            .iter()
            .find(|(n, _)| *n == "transparency")
            .map(|(_, s)| s)
            .unwrap();
        assert!(transparency.note.contains("composición"));
    }

    #[test]
    fn gnome_wayland_limits_tray_click_through_and_shortcuts() {
        // Caso del reporte de #181: extensión ausente y sin host → el consejo
        // es instalar la extensión (que realmente falta).
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics {
                host: HostProbe::Absent,
                extension: ExtensionProbe::Absent,
            },
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "limited");
        assert!(
            s.tray_icon.note.contains("no hay dónde mostrar el icono"),
            "debe explicar la causa real: {}",
            s.tray_icon.note
        );
        assert!(
            s.tray_icon
                .note
                .contains("Instalá la extensión «AppIndicator»"),
            "con extensión ausente, el consejo es instalarla: {}",
            s.tray_icon.note
        );
        assert_eq!(s.click_through.state, "limited");
        assert_eq!(s.global_shortcuts.state, "limited");
        assert_eq!(s.always_on_top.state, "limited");
        assert_eq!(s.autostart.state, "ok");
        assert_eq!(s.notifications.state, "ok");
    }

    /// #181 (ajuste 1): el caso exacto del reporte — extensión instalada
    /// (habilitada) pero sin host StatusNotifier: el consejo NO puede ser
    /// reinstalar lo que ya está instalado; informa la causa real.
    #[test]
    fn gnome_wayland_without_host_and_extension_enabled_reports_the_host_cause() {
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics {
                host: HostProbe::Absent,
                extension: ExtensionProbe::Enabled,
            },
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "limited");
        assert!(s
            .tray_icon
            .note
            .contains("No se detectó ningún host StatusNotifier"));
        assert!(s.tray_icon.note.contains("está habilitada"));
        assert!(
            !s.tray_icon.note.contains("Instalá"),
            "nunca recomienda reinstalar lo que existe: {}",
            s.tray_icon.note
        );
    }

    /// #181 (ajuste 1): con host presente solo se acredita disponibilidad, no
    /// visibilidad del icono.
    #[test]
    fn gnome_wayland_with_host_present_only_claims_host_availability() {
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics {
                host: HostProbe::Present,
                extension: ExtensionProbe::Enabled,
            },
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "ok");
        assert!(s.tray_icon.note.contains("Host StatusNotifier detectado"));
        assert!(
            !s.tray_icon.note.contains("se muestra"),
            "no afirma visibilidad del icono: {}",
            s.tray_icon.note
        );
    }

    /// #181 (ajuste 2): fallo/timeout del sondeo → «desconocido», nunca
    /// ausencia, y sin consejos contradictorios.
    #[test]
    fn gnome_wayland_failed_probe_degrades_to_unknown() {
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics::default(),
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "limited");
        assert!(s.tray_icon.note.contains("desconocido"));
        assert!(
            !s.tray_icon.note.contains("No se detectó ningún host"),
            "un sondeo fallido no se reporta como ausencia: {}",
            s.tray_icon.note
        );
    }

    /// #181: extensión instalada pero deshabilitada (sin host): el consejo es
    /// habilitar, no instalar.
    #[test]
    fn gnome_wayland_disabled_extension_advises_enabling() {
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics {
                host: HostProbe::Absent,
                extension: ExtensionProbe::Disabled,
            },
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "limited");
        assert!(s.tray_icon.note.contains("deshabilitada"));
        assert!(s.tray_icon.note.contains("habilitala"));
        assert!(!s.tray_icon.note.contains("Instalá"));
    }

    /// #183 (revisión R1): con host StatusNotifier presente, la presencia del
    /// host prevalece y la extensión concreta NO puede ser requisito:
    /// otra implementación puede estar proveyéndolo. Sin consejos de
    /// habilitar ni instalar, y sin atribuir la ausencia del icono a la
    /// extensión.
    #[test]
    fn gnome_wayland_host_present_extension_disabled_never_advises_enabling() {
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics {
                host: HostProbe::Present,
                extension: ExtensionProbe::Disabled,
            },
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "ok");
        assert!(s.tray_icon.note.contains("Host StatusNotifier detectado"));
        assert!(s.tray_icon.note.contains("deshabilitada"));
        assert!(
            !s.tray_icon.note.contains("habilitala") && !s.tray_icon.note.contains("Instalá"),
            "con host presente no se recomienda actuar sobre la extensión: {}",
            s.tray_icon.note
        );
    }

    /// #183 (revisión R1): con host presente y extensión «no instalada», la
    /// nota describe exactamente qué acredita la sonda por UUID (solo la
    /// extensión de Ubuntu) sin afirmar que GNOME no muestra el icono.
    #[test]
    fn gnome_wayland_host_present_extension_absent_reports_probe_scope() {
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics {
                host: HostProbe::Present,
                extension: ExtensionProbe::Absent,
            },
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "ok");
        assert!(s.tray_icon.note.contains("Host StatusNotifier detectado"));
        assert!(
            !s.tray_icon.note.contains("sin ella"),
            "no atribuye la visibilidad a la extensión concreta: {}",
            s.tray_icon.note
        );
        assert!(
            !s.tray_icon.note.contains("Instalá") && !s.tray_icon.note.contains("habilitala"),
            "con host presente no se recomienda instalar la extensión: {}",
            s.tray_icon.note
        );
        assert!(
            s.tray_icon.note.contains("otra implementación"),
            "declara que el host puede provener de otra implementación: {}",
            s.tray_icon.note
        );
    }

    /// #183 (revisión R1): con host presente y sonda de extensión fallida,
    /// el host sigue prevaleciendo; la extensión queda como desconocida sin
    /// consejos contradictorios.
    #[test]
    fn gnome_wayland_host_present_extension_unknown_still_claims_host() {
        let s = detect_wm_info_from_env(
            &env(Some("wayland-0"), Some("wayland"), Some("gnome"), None),
            TrayDiagnostics {
                host: HostProbe::Present,
                extension: ExtensionProbe::Unknown,
            },
        )
        .surfaces;
        assert_eq!(s.tray_icon.state, "ok");
        assert!(s.tray_icon.note.contains("Host StatusNotifier detectado"));
        assert!(s.tray_icon.note.contains("desconocido"));
        assert!(
            !s.tray_icon.note.contains("Instalá") && !s.tray_icon.note.contains("habilitala"),
            "sin consejos contradictorios: {}",
            s.tray_icon.note
        );
    }

    /// #181: parseo puro de las sondas (matriz del ajuste 2), sin procesos.
    #[test]
    fn host_probe_parse_covers_success_absence_and_failure() {
        assert_eq!(
            parse_host_probe(Some("(['org.kde.StatusNotifierWatcher', 'a'])")),
            HostProbe::Present
        );
        assert_eq!(
            parse_host_probe(Some("(['otro.nicho'])")),
            HostProbe::Absent
        );
        assert_eq!(
            parse_host_probe(None),
            HostProbe::Unknown,
            "fallo/timeout → desconocido"
        );
    }

    #[test]
    fn extension_probe_parse_covers_enabled_disabled_absent_and_unknown() {
        assert_eq!(
            parse_extension_probe(Some("a@x\nubuntu-appindicators@ubuntu.com"), None),
            ExtensionProbe::Enabled
        );
        assert_eq!(
            parse_extension_probe(Some("a@x"), Some("ubuntu-appindicators@ubuntu.com")),
            ExtensionProbe::Disabled
        );
        assert_eq!(
            parse_extension_probe(Some("a@x"), Some("b@y")),
            ExtensionProbe::Absent
        );
        assert_eq!(
            parse_extension_probe(None, None),
            ExtensionProbe::Unknown,
            "fallo → desconocido, no ausente"
        );
        assert_eq!(
            parse_extension_probe(None, Some("b@y")),
            ExtensionProbe::Unknown
        );
    }
    /// #183 (revisión R2): el runner debe acotar la captura: una salida mayor
    /// que MAX_CAPTURE_BYTES se captura acotada y la sonda termina en cota.
    #[test]
    #[cfg(unix)]
    fn run_with_timeout_caps_large_output() {
        use crate::cli_process;
        let started = std::time::Instant::now();
        let out = run_with_timeout(
            "/bin/sh",
            &["-c", "yes | head -c 262144"],
            std::time::Duration::from_secs(5),
        );
        assert!(out.is_some(), "la sonda debe completar en cota");
        assert!(!out.as_ref().unwrap().is_empty());
        assert!(
            out.as_ref().unwrap().len() <= cli_process::MAX_CAPTURE_BYTES,
            "captura acotada, no se lee sin límite: {} bytes",
            out.as_ref().unwrap().len()
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    /// #183 (revisión R2): un descendiente que retiene stdout no puede colgar
    /// la sonda: el runner termina el árbol completo y drena acotado.
    #[test]
    #[cfg(unix)]
    fn run_with_timeout_descendant_retaining_stdout_does_not_hang() {
        let started = std::time::Instant::now();
        let out = run_with_timeout(
            "/bin/sh",
            &["-c", "printf 'ok\\n'; (sleep 30) &"],
            std::time::Duration::from_secs(1),
        );
        assert_eq!(
            out.as_deref(),
            Some("ok\n"),
            "stdout del hijo directo: {:?}",
            out
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "no debe esperar al nieto (30 s): {:?}",
            started.elapsed()
        );
    }

    /// #183 (revisión R2): un proceso que excede el plazo se mata, se recoge
    /// con wait y la sonda degrada a `None` dentro de la cota, sin colgar.
    #[test]
    #[cfg(unix)]
    fn run_with_timeout_overrun_degrades_to_none_within_bound() {
        let started = std::time::Instant::now();
        let out = run_with_timeout(
            "/bin/sh",
            &["-c", "sleep 30"],
            std::time::Duration::from_millis(500),
        );
        assert!(out.is_none(), "plazo excedido → None");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    /// Smoke real (issue #181, verificación exigida en la aprobación):
    /// requiere sesión de escritorio Linux con D-Bus y `gdbus`/`gnome-extensions`
    /// disponibles. Correr manualmente: `cargo test --lib -- --ignored --nocapture`.
    /// Ejercita `detect_wm_info()` completo con sondas reales acotadas por timeout.
    #[test]
    #[ignore = "requiere sesión de escritorio Linux con D-Bus y herramientas de sondeo"]
    fn real_session_tray_diagnostics_smoke() {
        let info = detect_wm_info();
        println!(
            "sesión: wayland={:?} desktop={:?} current={:?}",
            info.xdg_session_type, info.desktop_session, info.xdg_current_desktop
        );
        println!(
            "tray: state={:?} note={:?}",
            info.surfaces.tray_icon.state, info.surfaces.tray_icon.note
        );
        // Contrato mínimo aunque el sondeo falle: la nota nunca queda vacía y
        // siempre nombra qué se diagnosticó (host o desconocido honesto).
        assert!(!info.surfaces.tray_icon.note.is_empty());
    }

    #[test]
    fn kde_wayland_is_less_limited_than_gnome() {
        let s = detect_wm_info_from_env(&env(None, Some("wayland"), Some("plasma"), None), tray())
            .surfaces;
        assert_eq!(s.tray_icon.state, "ok");
        assert_eq!(s.always_on_top.state, "ok");
        assert_eq!(s.global_shortcuts.state, "limited");
    }

    #[test]
    fn hyprland_limits_always_on_top_and_tray() {
        let s =
            detect_wm_info_from_env(&env(None, Some("wayland"), Some("hyprland"), None), tray())
                .surfaces;
        assert_eq!(s.always_on_top.state, "limited");
        assert_eq!(s.tray_icon.state, "limited");
        assert!(s.tray_icon.note.contains("vuelve a abrir Quorb"));
        assert_eq!(s.autostart.state, "ok");
    }

    #[test]
    fn generic_wayland_is_prudent_with_limits() {
        let s = detect_wm_info_from_env(&env(Some("wayland-1"), None, Some("sway"), None), tray())
            .surfaces;
        assert_eq!(s.tray_icon.state, "limited");
        assert_eq!(s.always_on_top.state, "limited");
        assert_eq!(s.global_shortcuts.state, "limited");
    }

    impl DesktopSurfaces {
        /// Iteración (nombre, estado) en orden fijo para asserts legibles.
        fn into_iter(self) -> Vec<(&'static str, SurfaceStatus)> {
            let d = self;
            vec![
                ("always_on_top", d.always_on_top),
                ("click_through", d.click_through),
                ("tray_icon", d.tray_icon),
                ("global_shortcuts", d.global_shortcuts),
                ("autostart", d.autostart),
                ("notifications", d.notifications),
                ("transparency", d.transparency),
                ("window_positioning", d.window_positioning),
            ]
        }
    }

    /// Full Wayland session (GNOME) as the deterministic backdrop for the
    /// GDK-backend cases: WAYLAND_DISPLAY set, XDG_SESSION_TYPE=wayland,
    /// XDG_CURRENT_DESKTOP=GNOME:GNOME.
    fn wayland_session_env() -> Env {
        env(
            Some("wayland-0"),
            Some("wayland"),
            Some("gnome"),
            Some("GNOME:GNOME"),
        )
    }

    /// #180 (WU4): the display backend is decided by the EFFECTIVE GDK backend,
    /// never by the session type.
    #[test]
    fn display_backend_gdk_x11_wins_on_wayland_session() {
        let env = Env {
            gdk_backend: Some("x11".to_string()),
            ..wayland_session_env()
        };
        assert_eq!(display_backend_from_env(&env), DisplayBackend::X11);
    }

    #[test]
    fn display_backend_unset_defaults_to_session_wayland() {
        assert_eq!(
            display_backend_from_env(&wayland_session_env()),
            DisplayBackend::Wayland
        );
    }

    #[test]
    fn display_backend_gdk_list_wayland_first_wins() {
        let env = Env {
            gdk_backend: Some("wayland,x11".to_string()),
            ..wayland_session_env()
        };
        assert_eq!(display_backend_from_env(&env), DisplayBackend::Wayland);
    }

    #[test]
    fn display_backend_gdk_wildcard_is_not_decisive() {
        let env = Env {
            gdk_backend: Some("*".to_string()),
            ..wayland_session_env()
        };
        assert_eq!(display_backend_from_env(&env), DisplayBackend::Wayland);
    }

    #[test]
    fn display_backend_gdk_x11_with_wildcard_is_decisive() {
        let env = Env {
            gdk_backend: Some("x11,*".to_string()),
            ..wayland_session_env()
        };
        assert_eq!(display_backend_from_env(&env), DisplayBackend::X11);
    }

    /// #180: serde contract (WU5 mirror): camelCase keys and lowercase
    /// display-backend variants are what the frontend will consume.
    #[test]
    fn serde_output_uses_display_backend_and_window_positioning_keys() {
        let info = detect_wm_info_from_env(&wayland_session_env(), tray());
        let json = serde_json::to_value(&info).expect("serializable");
        assert_eq!(json["displayBackend"], "wayland");
        assert_eq!(json["surfaces"]["windowPositioning"]["state"], "limited");

        let overridden = with_display_backend(info, DisplayBackend::X11);
        let json = serde_json::to_value(&overridden).expect("serializable");
        assert_eq!(json["displayBackend"], "x11");
        assert_eq!(json["surfaces"]["windowPositioning"]["state"], "ok");
    }

    #[test]
    fn display_backend_x11_session_defaults_to_x11() {
        // Generic X11 session with GDK_BACKEND unset: no Wayland evidence → X11.
        let env = env(None, Some("x11"), Some("gnome"), Some("GNOME"));
        assert_eq!(display_backend_from_env(&env), DisplayBackend::X11);
    }

    /// #180 (WU4): the surface status branches ONLY on the display backend.
    #[test]
    fn window_positioning_status_x11_is_ok() {
        let s = window_positioning_status(DisplayBackend::X11, true);
        assert_eq!(s.state, "ok");
        assert!(s.note.contains("XWayland"), "{}", s.note);
        let s_nongnome = window_positioning_status(DisplayBackend::X11, false);
        assert_eq!(s_nongnome.state, "ok");
    }

    #[test]
    fn window_positioning_status_gnome_wayland_is_limited_with_mutter_note() {
        let s = window_positioning_status(DisplayBackend::Wayland, true);
        assert_eq!(s.state, "limited");
        assert!(s.note.contains("Mutter"), "{}", s.note);
    }

    #[test]
    fn window_positioning_status_other_wayland_is_limited_generic() {
        let s = window_positioning_status(DisplayBackend::Wayland, false);
        assert_eq!(s.state, "limited");
        assert!(s.note.contains("xdg-shell"), "{}", s.note);
        assert!(!s.note.contains("Mutter"), "{}", s.note);
    }

    /// #180 (WU4 integration): a Wayland session with GDK_BACKEND=x11 reports
    /// `ok` for windowPositioning (the maintainer-requested XWayland case).
    #[test]
    fn wayland_session_with_gdk_x11_gets_window_positioning_ok() {
        let env = Env {
            gdk_backend: Some("x11".to_string()),
            ..wayland_session_env()
        };
        let info = detect_wm_info_from_env(&env, tray());
        assert_eq!(info.display_backend, DisplayBackend::X11);
        assert_eq!(info.surfaces.window_positioning.state, "ok");
    }

    /// #180 (WU4): the runtime probe override rewrites display_backend and
    /// recomputes ONLY windowPositioning; every other surface stays intact.
    #[test]
    fn with_display_backend_overrides_backend_and_window_positioning_only() {
        let info = detect_wm_info_from_env(&wayland_session_env(), tray());
        assert_eq!(info.display_backend, DisplayBackend::Wayland);
        assert_eq!(info.surfaces.window_positioning.state, "limited");

        let overridden = with_display_backend(info.clone(), DisplayBackend::X11);
        assert_eq!(overridden.display_backend, DisplayBackend::X11);
        assert_eq!(overridden.surfaces.window_positioning.state, "ok");
        assert_eq!(overridden.surfaces.tray_icon, info.surfaces.tray_icon);
        assert_eq!(
            overridden.surfaces.always_on_top,
            info.surfaces.always_on_top
        );
        assert_eq!(
            overridden.surfaces.click_through,
            info.surfaces.click_through
        );
        assert_eq!(
            overridden.surfaces.global_shortcuts,
            info.surfaces.global_shortcuts
        );
        assert_eq!(overridden.surfaces.autostart, info.surfaces.autostart);
        assert_eq!(
            overridden.surfaces.notifications,
            info.surfaces.notifications
        );
        assert_eq!(overridden.surfaces.transparency, info.surfaces.transparency);
        assert_eq!(overridden.is_wayland, info.is_wayland);
    }
}
