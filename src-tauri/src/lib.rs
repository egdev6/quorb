mod channel;
mod cli_process;
mod codex_setup;
mod config;
mod config_transaction;
mod history;
mod login;
mod model;
mod providers;
mod secrets;
mod uninstall;
mod wm_compat;

use config::AppConfig;
use model::UsageReport;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const WIDGET: &str = "widget";
const SETTINGS: &str = "settings";
/// Escala de la ventana de Ajustes (1.0 = 100 %).
const SETTINGS_ZOOM: f64 = 0.85;
/// Alto inicial de Ajustes (px lógicos): Proveedores entero sin scroll a escala 85 %.
const SETTINGS_HEIGHT: f64 = 920.0;
const OVERLAY: &str = "overlay";
const DETAIL: &str = "detail";
const TRAY_ID: &str = "main";

/// Atajos registrados → acción, y errores del último registro (para Ajustes).
#[derive(Default)]
struct Shortcuts {
    map: Mutex<Vec<(Shortcut, &'static str)>>,
    errors: Mutex<Vec<String>>,
}

/// (Re)registra los atajos globales según la config.
fn apply_shortcuts(app: &AppHandle, cfg: &config::ShortcutsConfig) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = vec![];
    let mut errors = vec![];
    if cfg.enabled {
        for (action, label, text) in [
            ("toggle", "Mostrar / ocultar", &cfg.toggle),
            ("open_peak", "Abrir el más cargado", &cfg.open_peak),
            ("refresh", "Actualizar", &cfg.refresh),
        ] {
            if text.is_empty() {
                continue;
            }
            match text.parse::<Shortcut>() {
                Ok(sc) => match gs.register(sc) {
                    Ok(()) => map.push((sc, action)),
                    Err(e) => errors.push(format!("{label} ({text}): no se pudo registrar, ¿lo usa otra app? ({e})")),
                },
                Err(e) => errors.push(format!("{label} ({text}): combinación no válida ({e})")),
            }
        }
    }
    if let Some(state) = app.try_state::<Shortcuts>() {
        *state.map.lock().unwrap() = map;
        *state.errors.lock().unwrap() = errors;
    }
}

fn on_shortcut(app: &AppHandle, action: &str) {
    match action {
        "toggle" => toggle_widget(app),
        "open_peak" => {
            if let Some(w) = app.get_webview_window(WIDGET) {
                let _ = w.show();
            }
            let _ = app.emit_to(WIDGET, "open-peak", ());
        }
        "refresh" => {
            let _ = app.emit("refresh-now", ());
        }
        _ => {}
    }
}

#[tauri::command]
fn shortcut_errors(state: State<'_, Shortcuts>) -> Vec<String> {
    state.errors.lock().unwrap().clone()
}

struct AppState {
    config: Mutex<AppConfig>,
    config_path: PathBuf,
    http: reqwest::Client,
    history: history::History,
    /// Single-flight para aperturas de login CLI en curso. Protege contra
    /// doble clic en «Iniciar sesión» (HealthStep/CliConnect) y contra reenvíos
    /// duplicados: mientras un `provider` esté en este set, una segunda llamada
    /// a `open_login` con el mismo id devuelve `Err` sin abrir una segunda terminal.
    login_in_flight: Mutex<std::collections::HashSet<String>>,
}

/// Resultado de un patch atómico. `native_error` describe un efecto nativo que
/// falló **después** de persistir la config: estado parcial recuperable, nunca
/// un éxito total ni un rollback prometido.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ConfigPatchOutcome {
    config: AppConfig,
    native_error: Option<String>,
}

/// ¿El patch pide re-aplicar el efecto nativo de «siempre encima»? Decide por
/// **presencia del campo**, no por cambio de valor: un reintento debe re-aplicar
/// aunque la config ya tuviera el mismo valor (la persistencia pudo pasar y el
/// efecto nativo fallar).
fn patch_touches_always_on_top(patch: &config::WidgetPatch) -> bool {
    patch.always_on_top.is_some()
}

/// Aplica «siempre encima» al widget y al detalle. Devuelve el **primer** error
/// legible en vez de descartarlo: el fallo nativo es visible y recuperable.
fn apply_always_on_top(app: &AppHandle, value: bool) -> Option<String> {
    let mut error = None;
    for label in [WIDGET, DETAIL] {
        if let Some(w) = app.get_webview_window(label) {
            if let Err(e) = w.set_always_on_top(value) {
                if error.is_none() {
                    error = Some(always_on_top_error(&e.to_string()));
                }
            }
        }
    }
    error
}

