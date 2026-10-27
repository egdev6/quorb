//! Windows-only, UI-thread-owned composition. Never apply an HWND-wide backdrop.
use crate::window_clip::{self, Clip, GeometryMatch};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    mem::size_of,
    sync::atomic::{AtomicU32, AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow, Window, WindowEvent};
use windows::{
    core::{Interface, Result as WinResult, BOOL},
    System::{DispatcherQueue, DispatcherQueueController},
    Win32::{
        Foundation::HWND,
        Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_HOSTBACKDROPBRUSH},
        System::{
            Threading::GetCurrentThreadId,
            WinRT::{
                Composition::ICompositorDesktopInterop, CreateDispatcherQueueController,
                DispatcherQueueOptions, RoInitialize, RoUninitialize, DQTAT_COM_NONE,
                DQTYPE_THREAD_CURRENT, RO_INIT_SINGLETHREADED,
            },
        },
        UI::WindowsAndMessaging::{
            DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, PostQuitMessage,
            TranslateMessage, MSG, MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT, WM_QUIT,
        },
    },
    UI::Composition::{
        CompositionBackdropBrush, CompositionEffectBrush, CompositionEffectFactory, Compositor,
        ContainerVisual, Desktop::DesktopWindowTarget, RectangleClip, SpriteVisual, Visual,
    },
};
use windows_numerics::Vector2;

type Result<T> = std::result::Result<T, String>;
static UI_THREAD: AtomicU32 = AtomicU32::new(0);
static DIAGNOSTICS: AtomicUsize = AtomicUsize::new(0);
thread_local! {
    // No WinRT object or completion action is ever captured by a Send closure.
    static STATE: RefCell<Option<Backend>> = const { RefCell::new(None) };
    static CLOSING: Cell<bool> = const { Cell::new(false) };
    static PENDING: RefCell<BTreeMap<String, Change>> = RefCell::new(BTreeMap::new());
}

fn diagnostic(message: impl std::fmt::Display) {
    let n = DIAGNOSTICS.fetch_add(1, Ordering::Relaxed);
    if n < 64 {
        let text: String = message
            .to_string()
            .replace(['\r', '\n'], " ")
            .chars()
            .take(300)
            .collect();
        eprintln!("Windows backdrop: {text}");
    } else if n == 64 {
        eprintln!("Windows backdrop: further repeated diagnostics suppressed");
    }
}
fn checked(context: &str, result: WinResult<()>) {
    if let Err(e) = result {
        diagnostic(format!("{context}: {e}"));
    }
}
pub fn initialize_ui_thread() {
    let id = unsafe { GetCurrentThreadId() };
    if let Err(old) = UI_THREAD.compare_exchange(0, id, Ordering::Relaxed, Ordering::Relaxed) {
        if old != id {
            diagnostic("refusing to change composition UI thread");
        }
    }
}
fn require_ui() -> Result<()> {
    if UI_THREAD.load(Ordering::Relaxed) == unsafe { GetCurrentThreadId() } {
        Ok(())
    } else {
        Err("Composition must run on the registered UI thread".into())
    }
}

#[derive(Clone, Copy)]
struct Snapshot {
    hwnd: isize,
    client: (u32, u32),
    outer: (u32, u32),
    visible: bool,
    scale: f64,
}
fn snapshot(window: &WebviewWindow) -> Result<Snapshot> {
    let client = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    Ok(Snapshot {
        hwnd: window.hwnd().map_err(|e| e.to_string())?.0 as isize,
        client: (client.width, client.height),
        outer: (outer.width, outer.height),
        visible: window.is_visible().map_err(|e| e.to_string())?,
        scale: window.scale_factor().map_err(|e| e.to_string())?,
    })
}
impl Snapshot {
    fn dimensions(self) -> Result<(u32, u32)> {
        if self.visible && self.client != self.outer {
            return Err(
                "shown frameless client differs from outer bounds; not accepting a frame".into(),
            );
        }
        if !self.scale.is_finite() || self.scale <= 0.0 {
            return Err("Invalid native DPI".into());
        }
        Ok(if self.visible {
            self.client
        } else {
            self.outer
        })
    }
}
enum Change {
    Geometry(Snapshot),
    Destroyed,
}

