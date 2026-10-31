//! Deterministic generator for the golden render regression image set.
//!
//! Six fixed test images (16-bit, sRGB display-encoded, like a normal photo
//! import) that stress the render pipeline in known ways:
//!
//! | file               | stresses                                            |
//! |--------------------|-----------------------------------------------------|
//! | colorchecker.png   | 24-patch chart: color accuracy, ΔE2000              |
//! | gray-ramp.png      | 14-step ramp + 64-step ramp + smooth gradient: tone |
//! | edge-contrast.png  | step/diagonal edges, square waves, freq sweep: USM  |
//! | sky-backlit.png    | sun disk, sky gradient, dark ridge: highlight comp  |
//! | portrait.png       | smooth skin gradients, features: NR/clarity/grain   |
//! | iso-noise.png      | clean + ISO400/1600/6400 noisy flats: denoise       |
//!
//! All content is generated analytically or from a self-contained SplitMix64
//! PRNG (no rand crate), so regenerating on any machine yields byte-identical
//! fixtures. The `gen_golden_images` example writes them to disk; the
//! objective-metric tests use the same generators in memory.

use image::{ImageBuffer, Rgb};
use std::fs;
use std::path::Path;

/// 16-bit RGB image type (the image crate 0.25 has no alias for this).
pub type Rgb16Image = ImageBuffer<Rgb<u16>, Vec<u16>>;

/// Self-contained SplitMix64 PRNG so fixtures never drift with rand versions.
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / ((1u64 << 24) as f32)
    }

    /// Standard normal via Box-Muller.
    fn gaussian(&mut self) -> f32 {
        let u1 = self.next_f32().max(1e-7);
        let u2 = self.next_f32();
        (-2.0 * u1.ln()).sqrt() * (std::f32::consts::TAU * u2).cos()
    }
}

/// Display-encoded [0,1] -> 16-bit code value.
fn enc(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * 65535.0).round() as u16
}

fn enc_rgb(rgb: [f32; 3]) -> Rgb<u16> {
    Rgb([enc(rgb[0]), enc(rgb[1]), enc(rgb[2])])
}

/// Linear-light interpolation between two sRGB triplets (photos behave this
/// way in practice; keeps gradients free of hue shifts).
fn mix_srgb(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 24-patch ColorChecker Classic (BabelColor sRGB averages, 0..1).
pub const COLORCHECKER: [[f32; 3]; 24] = [
    [0.451, 0.322, 0.267], // dark skin
    [0.761, 0.588, 0.510], // light skin
    [0.384, 0.478, 0.616], // blue sky
    [0.341, 0.424, 0.263], // foliage
    [0.522, 0.502, 0.694], // blue flower
    [0.404, 0.741, 0.667], // bluish green
    [0.839, 0.494, 0.173], // orange
    [0.314, 0.357, 0.651], // purple red
    [0.757, 0.353, 0.388], // moderate red
    [0.369, 0.235, 0.424], // purple
    [0.616, 0.737, 0.251], // yellow green
    [0.878, 0.639, 0.180], // orange yellow
    [0.220, 0.239, 0.588], // blue
    [0.275, 0.580, 0.286], // green
    [0.686, 0.212, 0.235], // red
    [0.906, 0.780, 0.122], // yellow
    [0.733, 0.337, 0.584], // magenta
    [0.031, 0.522, 0.631], // cyan
    [0.953, 0.953, 0.949], // white
    [0.784, 0.784, 0.784], // neutral 8
    [0.627, 0.627, 0.627], // neutral 6.5
    [0.478, 0.478, 0.475], // neutral 5
    [0.333, 0.333, 0.333], // neutral 3.5
    [0.204, 0.204, 0.204], // black
];

fn gen_colorchecker() -> Rgb16Image {
    // 6x4 patches of 96px with 16px gutters inside a 32px 20%-gray surround.
    let (pw, ph, gut, pad) = (96usize, 96usize, 16usize, 32usize);
    let w = 6 * pw + 5 * gut + 2 * pad;
    let h = 4 * ph + 3 * gut + 2 * pad;
    let mut img = Rgb16Image::from_pixel(w as u32, h as u32, enc_rgb([0.2, 0.2, 0.2]));
    for row in 0..4 {
        for col in 0..6 {
            let patch = COLORCHECKER[row * 6 + col];
            let x0 = pad + col * (pw + gut);
            let y0 = pad + row * (ph + gut);
            for y in y0..y0 + ph {
                for x in x0..x0 + pw {
                    img.put_pixel(x as u32, y as u32, enc_rgb(patch));
                }
            }
        }
    }
    img
}

fn gen_gray_ramp() -> Rgb16Image {
    // 896x256: 14-step ramp on top, 64-step ramp in the middle, smooth
    // gradient at the bottom (8-bit banding detector).
    let (w, h) = (896u32, 256u32);
    let mut img = Rgb16Image::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let v = if y < 128 {
                // 14 discrete levels, 64px per step.
                let step = (x / 64).min(13);
                step as f32 / 13.0
            } else if y < 176 {
                // 64 steps, 14px per step.
                let step = (x / 14).min(63);
                step as f32 / 63.0
            } else {
                // Continuous ramp across the full width.
                x as f32 / (w - 1) as f32
            };
            img.put_pixel(x, y, enc_rgb([v, v, v]));
        }
    }
    img
}