fn always_on_top_error(detail: &str) -> String {
    format!("No se pudo aplicar «siempre encima»: {detail}")
}

// ───────────────────────── comandos ─────────────────────────

#[tauri::command]
fn updater_mode() -> &'static str {
    if cfg!(target_os = "macos") { "manual" } else { "native" }
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

/// Sustituye la config bajo el lock y la persiste en el mismo paso, para que
/// `save_config` y `patch_config` no se pisen a medias (merge atómico).
/// Devuelve (anterior, nueva). La invalidación de credenciales y la publicación
/// comparten el lock; los efectos de UI se aplican después de soltarlo.
fn update_config(
    state: &AppState,
    mutate: impl FnOnce(&mut AppConfig),
) -> Result<(AppConfig, AppConfig), String> {
    config_transaction::update(
        &state.config,
        |current| {
            let mut next = current.clone();
            mutate(&mut next);
            next.sanitized()
        },
        |old, next| {
            invalidate_nine_router_before_destination_publish(
                &old.nine_router.base_url,
                &next.nine_router.base_url,
                forget_nine_router_secrets,
            ).map(|_| ())
        },
        |next| config::save(&state.config_path, next),
    )
}

#[tauri::command]
fn save_config(app: AppHandle, state: State<'_, AppState>, config: AppConfig) -> Result<AppConfig, String> {
    let (old, config) = update_config(&state, |current| *current = config)?;
    // La invalidación de 9Router ya ocurrió dentro de la transacción de config.
    // Las cuentas eliminadas se llevan sus secretos del almacén del sistema.
    for gone in old.accounts.iter().filter(|a| !config.accounts.iter().any(|b| b.id == a.id)) {
        secrets::forget_account(gone);
    }
    let old_shortcuts = old.shortcuts;
    if old_shortcuts != config.shortcuts {
        apply_shortcuts(&app, &config.shortcuts);
    }
    // Contrato legacy de `save_config`: mantiene el efecto nativo de siempre encima.
    // El resultado del patch vivo (`patch_config`) es el que reporta el fallo.
    let _ = apply_always_on_top(&app, config.always_on_top);
    let _ = app.emit("config-changed", &config);
    Ok(config)
}

/// ¿El guardado cambia el destino de 9Router? Compara ignorando la barra final y
/// los espacios. Cuando cambia, las credenciales guardadas (del destino anterior)
/// dejan de ser válidas para el nuevo y hay que invalidarlas.
fn nine_router_destination_changed(old_base: &str, new_base: &str) -> bool {
    providers::nine_router::normalize_base(old_base) != providers::nine_router::normalize_base(new_base)
}

/// Orden fail-safe al cambiar destino: invalidar secretos y solo entonces permitir
/// publicar la URL nueva. Si `forget` falla, el caller no debe persistir B.
/// Devuelve `true` cuando hubo que invalidar.
fn invalidate_nine_router_before_destination_publish(
    old_base: &str,
    new_base: &str,
    forget: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    if !nine_router_destination_changed(old_base, new_base) {
        return Ok(false);
    }
    forget()?;
    Ok(true)
}

/// Borra contraseña, cookie **y** vínculo al destino. Invalida renovaciones pendientes.
fn forget_nine_router_secrets() -> Result<(), String> {
    providers::nine_router_creds::forget_all()
}

/// Merge atómico de los campos del widget sobre la config actual: nunca toca
/// cuentas ni secretos, así un snapshot obsoleto no puede borrar una cuenta.
/// Devuelve la config persistida junto al posible fallo del efecto nativo.
#[tauri::command]
fn patch_config(app: AppHandle, state: State<'_, AppState>, patch: config::WidgetPatch) -> Result<ConfigPatchOutcome, String> {
    let apply_top = patch_touches_always_on_top(&patch);
    let (_old, config) = update_config(&state, |current| current.apply_widget_patch(patch))?;
    let native_error = if apply_top { apply_always_on_top(&app, config.always_on_top) } else { None };
    let _ = app.emit("config-changed", &config);
    Ok(ConfigPatchOutcome { config, native_error })
}

#[tauri::command]
fn secret_status(state: State<'_, AppState>) -> BTreeMap<String, bool> {
    let accounts = state.config.lock().unwrap().accounts.clone();
    secrets::status(&accounts)
}

