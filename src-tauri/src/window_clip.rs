//! CSS owns foreground corners; Windows clips only its independent backdrop visual.
use serde::Deserialize;
use tauri::WebviewWindow;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Clip {
    pub width: u32,
    pub height: u32,
    /// Physical, potentially subpixel radii: TL, TR, BR, BL.
    pub radii: [f64; 4],
}

impl Clip {
    pub(crate) fn normalized(mut self) -> Result<Self, String> {
        const MAX: u32 = 1_000_000;
        if self.width == 0 || self.height == 0 || self.width > MAX || self.height > MAX {
            return Err("Invalid surface clip dimensions".into());
        }
        if self
            .radii
            .iter()
            .any(|r| !r.is_finite() || *r < 0.0 || *r > MAX as f64)
        {
            return Err("Invalid surface clip radii".into());
        }
        let limit = self.width.min(self.height) as f64 / 2.0;
        self.radii = self.radii.map(|r| r.min(limit));
        Ok(self)
    }

    /// Keep the native mask in step with native resize/DPI events, before IPC arrives.
    /// A later matching DOM clip supplies the precise dock/fit contour.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn resized(
        &self,
        width: u32,
        height: u32,
        old_scale: f64,
        scale: f64,
    ) -> Result<Self, String> {
        if !old_scale.is_finite() || !scale.is_finite() || old_scale <= 0.0 || scale <= 0.0 {
            return Err("Invalid surface scale factor".into());
        }
        let radii = if width.min(height) as f64 <= 8.0 * scale {
            [0.0; 4] // The narrow auto-hide peek must never inherit the folded curve.
        } else if old_scale == scale {
            self.radii // Moving/folding at the same DPI must not accumulate float drift.
        } else {
            self.radii.map(|r| r * (scale / old_scale))
        };
        Self {
            width,
            height,
            radii,
        }
        .normalized()
    }
}

pub(crate) fn supports(label: &str) -> bool {
    matches!(label, "widget" | "detail")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn may_create_layer(label: &str, closing: bool) -> bool {
    supports(label) && !closing
}

#[derive(Debug, PartialEq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) enum GeometryMatch {
    Current,
    Stale,
    UnexpectedFrame,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn geometry_match(
    clip: &Clip,
    client: (u32, u32),
    outer: (u32, u32),
    visible: bool,
) -> GeometryMatch {
    if visible && client != outer {
        return GeometryMatch::UnexpectedFrame;
    }
    let actual = if visible { client } else { outer };
    if (clip.width, clip.height) == actual {
        GeometryMatch::Current
    } else {
        GeometryMatch::Stale
    }
}

/// Called explicitly on Tauri's UI thread. Never give CSS native corner ownership.
pub fn apply(window: &WebviewWindow, clip: Clip, backdrop: bool) -> Result<(), String> {
    if !supports(window.label()) {
        return Err("Window does not support surface clipping".into());
    }
    let clip = clip.normalized()?;
    #[cfg(target_os = "windows")]
    return crate::windows_backdrop::apply(window, clip, backdrop);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (clip, backdrop);
        Ok(())
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn accepts_fractional_physical_radii_without_dpi_rounding() {
        let clip: Clip =
            serde_json::from_str(r#"{"width":400,"height":200,"radii":[17.5,0.0,13.125,8.75]}"#)
                .expect("CSS radii after fit and DPI must retain subpixel precision");
        assert_eq!(clip.radii.map(f64::from), [17.5, 0.0, 13.125, 8.75]);
    }

    #[test]
    fn normalizes_each_corner_without_rounding_or_rounding_square_docked_edges() {
        let clip = Clip {
            width: 81,
            height: 41,
            radii: [500.0, 17.5, 0.0, 8.75],
        }
        .normalized()
        .unwrap();
        assert_eq!(clip.radii, [20.5, 17.5, 0.0, 8.75]);
        let docked = Clip {
            width: 400,
            height: 80,
            radii: [18.75, 18.75, 0.0, 0.0],
        }
        .normalized()
        .unwrap();
        assert_eq!(docked.radii, [18.75, 18.75, 0.0, 0.0]);
    }

    #[test]
    fn rejects_invalid_dimensions_and_nonfinite_negative_or_unbounded_radii() {
        for (width, height) in [(0, 40), (40, 0), (u32::MAX, 40), (40, 1_000_001)] {
            assert!(Clip {
                width,
                height,
                radii: [0.0; 4]
            }
            .normalized()
            .is_err());
        }
        for radius in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            -0.01,
            1_000_001.0,
        ] {
            assert!(Clip {
                width: 400,
                height: 80,
                radii: [radius; 4]
            }
            .normalized()
            .is_err());
        }
    }

    #[test]
    fn resize_and_dpi_preserve_fractional_asymmetric_contours_and_square_peek() {
        let clip = Clip {
            width: 400,
            height: 200,
            radii: [17.5, 13.125, 0.0, 8.75],
        };
        let scaled = clip.resized(600, 300, 1.25, 1.875).unwrap();
        assert_eq!(scaled.radii, [26.25, 19.6875, 0.0, 13.125]);
        let folded = scaled.resized(400, 21, 1.875, 1.875).unwrap();
        assert_eq!(folded.radii, [10.5, 10.5, 0.0, 10.5]);
        let peek = clip.resized(400, 5, 1.25, 1.25).unwrap();
        assert_eq!(peek.radii, [0.0; 4]);
        assert_eq!(peek.resized(400, 200, 1.25, 1.25).unwrap().radii, [0.0; 4]);
        assert!(clip.resized(400, 200, 0.0, 1.25).is_err());
        let fractional = Clip {
            width: 400,
            height: 200,
            radii: [17.3, 0.1, 13.7, 0.0],
        };
        assert_eq!(
            fractional.resized(400, 200, 1.25, 1.25).unwrap(),
            fractional
        );
    }

    #[test]
    fn hidden_provisional_client_is_allowed_but_shown_frames_and_stale_sizes_are_not() {
        let clip = Clip {
            width: 380,
            height: 260,
            radii: [24.0; 4],
        };
        assert_eq!(
            geometry_match(&clip, (362, 213), (380, 260), false),
            GeometryMatch::Current
        );
        assert_eq!(
            geometry_match(&clip, (380, 260), (380, 260), true),
            GeometryMatch::Current
        );
        assert_eq!(
            geometry_match(&clip, (400, 300), (400, 300), true),
            GeometryMatch::Stale
        );
        assert_eq!(
            geometry_match(&clip, (362, 213), (380, 260), true),
            GeometryMatch::UnexpectedFrame
        );
        assert_eq!(
            geometry_match(&clip, (362, 213), (400, 300), false),
            GeometryMatch::Stale
        );
    }

    #[test]
    fn only_usage_surfaces_can_create_layers_and_never_during_shutdown() {
        for label in ["widget", "detail"] {
            assert!(may_create_layer(label, false));
            assert!(!may_create_layer(label, true));
        }
        for label in ["settings", "overlay", "arbitrary-hwnd", ""] {
            assert!(!may_create_layer(label, false));
        }
    }
}