fn gen_edge_contrast() -> Rgb16Image {
    // 1024x512 in four 512x256 quadrants.
    let (w, h) = (1024u32, 512u32);
    let mut img = Rgb16Image::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (qx, qy) = (x % 512, y % 256);
            let v = match (x < 512, y < 256) {
                // Q1: vertical step edge.
                (true, true) => {
                    if qx < 256 {
                        0.0
                    } else {
                        1.0
                    }
                }
                // Q2: 45-degree step edge plus an isolated white pixel on gray.
                (false, true) => {
                    if (qx + qy) < 256 {
                        0.0
                    } else if qx == 380 && qy == 40 {
                        1.0
                    } else {
                        0.5
                    }
                }
                // Q3: square-wave bars, 32px period.
                (true, false) => {
                    if (qx / 16) % 2 == 0 {
                        0.0
                    } else {
                        1.0
                    }
                }
                // Q4: radial frequency sweep (ring frequency grows with radius).
                (false, false) => {
                    let cx = qx as f32 - 256.0;
                    let cy = qy as f32 - 128.0;
                    let r = (cx * cx + cy * cy).sqrt();
                    let freq = 0.02 + 0.10 * (r / 180.0).min(1.0);
                    (0.5 + 0.5 * (std::f32::consts::TAU * freq * r).sin()).clamp(0.0, 1.0)
                }
            };
            img.put_pixel(x, y, enc_rgb([v, v, v]));
        }
    }
    img
}

fn gen_sky_backlit() -> Rgb16Image {
    // 1024x512: sky gradient with sun disk and cloud bands, dark ridge below.
    let (w, h) = (1024u32, 512u32);
    let horizon = 340.0f32;
    let zenith = [0.07, 0.20, 0.47];
    let horizon_col = [0.93, 0.89, 0.82];
    let (sun_x, sun_y, sun_r) = (700.0f32, 120.0f32, 55.0f32);
    let mut img = Rgb16Image::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let fx = x as f32;
            let fy = y as f32;
            // Ridge silhouette (drawn over the sky).
            let ridge = horizon
                + 60.0
                + 40.0 * (fx * 0.020).sin()
                + 25.0 * (fx * 0.055 + 1.3).sin()
                + 12.0 * (fx * 0.011 + 0.4).sin();
            let mut col = if fy < ridge {
                let t = (fy / horizon).clamp(0.0, 1.0);
                let mut c = mix_srgb(zenith, horizon_col, t);
                // Sun disk + aureole.
                let dx = fx - sun_x;
                let dy = fy - sun_y;
                let r = (dx * dx + dy * dy).sqrt();
                if r <= sun_r {
                    c = [1.0, 0.98, 0.88];
                } else {
                    let glow = 0.35 * (-((r - sun_r) / 45.0)).exp();
                    c = [
                        c[0] + (1.0 - c[0]) * glow,
                        c[1] + (0.97 - c[1]) * glow,
                        c[2] + (0.80 - c[2]) * glow,
                    ];
                }
                // Cloud bands: low-amplitude deterministic sine striations.
                let band = 0.05
                    * (fy * 0.045 + 1.7).sin()
                    * (0.5 + 0.5 * (fy * 0.012).cos())
                    * (0.5 + 0.5 * (fx * 0.006 + 0.9).sin());
                c = [
                    c[0] + band,
                    c[1] + band * 0.98,
                    c[2] + band * 0.9,
                ];
                c
            } else {
                // Mountain body with a lighter 2px rim along the ridge.
                let rim = smoothstep(ridge, ridge + 2.0, fy) < 1.0 && fy - ridge < 2.0;
                if rim {
                    [0.24, 0.26, 0.30]
                } else {
                    // Slight shading toward the bottom of the silhouette.
                    let d = ((fy - ridge) / (h as f32 - ridge)).clamp(0.0, 1.0);
                    mix_srgb([0.045, 0.052, 0.062], [0.012, 0.015, 0.020], d)
                }
            };
            col[0] = col[0].clamp(0.0, 1.0);
            col[1] = col[1].clamp(0.0, 1.0);
            col[2] = col[2].clamp(0.0, 1.0);
            img.put_pixel(x, y, enc_rgb(col));
        }
    }
    img
}