#[tauri::command]
fn set_secret(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // P2: las claves de 9Router solo mutan vía el coordinador (login/logout/save URL).
    // El setter genérico saltaría el lock y la generación.
    if providers::nine_router_creds::is_managed_key(&key) {
        return Err("Las credenciales de 9Router solo se gestionan al conectar o desconectar.".into());
    }
    secrets::set(&key, &value)?;
    let _ = app.emit("config-changed", ());
    Ok(())
}

#[tauri::command]
async fn fetch_usage(state: State<'_, AppState>) -> Result<Vec<UsageReport>, String> {
    let cfg = state.config.lock().unwrap().clone();
    let reports = providers::fetch_all(&cfg, &state.http).await;
    state.history.record(&reports, chrono::Utc::now().timestamp());
    Ok(reports)
}

/// Lecturas guardadas de un proveedor en las últimas `hours` horas.
#[tauri::command]
fn get_history(state: State<'_, AppState>, provider: String, hours: u32) -> Vec<history::Sample> {
    let since = chrono::Utc::now().timestamp() - i64::from(hours.clamp(1, 24 * 30)) * 3600;
    state.history.query(&provider, since)
}

/// Respuestas en crudo de la API de NaN (Ajustes › NaN › Probar).
#[tauri::command]
async fn nan_probe(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().unwrap().clone();
    providers::nan::probe(&cfg.nan, &state.http).await
}

/// Guarda la contraseña del dashboard de 9Router y prueba el login; devuelve las
/// stats en crudo (Ajustes › 9Router › Probar). `base_url` es la del borrador de
/// Ajustes si el usuario la cambió sin guardar; si no, la persistida.
///
/// Las credenciales están vinculadas al servidor. Una prueba contra otro destino
/// usa una sesión temporal aislada. Para persistir, config y ticket se capturan
/// bajo el mismo lock que el guardado y logout; tras la red la generación debe
/// seguir vigente. Ningún lock de configuración se mantiene durante el `.await`.
#[tauri::command]
async fn nine_router_login(app: AppHandle, state: State<'_, AppState>, password: String, base_url: Option<String>) -> Result<String, String> {
    let (cfg, ticket) = config_transaction::snapshot_with_ticket(
        &state.config,
        providers::nine_router_creds::begin_write_ticket,
    );
    let saved_base = cfg.nine_router.base_url.trim();
    let draft_base = base_url
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let base = draft_base.clone().unwrap_or_else(|| saved_base.to_string());
    if providers::nine_router::same_destination(saved_base, draft_base.as_deref()) {
        // Ticket antes del await: si hay logout / otro destino / otra conexión,
        // la respuesta de A no debe restaurar ni sobrescribir (persist_if_generation).
        let cookie = providers::nine_router::login(&state.http, &base, &password).await?;
        match providers::nine_router_creds::persist_if_generation(&base, &password, &cookie, ticket) {
            Ok(()) => {}
            Err(providers::nine_router_creds::PersistError::Stale) => {
                return Err("La sesión de 9Router cambió durante el login. Vuelve a conectar.".into());
            }
            Err(providers::nine_router_creds::PersistError::Store(e)) => return Err(e),
        }
        let _ = app.emit("config-changed", ());
        // P2: la conexión no cambia la config, así que `config-changed` no obliga a
        // refrescar los datos del widget (que se refrescan por `needsRefresh`, que
        // mira la config, no las credenciales). Se pide el refresco explícito para
        // que el orbe refleje la sesión recién establecida sin esperar al ciclo.
        let _ = app.emit("refresh-now", ());
        providers::nine_router::probe(&state.http, &cfg.nine_router, Some(&base)).await
    } else {
        // Destino del borrador ≠ persistido: prueba aislada, sin persistir nada.
        providers::nine_router::probe_with_password(&state.http, &cfg.nine_router, &base, &password).await
    }
}

/// Desconecta 9Router: borra contraseña, cookie y vínculo al destino.
/// Si el almacén no confirma el borrado, se propaga el error (no se informa éxito).
#[tauri::command]
fn nine_router_logout(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    config_transaction::with_locked(&state.config, forget_nine_router_secrets)?;
    let _ = app.emit("config-changed", ());
    // P2: desconectar también debe refrescar el widget al instante (misma razón
    // que en el login: la config no cambia, solo la sesión).
    let _ = app.emit("refresh-now", ());
    Ok(())
}