pub fn apply(window: &WebviewWindow, clip: Clip, visible: bool) -> Result<()> {
    require_ui()?;
    if !window_clip::may_create_layer(window.label(), CLOSING.with(Cell::get)) {
        return Err("Surface backdrop is unavailable for this window or during shutdown".into());
    }
    let geometry = snapshot(window)?;
    geometry.dimensions()?;
    match window_clip::geometry_match(&clip, geometry.client, geometry.outer, geometry.visible) {
        GeometryMatch::Current => {}
        GeometryMatch::Stale => {
            diagnostic(format!(
                "ignored stale clip for {}: {}x{}",
                window.label(),
                clip.width,
                clip.height
            ));
            return Ok(());
        }
        GeometryMatch::UnexpectedFrame => return Err("Unexpected native surface frame".into()),
    }
    let result = STATE.with(|state| {
        let mut state = state
            .try_borrow_mut()
            .map_err(|_| "Composition is handling a reentrant UI event")?;
        if state.is_none() {
            *state = Some(Backend::new().map_err(|e| format!("Composition initialization: {e}"))?);
        }
        state.as_mut().ok_or("Composition unavailable")?.apply(
            window.label(),
            geometry,
            clip,
            visible,
        )
    });
    drain_pending();
    if let Err(e) = &result {
        diagnostic(format!("{}: {e}", window.label()));
    }
    result
}