/// Point-in-ellipse with soft edge (feather in pixels).
fn ellipse_alpha(x: f32, y: f32, cx: f32, cy: f32, rx: f32, ry: f32, feather: f32) -> f32 {
    let d = (((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2)).sqrt();
    1.0 - smoothstep(1.0 - feather / rx.min(ry), 1.0, d)
}

fn gen_portrait() -> Rgb16Image {
    // 640x896 synthetic portrait: smooth skin gradients + features + faint
    // texture so denoise/clarity/grain have something to act on.
    let (w, h) = (640u32, 896u32);
    let mut img = Rgb16Image::new(w, h);
    let mut tex = SplitMix64::new(0x506F_7274);
    let skin = [0.878, 0.729, 0.604];
    let skin_shadow = [0.72, 0.56, 0.46];
    let hair = [0.227, 0.157, 0.118];
    let cloth = [0.173, 0.204, 0.282];

    for y in 0..h {
        for x in 0..w {
            let fx = x as f32;
            let fy = y as f32;

            // Background: vertical gradient.
            let mut col = mix_srgb([0.204, 0.227, 0.290], [0.133, 0.149, 0.196], fy / h as f32);

            // Torso / shoulders (rounded slab at the bottom).
            let torso = ellipse_alpha(fx, fy, 320.0, 1010.0, 300.0, 430.0, 8.0);
            if torso > 0.0 {
                let fold = 0.03 * ((fx * 0.03).sin() * (fy * 0.01 + 0.5).cos());
                let c = [
                    cloth[0] + fold,
                    cloth[1] + fold,
                    cloth[2] + fold,
                ];
                col = mix_srgb(col, c, torso);
            }

            // Neck.
            let neck = ellipse_alpha(fx, fy, 320.0, 640.0, 78.0, 130.0, 4.0);
            if neck > 0.0 {
                col = mix_srgb(col, skin_shadow, neck * 0.85);
            }

            // Head.
            let head = ellipse_alpha(fx, fy, 320.0, 380.0, 150.0, 190.0, 3.0);
            if head > 0.0 {
                // Key light from the left, falloff to the right.
                let light = 1.0 - 0.22 * ((fx - 170.0) / 300.0).clamp(0.0, 1.0);
                let mut c = [skin[0] * light, skin[1] * light, skin[2] * light];
                // Cheek blush.
                let blush = 0.5
                    * ellipse_alpha(fx, fy, 240.0, 430.0, 70.0, 50.0, 40.0)
                    + 0.5 * ellipse_alpha(fx, fy, 400.0, 430.0, 70.0, 50.0, 40.0);
                c[0] += 0.03 * blush;
                c[2] -= 0.02 * blush;
                // Forehead highlight.
                let hi = ellipse_alpha(fx, fy, 260.0, 270.0, 90.0, 50.0, 30.0);
                c = [
                    c[0] + 0.04 * hi,
                    c[1] + 0.035 * hi,
                    c[2] + 0.03 * hi,
                ];
                // Nose shading.
                let nose = ellipse_alpha(fx, fy, 320.0, 415.0, 26.0, 70.0, 20.0);
                c = [
                    c[0] - 0.03 * nose,
                    c[1] - 0.025 * nose,
                    c[2] - 0.02 * nose,
                ];
                // Lips.
                let lips = ellipse_alpha(fx, fy, 320.0, 500.0, 46.0, 16.0, 6.0);
                c = mix_srgb(c, [0.769, 0.471, 0.424], lips * 0.9);
                let lip_line = (ellipse_alpha(fx, fy, 320.0, 500.0, 46.0, 3.0, 2.0)
                    - ellipse_alpha(fx, fy, 320.0, 500.0, 46.0, 1.5, 2.0))
                .max(0.0);
                c = mix_srgb(c, [0.55, 0.28, 0.26], lip_line);
                col = mix_srgb(col, c, head);
            }

            // Eyes.
            for &(ex, _) in &[(255.0f32, 0.0), (385.0f32, 0.0)] {
                let sclera = ellipse_alpha(fx, fy, ex, 340.0, 34.0, 16.0, 3.0);
                if sclera > 0.0 {
                    col = mix_srgb(col, [0.925, 0.925, 0.933], sclera);
                }
                let iris = ellipse_alpha(fx, fy, ex, 340.0, 15.0, 15.0, 2.0);
                if iris > 0.0 {
                    col = mix_srgb(col, [0.376, 0.259, 0.173], iris);
                }
                let pupil = ellipse_alpha(fx, fy, ex, 340.0, 6.0, 6.0, 1.5);
                if pupil > 0.0 {
                    col = mix_srgb(col, [0.02, 0.02, 0.025], pupil);
                }
                // Upper lid shadow.
                let lid = ellipse_alpha(fx, fy, ex, 326.0, 36.0, 7.0, 4.0);
                col = mix_srgb(col, skin_shadow, lid * 0.5);
                // Eyebrow.
                let brow = ellipse_alpha(fx, fy, ex, 292.0, 40.0, 8.0, 4.0);
                col = mix_srgb(col, hair, brow * 0.9);
            }

            // Hair: cap plus side lobes.
            let cap = ellipse_alpha(fx, fy, 320.0, 250.0, 168.0, 140.0, 6.0);
            let side = 0.6 * ellipse_alpha(fx, fy, 172.0, 430.0, 40.0, 150.0, 20.0)
                + 0.6 * ellipse_alpha(fx, fy, 468.0, 430.0, 40.0, 150.0, 20.0);
            let hair_a = (cap + side).clamp(0.0, 1.0);
            if hair_a > 0.0 {
                // Strand variation.
                let strand = 0.04 * ((fx * 0.35 + fy * 0.05).sin() * (fy * 0.02).cos());
                let c = [
                    hair[0] + strand,
                    hair[1] + strand * 0.9,
                    hair[2] + strand * 0.8,
                ];
                col = mix_srgb(col, c, hair_a);
            }

            // Faint deterministic texture over skin/hair areas only.
            if head > 0.0 || hair_a > 0.0 {
                let n = tex.gaussian() * 1.2 / 65535.0;
                col = [col[0] + n, col[1] + n, col[2] + n];
            }

            col[0] = col[0].clamp(0.0, 1.0);
            col[1] = col[1].clamp(0.0, 1.0);
            col[2] = col[2].clamp(0.0, 1.0);
            img.put_pixel(x, y, enc_rgb(col));
        }
    }
    img
}

fn gen_iso_noise() -> Rgb16Image {
    // 1024x256: four 256px-wide patches on a mid-gray field:
    // clean 18% gray, then ISO 400 / 1600 / 6400 noise in linear light with
    // per-channel sigma (chroma noise), separated by 2px dark gutters.
    let (w, h) = (1024u32, 256u32);
    let base = 0.1845f32; // 18% gray in sRGB code space
    let sigmas = [0.0f32, 0.002, 0.004, 0.008];
    let channel_scale = [1.0f32, 0.85, 1.25];
    let mut img = Rgb16Image::new(w, h);
    let mut rng = SplitMix64::new(0x150_405E);
    let srgb_to_linear = |c: f32| -> f32 {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let linear_to_srgb = |v: f32| -> f32 {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.0031308 {
            v * 12.92
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        }
    };
    for y in 0..h {
        for x in 0..w {
            let patch = (x / 256).min(3) as usize;
            let in_gutter = x % 256 < 2;
            let col = if in_gutter {
                [0.08, 0.08, 0.08]
            } else {
                let lin = srgb_to_linear(base);
                let sigma = sigmas[patch];
                let mut out = [0.0f32; 3];
                for c in 0..3 {
                    // One draw per channel: shot+read noise (sigma scales with
                    // signal) with a per-channel gain so color noise exists.
                    let n = if sigma > 0.0 {
                        rng.gaussian() * sigma * channel_scale[c]
                            + rng.gaussian() * sigma * 0.3
                    } else {
                        0.0
                    };
                    out[c] = linear_to_srgb(lin + n);
                }
                out
            };
            img.put_pixel(x, y, enc_rgb(col));
        }
    }
    img
}

/// File names of the fixed image set, in generation order.
pub const FILE_NAMES: [&str; 6] = [
    "colorchecker.png",
    "gray-ramp.png",
    "edge-contrast.png",
    "sky-backlit.png",
    "portrait.png",
    "iso-noise.png",
];

/// Generate all six fixtures in memory (deterministic; no disk access).
pub fn fixtures() -> Vec<(&'static str, Rgb16Image)> {
    vec![
        ("colorchecker.png", gen_colorchecker()),
        ("gray-ramp.png", gen_gray_ramp()),
        ("edge-contrast.png", gen_edge_contrast()),
        ("sky-backlit.png", gen_sky_backlit()),
        ("portrait.png", gen_portrait()),
        ("iso-noise.png", gen_iso_noise()),
    ]
}

/// Generate all six fixtures and write them as 16-bit PNGs into `dir`.
pub fn write_all(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    for (name, img) in fixtures() {
        let path = dir.join(name);
        img.save(&path)
            .map_err(|e| std::io::Error::other(format!("Failed to write {}: {}", path.display(), e)))?;
        println!("{} ({}x{})", path.display(), img.width(), img.height());
    }
    Ok(())
}