/// NaN: envía el enlace de acceso al correo (mismo flujo que `nan auth login --email`).
#[tauri::command]
async fn nan_login_request(state: State<'_, AppState>, email: String) -> Result<(), String> {
    providers::nan_cloud::login_request(&state.http, &email).await
}

/// NaN: usa el enlace pegado para abrir sesión, la guarda en el almacén seguro y devuelve el usuario.
/// `account`: id de una cuenta adicional de NaN; sin él, la sesión es la de la principal.
#[tauri::command]
async fn nan_login_complete(app: AppHandle, state: State<'_, AppState>, link: String, account: Option<String>) -> Result<String, String> {
    let cookie = providers::nan_cloud::login_complete(&link).await?;
    let who = providers::nan_cloud::whoami(&state.http, &cookie).await.map_err(|e| match e {
        providers::nan_cloud::CloudError::Expired => "NaN no ha aceptado la sesión del enlace. Pide otro e inténtalo de nuevo.".to_string(),
        providers::nan_cloud::CloudError::Other(m) => m,
    })?;
    let key = match account.as_deref() {
        Some(id) if id.starts_with("nan:") && config::is_account_id(id) => secrets::scoped(secrets::NAN_SESSION, id),
        Some(_) => return Err("Cuenta de NaN no válida".into()),
        None => secrets::NAN_SESSION.to_string(),
    };
    secrets::set(&key, &cookie)?;
    let _ = app.emit("config-changed", ());
    Ok(who)
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct EffectRequest {
    /// confetti | glow | custom
    kind: String,
    /// exceeded | reset (elige el archivo del efecto propio)
    moment: String,
    /// Rectángulo del monitor en píxeles físicos.
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct EffectPayload {
    kind: String,
    moment: String,
    media_path: Option<String>,
    media_size: String,
    media_sound: bool,
    accent: String,
}

/// Lanza un efecto a pantalla completa en la ventana overlay (transparente y que deja pasar los clics).
#[tauri::command]
fn play_effect(app: AppHandle, state: State<'_, AppState>, req: EffectRequest) -> Result<(), String> {
    let cfg = state.config.lock().unwrap().clone();
    let w = app.get_webview_window(OVERLAY).ok_or("No existe la ventana de efectos")?;
    let mut media_path = None;
    if req.kind == "custom" {
        let path = cfg
            .alerts
            .media_for(&req.moment)
            .map(str::to_string)
            .ok_or("No hay archivo para el efecto propio de este aviso")?;
        // Solo ese archivo queda accesible desde el webview (asset protocol).
        app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?;
        media_path = Some(path);
    }
    w.set_position(PhysicalPosition::new(req.x, req.y)).map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new(req.width.max(1), req.height.max(1))).map_err(|e| e.to_string())?;
    // Misma micro-ventana que el OVERLAY en `setup()`: `show()` antes de
    // `set_ignore_cursor_events` para evitar el panic de tao 0.37.1 en
    // Wayland. El bloque canónico con la nota completa está en el builder
    // del OVERLAY (ver `setup()`). Si el click-through no funciona, es un
    // no-op silencioso (recomendación de `wm_compat`).
    w.show().map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(true);
    app.emit_to(
        OVERLAY,
        "play-effect",
        EffectPayload {
            kind: req.kind,
            moment: req.moment,
            media_path,
            media_size: cfg.alerts.media_size.clone(),
            media_sound: cfg.alerts.media_sound,
            accent: cfg.accent_color.clone(),
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn overlay_done(app: AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.hide();
    }
}

/// Huella de los ficheros de sesión de los CLIs (ver `providers::session_stamp`).
#[tauri::command]
fn session_stamp(state: State<'_, AppState>) -> u64 {
    let cfg = state.config.lock().unwrap().clone();
    providers::session_stamp(&cfg)
}

/// Comprueba la conexión de una cuenta (principal o adicional) con la config guardada,
/// aunque esté oculta en el widget. `None` si el id no existe.
#[tauri::command]
async fn check_provider(state: State<'_, AppState>, id: String) -> Result<Option<UsageReport>, String> {
    let cfg = state.config.lock().unwrap().clone();
    Ok(providers::fetch_one(&cfg, &id, &state.http).await)
}

/// ¿Está instalado el CLI de login de Claude, Codex y Gemini?
/// `async` lo saca del hilo principal: consulta el PATH fresco del registro.
#[tauri::command(async)]
fn cli_status(state: State<'_, AppState>) -> BTreeMap<String, bool> {
    let cfg = state.config.lock().unwrap().clone();
    login::cli_status(&cfg)
}

/// ¿Existe el fichero de sesión de una cuenta? `home` se inyecta para poder
/// probar con carpetas propias; `true` es presencia, no validez de la sesión.
fn account_session_file_found(cfg: &AppConfig, id: &str, home: &std::path::Path) -> bool {
    providers::session_file(cfg, id, home).is_some_and(|p| p.is_file())
}

/// ¿Hay fichero de sesión del CLI para una cuenta adicional? `true` es presencia,
/// no validez de la sesión.
#[tauri::command]
fn account_session(state: State<'_, AppState>, id: String) -> bool {
    let cfg = state.config.lock().unwrap().clone();
    account_session_file_found(&cfg, &id, &providers::home())
}

#[tauri::command]
fn open_login(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    // Single-flight: si hay una apertura en curso para este id, no abrir
    // una segunda terminal (doble clic / reenvío del frontend).
    // `unwrap_or_else(into_inner)`: si otro hanco pánicara con el lock tomado,
    // el mutex queda envenenado y con `unwrap` todos los `open_login` futuros
    // paniquearían en cascada. Con `into_inner` seguimos operando el set.
    let mut inflight = state.login_in_flight.lock().unwrap_or_else(|p| p.into_inner());
    if !inflight.insert(provider.clone()) {
        return Err("Ya hay una apertura de terminal en curso para esta cuenta. Si no se abrió, inténtalo de nuevo.".into());
    }
    drop(inflight); // no mantener el lock mientras spawn_terminal corre
    let cfg = state.config.lock().unwrap().clone();
    let r = login::open(&provider, &cfg);
    state.login_in_flight.lock().unwrap_or_else(|p| p.into_inner()).remove(&provider);
    r
}

/// Estado de solo lectura de la instalación asistida de Codex (sin procesos).
/// `async` lo saca del hilo principal: hace lecturas de FS/registro al sondear.
#[tauri::command(async)]
fn codex_setup_status(state: State<'_, codex_setup::CodexSetupState>) -> codex_setup::CodexSetupStatus {
    codex_setup::status(state.inner())
}

/// Instala el CLI de Codex en la carpeta gestionada de Quorb. Solo desde Ajustes,
/// con confirmación nativa previa y rechazo de invocaciones concurrentes.
#[tauri::command]
async fn install_codex(app: AppHandle, window: WebviewWindow) -> Result<codex_setup::CodexInstallResult, String> {
    let label = window.label().to_string();
    if !codex_setup::settings_window_ok(&label) {
        return Err(codex_setup::MSG_WRONG_WINDOW.to_string());
    }
    // Todo el trabajo (diálogo nativo, procesos) va en un hilo bloqueante para no
    // congelar el hilo principal de la interfaz.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let state = app.state::<codex_setup::CodexSetupState>();
        let platform = codex_setup::Platform::current();
        let node = codex_setup::discover_node_in(&codex_setup::node_search_roots(platform));
        let tools_root = codex_setup::tools_root(&providers::home());
        let base_env = codex_setup::process_env_map();
        let confirm = || {
            app.dialog()
                .message(codex_setup::consent_message())
                .title("Instalar Codex")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Instalar".into(), "Cancelar".into()))
                // Dueño nativo: la confirmación se ancla a la ventana de Ajustes.
                .parent(&window)
                .blocking_show()
        };
        codex_setup::install_codex_flow(
            state.inner(),
            platform,
            node.as_ref(),
            &tools_root,
            &base_env,
            &codex_setup::ProcessRunner,
            &confirm,
        )
    })
    .await
    .map_err(|_| codex_setup::MSG_GENERIC_ERROR.to_string())?
}

// Async: crear ventanas desde un comando síncrono puede bloquearse en Windows.
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings(&app).map_err(|e| e.to_string())
}

