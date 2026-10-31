//! Deterministic generator for the golden render regression image set.
//!
//! Usage: cargo run --example gen_golden_images -- <output-dir>
//!
//! Writes six fixed test images (16-bit PNG, sRGB display-encoded, like a
//! normal photo import) that stress the render pipeline in known ways:
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
//! The generators live in `rapidraw_lib::golden_fixtures` so the objective
//! metric tests use the exact same bytes.

use std::env;
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let out_dir = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("Usage: gen_golden_images <output-dir>");
        std::process::exit(2);
    });
    match rapidraw_lib::golden_fixtures::write_all(Path::new(&out_dir)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
