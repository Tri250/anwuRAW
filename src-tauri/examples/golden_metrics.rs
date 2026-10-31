//! Perceptual comparison CLI for the golden render regression harness.
//!
//! Usage:
//!   cargo run --example golden_metrics -- <reference> <candidate> [--stride N]
//!   cargo run --example golden_metrics -- convert <input> <output.png>
//!
//! Compare mode prints a single-line JSON report (mean/p95/p99/max ΔE2000,
//! PSNR at 16-bit peak, SSIM on 8-bit luminance) to stdout. Convert mode
//! re-encodes any decodable image as a 16-bit PNG so golden baselines stay
//! compact. Exit status: 0 on success, 1 on decode/dimension errors, 2 on
//! usage errors. Threshold interpretation lives in run-golden.mjs.

use std::env;
use std::process::ExitCode;

fn print_usage() {
    eprintln!("Usage:");
    eprintln!("  golden_metrics <reference> <candidate> [--stride N]");
    eprintln!("  golden_metrics convert <input> <output.png>");
}

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let first = match args.next() {
        Some(arg) => arg,
        None => {
            print_usage();
            return ExitCode::from(2);
        }
    };

    if first == "convert" {
        let (Some(input), Some(output)) = (args.next(), args.next()) else {
            print_usage();
            return ExitCode::from(2);
        };
        return match rapidraw_lib::load_rgb16(std::path::Path::new(&input)) {
            Ok(img) => match img.save(&output) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("Failed to write {output}: {e}");
                    ExitCode::FAILURE
                }
            },
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    }

    let mut reference = Some(first);
    let mut candidate: Option<String> = None;
    let mut stride: u32 = 1;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--stride" => {
                let Some(value) = args.next() else {
                    eprintln!("Missing value for --stride");
                    return ExitCode::from(2);
                };
                stride = value.parse().unwrap_or(1);
            }
            s if !s.starts_with('-') => {
                if candidate.is_none() {
                    candidate = Some(s.to_string());
                } else {
                    eprintln!("Unexpected argument: {s}");
                    return ExitCode::from(2);
                }
            }
            s => {
                eprintln!("Unknown option: {s}");
                return ExitCode::from(2);
            }
        }
    }

    let (Some(reference), Some(candidate)) = (reference.take(), candidate) else {
        print_usage();
        return ExitCode::from(2);
    };

    match rapidraw_lib::compare_files(
        std::path::Path::new(&reference),
        std::path::Path::new(&candidate),
        stride,
    ) {
        Ok(report) => {
            println!(
                "{{\"pixels_compared\":{},\"mean_delta_e\":{:.4},\"p95_delta_e\":{:.4},\"p99_delta_e\":{:.4},\"max_delta_e\":{:.4},\"psnr\":{},\"ssim\":{:.6}}}",
                report.pixels_compared,
                report.mean_delta_e,
                report.p95_delta_e,
                report.p99_delta_e,
                report.max_delta_e,
                if report.psnr.is_infinite() {
                    "null".to_string()
                } else {
                    format!("{:.4}", report.psnr)
                },
                report.ssim,
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