/// Never show a detached panel while its widget is hidden (including an in-flight hover).
#[tauri::command]
fn show_detail(app: AppHandle) -> Result<bool, String> {
    let widget = app.get_webview_window(WIDGET).ok_or("No existe el widget")?;
    if !widget.is_visible().map_err(|e| e.to_string())? {
        return Ok(false);
    }
    let detail = app.get_webview_window(DETAIL).ok_or("No existe el panel de detalle")?;
    detail.show().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn set_tray_tooltip(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

// ───────────────────────── ventanas ─────────────────────────

fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        w.show()?;
        w.unminimize()?;
        return w.set_focus();
    }
    // Alto suficiente para ver Proveedores sin scroll al abrir, sin pasar de la
    // pantalla (menos la barra de tareas y el título de la ventana).
    let height = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / m.scale_factor() - 96.0)
        .map_or(SETTINGS_HEIGHT, |max| SETTINGS_HEIGHT.min(max).max(520.0));
    let win = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("index.html".into()))
        .title(format!("Ajustes · {}", channel::current().name))
        .inner_size(1040.0, height)
        .min_inner_size(480.0, 520.0)
        .center()
        .build()?;
    // Ajustes se ve a escala 85 % (como el zoom del navegador): textos, tarjetas y
    // controles más compactos sin tocar el CSS, y cabe más contenido en la ventana.
    let _ = win.set_zoom(SETTINGS_ZOOM);
    Ok(())
}