/// Called from Tauri's UI event callback. Geometry changes never create a layer.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !window_clip::supports(window.label()) || UI_THREAD.load(Ordering::Relaxed) == 0 {
        return;
    }
    if let Err(e) = require_ui() {
        diagnostic(e);
        return;
    }
    let change = match event {
        WindowEvent::Destroyed => Change::Destroyed,
        WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. }
        | WindowEvent::Moved(_)
        | WindowEvent::Focused(_) => {
            let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
                return;
            };
            match snapshot(&webview) {
                Ok(g) => Change::Geometry(g),
                Err(e) => {
                    diagnostic(e);
                    return;
                }
            }
        }
        _ => return,
    };
    PENDING.with(|pending| {
        if let Ok(mut pending) = pending.try_borrow_mut() {
            pending.insert(window.label().into(), change);
        } else {
            diagnostic("reentrant geometry notification could not be queued");
        }
    });
    drain_pending();
}
fn drain_pending() {
    // COM can dispatch nested Win32 events. They only replace two pending snapshots;
    // the outer owner drains them after releasing its borrow. Never RefCell::borrow.
    STATE.with(|state| {
        let Ok(mut state) = state.try_borrow_mut() else {
            return;
        };
        for _ in 0..4 {
            let changes =
                PENDING.with(|p| p.try_borrow_mut().ok().map(|mut p| std::mem::take(&mut *p)));
            let Some(changes) = changes else {
                return;
            };
            if CLOSING.with(Cell::get) {
                if let Some(backend) = state.as_mut() {
                    backend.begin_shutdown();
                }
                return;
            }
            if changes.is_empty() {
                return;
            }
            let Some(backend) = state.as_mut() else {
                continue;
            };
            for (label, change) in changes {
                match change {
                    Change::Destroyed => {
                        backend.layers.remove(&label);
                    }
                    Change::Geometry(geometry) => {
                        if let Some(layer) = backend.layers.get_mut(&label) {
                            if layer.hwnd != geometry.hwnd {
                                continue;
                            }
                            let result = (|| -> Result<()> {
                                let (w, h) = geometry.dimensions()?;
                                // Minimized zero sizes do not replace the last useful contour.
                                if w == 0 || h == 0 {
                                    return Ok(());
                                }
                                let shape =
                                    layer.shape.resized(w, h, layer.scale, geometry.scale)?;
                                layer
                                    .update(
                                        backend
                                            .compositor
                                            .as_ref()
                                            .ok_or("Composition is closing")?,
                                        shape,
                                        geometry.scale,
                                    )
                                    .map_err(|e| e.to_string())
                            })();
                            if let Err(e) = result {
                                diagnostic(format!("resize {label}: {e}"));
                            }
                        }
                    }
                }
            }
        }
    });
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}
struct Backend {
    layers: BTreeMap<String, Layer>,
    compositor: Option<Compositor>,
    queue: Option<DispatcherQueue>,
    controller: Option<DispatcherQueueController>,
    // Type-erased only because windows 0.62 returns windows_future::IAsyncAction.
    // This closure is UI-local, NOT Send; it retains the native completion action.
    shutdown: Option<Box<dyn FnMut() -> WinResult<bool>>>,
    apartment: Option<Apartment>,
    closing: bool,
}
impl Backend {
    fn new() -> WinResult<Self> {
        unsafe {
            RoInitialize(RO_INIT_SINGLETHREADED)?;
        }
        let mut backend = Self {
            layers: BTreeMap::new(),
            compositor: None,
            queue: None,
            controller: None,
            shutdown: None,
            apartment: Some(Apartment),
            closing: false,
        };
        backend.queue = Some(match DispatcherQueue::GetForCurrentThread() {
            Ok(queue) => queue,
            // Both projections of a successful null interface mean no existing queue.
            Err(e) if e.code().0 == 0 || e.code().0 == 0x80004003u32 as i32 => {
                let controller = unsafe {
                    CreateDispatcherQueueController(DispatcherQueueOptions {
                        dwSize: size_of::<DispatcherQueueOptions>() as u32,
                        threadType: DQTYPE_THREAD_CURRENT,
                        apartmentType: DQTAT_COM_NONE,
                    })?
                };
                backend.controller = Some(controller.clone());
                controller.DispatcherQueue()?
            }
            Err(e) => return Err(e),
        });
        backend.compositor = Some(Compositor::new()?);
        Ok(backend)
    }
    fn apply(&mut self, label: &str, geometry: Snapshot, shape: Clip, visible: bool) -> Result<()> {
        if !window_clip::may_create_layer(label, self.closing) {
            return Err("Composition is closing".into());
        }
        let compositor = self.compositor.as_ref().ok_or("Composition unavailable")?;
        if self
            .layers
            .get(label)
            .is_some_and(|l| l.hwnd != geometry.hwnd)
        {
            self.layers.remove(label);
        }
        if let Some(layer) = self.layers.get_mut(label) {
            // CSS owns the moving surface/semicircle; do not leave a static blur rectangle behind it.
            layer
                .root
                .SetOpacity(if visible { 1.0 } else { 0.0 })
                .map_err(|e| e.to_string())?;
            layer
                .update(compositor, shape, geometry.scale)
                .map_err(|e| e.to_string())
        } else {
            let layer = Layer::new(compositor, geometry, shape)
                .map_err(|e| format!("Backdrop for {label}: {e}"))?;
            layer
                .root
                .SetOpacity(if visible { 1.0 } else { 0.0 })
                .map_err(|e| e.to_string())?;
            self.layers.insert(label.into(), layer);
            Ok(())
        }
    }
    fn begin_shutdown(&mut self) {
        if self.closing {
            return;
        }
        self.closing = true;
        // Tauri RunEvent::Exit precedes cleanup_before_exit (and HWND destruction).
        self.layers.clear();
        if let Some(compositor) = self.compositor.take() {
            checked("close compositor", compositor.Close());
        }
        if let Some(controller) = &self.controller {
            match controller.ShutdownQueueAsync() {
                Ok(action) => {
                    self.shutdown = Some(Box::new(move || {
                        if action.Status()?.0 == 0 {
                            return Ok(false);
                        }
                        action.GetResults()?;
                        Ok(true)
                    }))
                }
                Err(e) => diagnostic(format!("request queue shutdown: {e}")),
            }
        }
    }
    fn finish_shutdown(&mut self) {
        if self.apartment.is_none() {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut finished = self.controller.is_none(); // Never shut down a borrowed queue.
        let mut quit = None;
        while let Some(poll) = self.shutdown.as_mut() {
            match poll() {
                Ok(true) => {
                    finished = true;
                    break;
                }
                Ok(false) => {}
                Err(e) => {
                    diagnostic(format!("queue shutdown completion: {e}"));
                    break;
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            let mut message = MSG::default();
            // Bound both total time and each drain so a busy queue cannot starve the deadline.
            for _ in 0..64 {
                if Instant::now() >= deadline
                    || !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool()
                {
                    break;
                }
                if message.message == WM_QUIT {
                    quit = Some(message.wParam.0 as i32);
                } else {
                    unsafe {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
            }
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(10) as u32;
            let wait = unsafe {
                MsgWaitForMultipleObjectsEx(None, remaining, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
            };
            if wait.0 == u32::MAX {
                diagnostic("queue shutdown message wait failed");
                break;
            }
        }
        if let Some(code) = quit {
            unsafe { PostQuitMessage(code) };
        }
        if !finished {
            // Never uninitialize an apartment underneath an outstanding owned queue.
            // Terminal failure only: retain its ownership until process teardown.
            diagnostic("owned queue failed to finish within 2s; retaining queue/apartment until process exit");
            std::mem::forget(self.shutdown.take());
            std::mem::forget(self.controller.take());
            std::mem::forget(self.queue.take());
            std::mem::forget(self.apartment.take());
            return;
        }
        self.shutdown.take();
        self.controller.take();
        self.queue.take();
        self.apartment.take(); // Last: all our WinRT references have been released.
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        self.begin_shutdown();
        self.finish_shutdown();
    }
}

// Public D2D effect graph adapter; no Win2D, capture API, or private interface.
mod gaussian {
    use std::sync::Mutex;
    use windows::{
        core::{implement, Interface, GUID, HRESULT, HSTRING, PCWSTR},
        Foundation::{IPropertyValue, PropertyValue},
        Graphics::Effects::{
            IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectSource_Impl,
            IGraphicsEffect_Impl,
        },
        Win32::System::WinRT::Graphics::Direct2D::{
            IGraphicsEffectD2D1Interop, IGraphicsEffectD2D1Interop_Impl,
            GRAPHICS_EFFECT_PROPERTY_MAPPING, GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT,
        },
        UI::Composition::CompositionEffectSourceParameter,
    };
    type Result<T> = windows::core::Result<T>;
    fn invalid() -> windows::core::Error {
        windows::core::Error::from_hresult(HRESULT(0x80070057u32 as i32))
    }
    #[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
    struct Gaussian {
        name: Mutex<HSTRING>,
        sigma: f32,
        source: IGraphicsEffectSource,
    }
    impl IGraphicsEffect_Impl for Gaussian_Impl {
        fn Name(&self) -> Result<HSTRING> {
            Ok(self.name.lock().map_err(|_| invalid())?.clone())
        }
        fn SetName(&self, value: &HSTRING) -> Result<()> {
            *self.name.lock().map_err(|_| invalid())? = value.clone();
            Ok(())
        }
    }
    impl IGraphicsEffectSource_Impl for Gaussian_Impl {}
    impl IGraphicsEffectD2D1Interop_Impl for Gaussian_Impl {
        fn GetEffectId(&self) -> Result<GUID> {
            Ok(GUID::from_u128(0x1feb6d69_2fe6_4ac9_8c58_1d7f93e7a6a5))
        }
        fn GetNamedPropertyMapping(
            &self,
            name: &PCWSTR,
            index: *mut u32,
            mapping: *mut GRAPHICS_EFFECT_PROPERTY_MAPPING,
        ) -> Result<()> {
            if name.is_null() || index.is_null() || mapping.is_null() {
                return Err(invalid());
            }
            let property = match unsafe { name.to_string()? }.as_str() {
                "StandardDeviation" => 0,
                "Optimization" => 1,
                "BorderMode" => 2,
                _ => return Err(invalid()),
            };
            unsafe {
                *index = property;
                *mapping = GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT;
            }
            Ok(())
        }
        fn GetPropertyCount(&self) -> Result<u32> {
            Ok(3)
        }
        fn GetProperty(&self, index: u32) -> Result<IPropertyValue> {
            match index {
                0 => PropertyValue::CreateSingle(self.sigma)?.cast(),
                1 | 2 => PropertyValue::CreateUInt32(1)?.cast(), // balanced / hard border
                _ => Err(invalid()),
            }
        }
        fn GetSource(&self, index: u32) -> Result<IGraphicsEffectSource> {
            if index != 0 {
                return Err(invalid());
            }
            Ok(self.source.clone())
        }
        fn GetSourceCount(&self) -> Result<u32> {
            Ok(1)
        }
    }
    pub fn create(sigma: f32) -> Result<IGraphicsEffect> {
        if !sigma.is_finite() || sigma < 0.0 {
            return Err(invalid());
        }
        Ok(Gaussian {
            name: Mutex::new(HSTRING::from("RawGaussian")),
            sigma,
            source: CompositionEffectSourceParameter::Create(&HSTRING::from("rawBackdrop"))?
                .cast()?,
        }
        .into())
    }
}

// Composition coordinates are physical pixels; the requested blur remains four logical pixels.
fn physical_sigma(scale: f64) -> WinResult<f32> {
    let sigma = (4.0 * scale) as f32;
    if !scale.is_finite() || scale <= 0.0 || !sigma.is_finite() || sigma <= 0.0 {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x80070057u32 as i32,
        )));
    }
    Ok(sigma)
}
fn needs_gaussian(active: Option<f32>, requested: f32) -> bool {
    active != Some(requested)
}

// All resources, including partially built graphs, stay on the composition UI thread.
struct BrushResources {
    source: Option<CompositionBackdropBrush>,
    factory: Option<CompositionEffectFactory>,
    effect: Option<CompositionEffectBrush>,
    sigma: Option<f32>,
}
impl BrushResources {
    fn empty() -> Self {
        Self {
            source: None,
            factory: None,
            effect: None,
            sigma: None,
        }
    }
    fn gaussian(compositor: &Compositor, sigma: f32) -> WinResult<Self> {
        let mut graph = Self::empty();
        graph.source = Some(compositor.CreateBackdropBrush()?);
        graph.factory = Some(compositor.CreateEffectFactory(&gaussian::create(sigma)?)?);
        graph.effect = Some(graph.factory.as_ref().unwrap().CreateBrush()?);
        graph.effect.as_ref().unwrap().SetSourceParameter(
            &windows::core::HSTRING::from("rawBackdrop"),
            graph.source.as_ref().unwrap(),
        )?;
        graph.sigma = Some(sigma);
        Ok(graph)
    }
    fn bind(&self, sprite: &SpriteVisual) -> WinResult<()> {
        sprite.SetOpacity(if self.sigma.is_some() { 1.0 } else { 0.60 })?;
        if let Some(effect) = &self.effect {
            sprite.SetBrush(effect)
        } else {
            sprite.SetBrush(self.source.as_ref().unwrap())
        }
    }
    fn install(compositor: &Compositor, sprite: &SpriteVisual, sigma: f32) -> WinResult<Self> {
        let gaussian = Self::gaussian(compositor, sigma).and_then(|graph| {
            graph.bind(sprite)?;
            Ok(graph)
        });
        match gaussian {
            Ok(graph) => Ok(graph),
            Err(error) => {
                diagnostic(format!(
                    "Gaussian unavailable; degraded system-radius backdrop (not 4px): {error}"
                ));
                let mut fallback = Self::empty();
                fallback.source = Some(compositor.CreateHostBackdropBrush()?);
                fallback.bind(sprite)?;
                Ok(fallback)
            }
        }
    }
}
impl Drop for BrushResources {
    fn drop(&mut self) {
        if let Some(effect) = self.effect.take() {
            checked("close Gaussian effect", effect.Close());
        }
        if let Some(factory) = self.factory.take() {
            checked("close Gaussian factory", factory.Close());
        }
        if let Some(source) = self.source.take() {
            checked("close backdrop source", source.Close());
        }
    }
}

fn rectangle(compositor: &Compositor, shape: &Clip) -> WinResult<RectangleClip> {
    let [tl, tr, br, bl] = shape.radii.map(|r| Vector2 {
        X: r as f32,
        Y: r as f32,
    });
    compositor.CreateRectangleClipWithSidesAndRadius(
        0.0,
        0.0,
        shape.width as f32,
        shape.height as f32,
        tl,
        tr,
        br,
        bl,
    )
}
/// The host attribute is optional: older Windows versions may reject it.
/// Report that rejection, then attempt ordinary visuals and brush creation.
/// Return genuine creation errors unchanged; only the optional attribute is best-effort.
fn create_with_host_attribute<T>(
    enable_host_attribute: impl FnOnce() -> WinResult<()>,
    create_layer: impl FnOnce() -> WinResult<T>,
) -> WinResult<T> {
    checked("optional host backdrop attribute", enable_host_attribute());
    create_layer()
}

struct Layer {
    hwnd: isize,
    target: Option<DesktopWindowTarget>,
    sprite: SpriteVisual,
    root: ContainerVisual,
    brush: BrushResources,
    clip: Option<RectangleClip>,
    shape: Clip,
    scale: f64,
}
impl Layer {
    fn new(compositor: &Compositor, geometry: Snapshot, shape: Clip) -> WinResult<Self> {
        physical_sigma(geometry.scale)?;
        create_with_host_attribute(
            || {
                let enabled = BOOL(1);
                unsafe {
                    DwmSetWindowAttribute(
                        HWND(geometry.hwnd as _),
                        DWMWA_USE_HOSTBACKDROPBRUSH,
                        (&enabled as *const BOOL).cast(),
                        size_of::<BOOL>() as u32,
                    )
                }
            },
            || Self::create_visuals(compositor, geometry, shape),
        )
    }
    fn create_visuals(compositor: &Compositor, geometry: Snapshot, shape: Clip) -> WinResult<Self> {
        let sprite = compositor.CreateSpriteVisual()?;
        let root = match compositor.CreateContainerVisual() {
            Ok(root) => root,
            Err(error) => {
                checked("close unparented sprite", sprite.Close());
                return Err(error);
            }
        };
        let mut layer = Self {
            hwnd: geometry.hwnd,
            target: None,
            sprite,
            root,
            brush: BrushResources::empty(),
            clip: None,
            shape: shape.clone(),
            scale: geometry.scale,
        };
        layer.root.Children()?.InsertAtTop(&layer.sprite)?;
        layer.update(compositor, shape, geometry.scale)?;
        let interop: ICompositorDesktopInterop = compositor.cast()?;
        layer.target =
            Some(unsafe { interop.CreateDesktopWindowTarget(HWND(geometry.hwnd as _), false)? });
        if let Some(target) = &layer.target {
            target.SetRoot(&layer.root)?;
        }
        Ok(layer)
    }
    fn update(&mut self, compositor: &Compositor, shape: Clip, scale: f64) -> WinResult<()> {
        let sigma = physical_sigma(scale)?;
        // A degraded brush has no active Gaussian sigma and may retry even at the same size.
        if needs_gaussian(self.brush.sigma, sigma) {
            let replacement = BrushResources::install(compositor, &self.sprite, sigma)?;
            self.brush = replacement; // Close displaced graph only after the new brush is bound.
        }
        if shape == self.shape && scale == self.scale && self.clip.is_some() {
            return Ok(());
        }
        let clip = rectangle(compositor, &shape)?;
        self.root.SetClip(&clip)?;
        self.sprite.SetClip(&clip)?;
        if let Some(old) = self.clip.replace(clip) {
            checked("close replaced clip", old.Close());
        }
        let size = Vector2 {
            X: shape.width as f32,
            Y: shape.height as f32,
        };
        self.root.SetSize(size)?;
        self.sprite.SetSize(size)?;
        self.shape = shape;
        self.scale = scale;
        Ok(())
    }
}
impl Drop for Layer {
    fn drop(&mut self) {
        if let Some(target) = self.target.take() {
            checked("detach root", target.SetRoot(None::<&Visual>));
            checked("close target", target.Close());
        }
        checked(
            "remove backdrop children",
            self.root
                .Children()
                .and_then(|children| children.RemoveAll()),
        );
        checked("close sprite", self.sprite.Close());
        self.brush = BrushResources::empty();
        checked("close backdrop root", self.root.Close());
        if let Some(clip) = self.clip.take() {
            checked("close clip", clip.Close());
        }
    }
}

pub fn begin_shutdown() {
    if let Err(e) = require_ui() {
        diagnostic(e);
        return;
    }
    CLOSING.with(|closing| closing.set(true));
    drain_pending(); // Closing flag prevents all reentrant initialization.
}
pub fn finish_shutdown() {
    if let Err(e) = require_ui() {
        diagnostic(e);
        return;
    }
    begin_shutdown();
    let backend = STATE.with(|s| s.try_borrow_mut().ok().and_then(|mut s| s.take()));
    if let Some(mut backend) = backend {
        backend.finish_shutdown();
    }
}

#[cfg(test)]
mod host_attribute_contract_tests {
    use super::*;
    use windows::core::{Error, HRESULT};

    // DWM can reject an unsupported attribute with E_INVALIDARG; E_NOTIMPL is
    // another unsupported-capability vector. These are injected, not OS probes.
    const UNSUPPORTED: [HRESULT; 2] =
        [HRESULT(0x80070057u32 as i32), HRESULT(0x80004001u32 as i32)];

    #[test]
    fn unsupported_host_attribute_still_creates_ordinary_gaussian_layer() {
        for unsupported in UNSUPPORTED {
            let calls = RefCell::new(Vec::new());
            let result = create_with_host_attribute(
                || {
                    calls.borrow_mut().push("host-attribute");
                    Err(Error::from_hresult(unsupported))
                },
                || {
                    // Stand in for the unchanged ordinary visual / Gaussian path
                    // without constructing any COM object or touching a real HWND.
                    calls.borrow_mut().push("ordinary-layer");
                    calls.borrow_mut().push("gaussian-brush");
                    Ok("gaussian-layer")
                },
            );
            assert_eq!(
                calls.into_inner(),
                ["host-attribute", "ordinary-layer", "gaussian-brush"],
                "unsupported attribute {unsupported:?} must not skip ordinary/Gaussian creation"
            );
            assert_eq!(result.ok(), Some("gaussian-layer"));
        }
    }

    #[test]
    fn supported_host_attribute_preserves_creation_order_and_result() {
        let calls = RefCell::new(Vec::new());
        let result = create_with_host_attribute(
            || {
                calls.borrow_mut().push("host-attribute");
                Ok(())
            },
            || {
                calls.borrow_mut().push("ordinary-layer");
                Ok("layer")
            },
        );
        assert_eq!(calls.into_inner(), ["host-attribute", "ordinary-layer"]);
        assert_eq!(result.ok(), Some("layer"));
    }

    #[test]
    fn genuine_layer_or_brush_creation_errors_are_not_hidden() {
        // Inject failures at the creation closure boundary: E_OUTOFMEMORY for
        // ordinary visuals and E_FAIL for the brush path (including failed fallback).
        for creation_error in [HRESULT(0x8007000Eu32 as i32), HRESULT(0x80004005u32 as i32)] {
            let result = create_with_host_attribute::<()>(
                || Ok(()),
                || Err(Error::from_hresult(creation_error)),
            );
            assert_eq!(
                result.expect_err("creation failure must propagate").code(),
                creation_error
            );
        }
    }

    #[test]
    fn unsupported_host_attribute_does_not_mask_genuine_creation_errors() {
        for unsupported in UNSUPPORTED {
            let creation_error = HRESULT(0x8007000Eu32 as i32);
            let creation_called = Cell::new(false);
            let result = create_with_host_attribute::<()>(
                || Err(Error::from_hresult(unsupported)),
                || {
                    creation_called.set(true);
                    Err(Error::from_hresult(creation_error))
                },
            );
            assert!(
                creation_called.get(),
                "unsupported attribute must not prevent the creation attempt"
            );
            assert_eq!(
                result
                    .expect_err("real creation failure must propagate")
                    .code(),
                creation_error
            );
        }
    }
}

#[cfg(test)]
mod gaussian_contract_tests {
    use super::*;
    #[test]
    fn gaussian_sigma_tracks_logical_four_without_accumulation() {
        for (scale, expected) in [(1.0, 4.0), (1.25, 5.0), (1.5, 6.0), (2.0, 8.0), (1.25, 5.0)] {
            assert_eq!(physical_sigma(scale).unwrap(), expected);
        }
    }
    #[test]
    fn gaussian_sigma_rejects_invalid_or_unrepresentable_scales() {
        for scale in [
            0.0,
            -1.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::MAX,
            f64::MIN_POSITIVE,
        ] {
            assert!(physical_sigma(scale).is_err(), "accepted {scale}");
        }
    }
    #[test]
    fn gaussian_rebuilds_for_dpi_changes_and_degraded_mode() {
        assert!(!needs_gaussian(Some(5.0), 5.0));
        assert!(needs_gaussian(Some(5.0), 6.0));
        assert!(needs_gaussian(None, 5.0));
    }
}
