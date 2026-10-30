//! Update the popup rectangle in one native transaction on Windows.
//! Moving before resizing can briefly put the old, taller popup over the widget.
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Bounds {
    fn validate(self, label: &str) -> Result<Self, String> {
        self.validate_for(label, "detail")
    }

    /// Valida que quien llama sea la ventana del widget y que el rectángulo sea
    /// utilizable (no cero, acotado y sin desbordamiento). Reutilizable desde
    /// cualquier ruta de colocación, antes de tocar la superficie nativa.
    pub fn validate_widget(self, label: &str) -> Result<Self, String> {
        self.validate_for(label, "widget")
    }

    fn validate_for(self, label: &str, expected: &str) -> Result<Self, String> {
        if label != expected {
            return Err("Only the calling usage window can update its own bounds".into());
        }
        if self.w == 0
            || self.h == 0
            || self.w > 1_000_000
            || self.h > 1_000_000
            || self.x.checked_add(self.w as i32).is_none()
            || self.y.checked_add(self.h as i32).is_none()
        {
            return Err("Invalid detail window bounds".into());
        }
        Ok(self)
    }
}

/// Called on Tauri's UI thread; no caller-supplied HWND, focus or z-order changes.
pub fn apply(window: &WebviewWindow, bounds: Bounds) -> Result<(), String> {
    apply_native(window, bounds.validate(window.label())?)
}

pub fn apply_widget(window: &WebviewWindow, bounds: Bounds) -> Result<(), String> {
    apply_native(window, bounds.validate_for(window.label(), "widget")?)
}

fn apply_native(window: &WebviewWindow, bounds: Bounds) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
        };
        let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _);
        // SAFETY: HWND comes from the calling Tauri window, dimensions are checked,
        // and the call runs on its UI thread. One operation changes both axes and size.
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                bounds.x,
                bounds.y,
                bounds.w as i32,
                bounds.h as i32,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER,
            )
        }
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Keep the existing Tauri path on platforms without Win32.
        window
            .set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(bounds.w, bounds.h))
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds() -> Bounds {
        Bounds {
            x: 3521,
            y: 569,
            w: 326,
            h: 464,
        }
    }

    #[test]
    fn widget_handle_bounds_are_small_but_cannot_be_applied_by_other_windows() {
        let b = Bounds {
            x: -500,
            y: 1080,
            w: 48,
            h: 24,
        };
        assert!(b.validate_for("widget", "widget").is_ok());
        for label in ["detail", "settings", "overlay", ""] {
            assert!(b.validate_for(label, "widget").is_err());
        }
        assert!(b.validate("widget").is_err()); // The popup route remains detail-only.
    }

    #[test]
    fn accepts_the_complete_rect_from_the_hover_regression() {
        let b = bounds().validate("detail").unwrap();
        // The trace had a stale 740px height here: bottom=1309 covered the widget.
        assert_eq!(b.y + b.h as i32, 1033);
        assert!(b.y + (b.h as i32) < 1041);
    }

    #[test]
    fn permits_negative_monitor_coordinates_and_fractional_dpi_rounded_pixels() {
        Bounds {
            x: -1920,
            y: -100,
            w: 408,
            h: 581,
        }
        .validate("detail")
        .unwrap();
    }

    #[test]
    fn rejects_other_windows_and_invalid_dimensions() {
        for label in ["widget", "settings", "overlay", ""] {
            assert!(bounds().validate(label).is_err());
        }
        for (w, h) in [(0, 40), (40, 0), (1_000_001, 40), (40, u32::MAX)] {
            assert!(Bounds { w, h, ..bounds() }.validate("detail").is_err());
        }
    }

    #[test]
    fn rejects_coordinate_overflow_before_entering_win32() {
        assert!(Bounds {
            x: i32::MAX,
            ..bounds()
        }
        .validate("detail")
        .is_err());
        assert!(Bounds {
            y: i32::MAX,
            ..bounds()
        }
        .validate("detail")
        .is_err());
    }
}