fn hide_detail(app: &AppHandle) {
    if let Some(detail) = app.get_webview_window(DETAIL) {
        let _ = detail.hide();
    }
    let _ = app.emit_to(DETAIL, "detail-state", None::<()>);
}

fn toggle_widget(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WIDGET) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            hide_detail(app);
            let _ = app.emit_to(WIDGET, "widget-hidden", ());
        } else {
            let _ = w.show();
        }
    }
}

/// La app se llamaba «egdev AI Usage» (identificador `es.egdev.ai-usage`).
/// Si existe un fichero de entonces y aún no hay uno nuevo, se copia.
fn migrate_legacy_dir(dir: &std::path::Path, file: &str) {
    if !channel::current().migrate_legacy { return; }
    let target = dir.join(file);
    if target.exists() {
        return;
    }
    let Some(legacy) = dir.parent().map(|p| p.join("es.egdev.ai-usage").join(file)) else {
        return;
    };
    if legacy.is_file() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::copy(legacy, target);
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Mostrar / ocultar widget", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Actualizar ahora", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Ajustes…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &refresh, &settings, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(channel::current().name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_widget(app),
            "refresh" => {
                let _ = app.emit("refresh-now", ());
            }
            "settings" => {
                let _ = show_settings(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_widget(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ───────────────────────── arranque ─────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(code) = uninstall::dispatch(&std::env::args().skip(1).collect::<Vec<_>>()) {
        std::process::exit(code);
    }
    let builder = tauri::Builder::default()
        // Debe ir el primero: si ya está abierta, muestra el widget existente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(WIDGET) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let action = app.try_state::<Shortcuts>().and_then(|s| {
                        let map = s.map.lock().unwrap();
                        let found = map.iter().find(|(sc, _)| sc == shortcut).map(|(_, a)| *a);
                        found
                    });
                    if let Some(a) = action {
                        on_shortcut(app, a);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            migrate_legacy_dir(&config_dir, "config.json");
            migrate_legacy_dir(&data_dir, "history.json");
            let config_path = config_dir.join("config.json");
            let cfg = config::load(&config_path);
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .user_agent(concat!("quorb/", env!("CARGO_PKG_VERSION")))
                .build()?;

            // El frontend coloca la tira en su borde y la muestra (evita un parpadeo).
            if let Some(w) = app.get_webview_window(WIDGET) {
                let _ = w.set_always_on_top(cfg.always_on_top);
            }
            // En macOS una ventana queda clavada en su Space a menos que se marque
            // «visible en todos los Spaces» (NSWindow.canJoinAllSpaces): sin esto la
            // tira no sigue al usuario entre Spaces ni sobre apps fullscreen, y el
            // detalle/overlay quedarían en otro Space distinto al de la tira.
            // Windows/Linux no lo necesitan: no hay Spaces y siempre-encina ya
            // cubre el caso.
            let history = history::History::load(data_dir.join("history.json"));

            // El detalle tiene su propia superficie: abrirlo nunca redimensiona la tira.
            WebviewWindowBuilder::new(app, DETAIL, WebviewUrl::App("index.html".into()))
                .title(format!("{} · detalle", channel::current().name))
                .inner_size(330.0, 260.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(cfg.always_on_top)
                .skip_taskbar(true)
                .resizable(false)
                .focused(false)
                .visible(false)
                .build()?;

            // Ventana de efectos: transparente, sin foco, encima de todo y sin capturar el ratón.
            let _overlay = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("index.html".into()))
                .title(format!("{} · efectos", channel::current().name))
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .focused(false)
                .focusable(false)
                .visible(false)
                .build()?;
            // Sin `set_ignore_cursor_events` aquí: la ventana aún está oculta
            // y no tiene GdkWindow → tao 0.37.1 panicea (`window.window()
            // .unwrap()` en `CursorIgnoreEvents`, bug tao#1204). Se aplica en
            // `play_effect()` después de `show()`.

            // Se aplica tras construir DETAIL y OVERLAY: si corre antes, esos dos
            // get_webview_window devuelven None y quedan clavados a su Space.
            #[cfg(target_os = "macos")]
            for label in [WIDGET, DETAIL, OVERLAY] {
                if let Some(w) = app.get_webview_window(label) {
                    if let Err(e) = w.set_visible_on_all_workspaces(true) {
                        eprintln!("No pude marcar «{label}» visible en todos los Spaces: {e}");
                    }
                }
            }

            app.manage(Shortcuts::default());
            app.manage(codex_setup::CodexSetupState::default());
            apply_shortcuts(app.handle(), &cfg.shortcuts);
            app.manage(AppState {
                config: Mutex::new(cfg),
                config_path,
                http,
                history,
                login_in_flight: Mutex::new(std::collections::HashSet::new()),
            });
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cerrar el widget lo oculta; la app sigue en la bandeja.
            if window.label() == WIDGET {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    hide_detail(window.app_handle());
                    let _ = window.app_handle().emit_to(WIDGET, "widget-hidden", ());
                }
            } else if window.label() == DETAIL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    hide_detail(window.app_handle());
                    let _ = window.app_handle().emit_to(WIDGET, "detail-dismiss", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            updater_mode,
            get_config,
            save_config,
            patch_config,
            secret_status,
            set_secret,
            fetch_usage,
            open_login,
            codex_setup_status,
            install_codex,
            session_stamp,
            account_session,
            cli_status,
            check_provider,
            open_settings,
            show_detail,
            set_tray_tooltip,
            get_history,
            nan_probe,
            nan_login_request,
            nan_login_complete,
            nine_router_login,
            nine_router_logout,
            play_effect,
            overlay_done,
            shortcut_errors,
            wm_compat::get_wm_info,
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Quorb");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Account;

    #[test]
    fn updater_policy_matches_compiled_target() {
        #[cfg(target_os = "macos")]
        assert_eq!(updater_mode(), "manual");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(updater_mode(), "native");
    }

    /// P1 (4º feedback): guardar una Base URL de 9Router distinta invalida los
    /// secretos del destino anterior. Sin esto, el siguiente fetch enviaría la
    /// cookie de A a B (o al revés), rompiendo la conexión anterior y exponiendo
    /// credenciales a otro destino. Escenario: conectado a A → cambiar a B →
    /// «Guardar» → los secretos de A no deben sobrevivir al guardado.
    #[test]
    fn saving_a_new_nine_router_base_url_invalidates_old_secrets() {
        // Mismo destino (con o sin barra final/espacios): los secretos siguen valiendo.
        assert!(!nine_router_destination_changed("http://localhost:20128", "http://localhost:20128"));
        assert!(!nine_router_destination_changed("http://localhost:20128/", "http://localhost:20128"));
        assert!(!nine_router_destination_changed("  http://localhost:20128  ", "http://localhost:20128/"));
        // Otro destino: hay que invalidar (se borran contraseña y cookie).
        assert!(nine_router_destination_changed("http://localhost:20128", "http://localhost:3000"));
        assert!(nine_router_destination_changed("http://localhost:20128", "http://otro-host:20128"));
        assert!(nine_router_destination_changed("http://localhost:20128", "https://localhost:20128"));
    }

    /// P1 (5º feedback): si el almacén rechaza el borrado, no se puede publicar B.
    #[test]
    fn destination_change_refuses_publish_when_forget_fails() {
        let err = invalidate_nine_router_before_destination_publish(
            "http://localhost:20128",
            "http://localhost:3000",
            || Err("store locked".into()),
        )
        .expect_err("forget fallido debe abortar el guardado de B");
        assert!(err.contains("store locked"));
    }

    /// P1 (5º feedback): el borrado ocurre (y debe completarse) antes de que el
    /// caller publique el destino nuevo — orden fail-safe frente a refrescos.
    #[test]
    fn destination_change_forgets_before_caller_may_publish() {
        let mut forgot = false;
        let mut published = false;
        let changed = invalidate_nine_router_before_destination_publish(
            "http://a:20128",
            "http://b:20128",
            || {
                assert!(!published, "no publicar B antes de invalidar");
                forgot = true;
                Ok(())
            },
        )
        .expect("forget ok");
        assert!(changed);
        assert!(forgot);
        // Solo tras Ok el caller puede persistir/publicar B.
        published = true;
        assert!(published && forgot);
    }

    #[test]
    fn same_destination_skips_forget() {
        let mut forgot = false;
        let changed = invalidate_nine_router_before_destination_publish(
            "http://localhost:20128/",
            "http://localhost:20128",
            || {
                forgot = true;
                Ok(())
            },
        )
        .unwrap();
        assert!(!changed);
        assert!(!forgot);
    }

    /// P2 (review consolidado): el setter genérico no debe tocar secretos de 9Router.
    #[test]
    fn generic_secret_setter_rejects_nine_router_keys() {
        assert!(providers::nine_router_creds::is_managed_key(secrets::NINE_ROUTER_PASSWORD));
        assert!(providers::nine_router_creds::is_managed_key(secrets::NINE_ROUTER_SESSION));
        assert!(providers::nine_router_creds::is_managed_key(secrets::NINE_ROUTER_BOUND_URL));
        assert!(!providers::nine_router_creds::is_managed_key(secrets::NAN_API_KEY));
    }

    /// Carpeta temporal propia de cada prueba: sin dependencias nuevas y sin
    /// tocar ninguna ruta real del usuario.
    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quorb-account-session-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn account_with_dir(provider: &str, dir: &std::path::Path) -> Account {
        Account {
            id: format!("{provider}:w1"),
            provider: provider.into(),
            config_dir: Some(dir.to_string_lossy().into_owned()),
            ..Default::default()
        }
    }

    #[test]
    fn account_session_ignores_unknown_accounts() {
        let home = temp_home("unknown");
        assert!(!account_session_file_found(&AppConfig::default(), "claude:w1", &home));
        let cfg = AppConfig { accounts: vec![account_with_dir("claude", &home)], ..Default::default() };
        assert!(!account_session_file_found(&cfg, "claude:otra", &home));
    }

    #[test]
    fn account_session_is_file_presence_not_validity() {
        let home = temp_home("presence");
        let dir = home.join("claude-w1");
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = AppConfig { accounts: vec![account_with_dir("claude", &dir)], ..Default::default() };
        let file = dir.join(".credentials.json");

        // Sin fichero: no hay nada.
        assert!(!account_session_file_found(&cfg, "claude:w1", &home));
        // Un directorio con ese nombre tampoco es una sesión.
        std::fs::create_dir(&file).unwrap();
        assert!(!account_session_file_found(&cfg, "claude:w1", &home));
        std::fs::remove_dir(&file).unwrap();
        // Fichero vacío: presencia, no validez de la sesión.
        std::fs::write(&file, b"").unwrap();
        assert!(account_session_file_found(&cfg, "claude:w1", &home));
    }

    #[test]
    fn account_session_without_cli_credentials_is_always_false() {
        let home = temp_home("nocreds");
        let dir = home.join("openrouter-w1");
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = AppConfig { accounts: vec![account_with_dir("openrouter", &dir)], ..Default::default() };
        // OpenRouter no usa sesión de CLI: ni con ficheros en la carpeta hay presencia.
        std::fs::write(dir.join("auth.json"), b"{}").unwrap();
        assert!(!account_session_file_found(&cfg, "openrouter:w1", &home));
    }

    #[test]
    fn patch_touches_always_on_top_by_presence_not_change() {
        // Mismo valor que la base: el reintento debe re-aplicar el efecto igual.
        let same: config::WidgetPatch = serde_json::from_str(r#"{"alwaysOnTop":true}"#).unwrap();
        assert!(patch_touches_always_on_top(&same));
        assert!(patch_touches_always_on_top(&same));
        // Un patch que no menciona el campo no re-aplica nada.
        let other: config::WidgetPatch = serde_json::from_str(r#"{"dockEdge":"left"}"#).unwrap();
        assert!(!patch_touches_always_on_top(&other));
    }

    #[test]
    fn always_on_top_error_is_visible() {
        let msg = always_on_top_error("acceso denegado");
        assert!(msg.contains("siempre encima"));
        assert!(msg.contains("acceso denegado"));
    }
}
