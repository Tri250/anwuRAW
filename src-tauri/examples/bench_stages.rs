//! Stage-timing performance benchmark CLI (v2.0 plan M0-4).
//!
//! Usage:
//!   RAPIDRAW_STAGE_TIMING=1 WGPU_BACKEND=Vulkan \
//!     cargo run --release --example bench_stages -- --out bench/perf/run.json \
//!     [--iterations N] [--preview WxH] [--export WxH]
//!
//! Runs the real GPU pipeline headless over a deterministic synthetic scene:
//! 1080p preview frames (cold + steady state, P50/P95 wall clock) and a
//! 45MP 16-bit export with peak-RSS accounting, plus per-stage GPU timings
//! from the wgpu timestamp probe. Writes a JSON report for
//! `bench/perf/compare-perf.mjs` and prints a human-readable summary.
//! Exit status: 0 on success, 1 on failure, 2 on usage errors.

use std::process::ExitCode;

use rapidraw_lib::perf_bench::{BenchConfig, run, format_summary, write_report};

fn print_usage() {
    eprintln!("Usage: bench_stages [--out PATH] [--iterations N] [--preview WxH] [--export WxH]");
}

fn parse_dims(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

fn main() -> ExitCode {
    let mut config = BenchConfig::default();
    let mut out = String::from("bench/perf/report.json");
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => match args.next() {
                Some(v) => out = v,
                None => {
                    eprintln!("Missing value for --out");
                    return ExitCode::from(2);
                }
            },
            "--iterations" => match args.next().and_then(|v| v.parse::<u32>().ok()) {
                Some(v) if v >= 2 => config.preview_iterations = v,
                _ => {
                    eprintln!("--iterations needs an integer >= 2");
                    return ExitCode::from(2);
                }
            },
            "--preview" => match args.next().as_deref().and_then(parse_dims) {
                Some((w, h)) if w > 0 && h > 0 => {
                    config.preview_width = w;
                    config.preview_height = h;
                }
                _ => {
                    eprintln!("--preview needs WxH (e.g. 1920x1080)");
                    return ExitCode::from(2);
                }
            },
            "--export" => match args.next().as_deref().and_then(parse_dims) {
                Some((w, h)) if w > 0 && h > 0 => {
                    config.export_width = w;
                    config.export_height = h;
                }
                _ => {
                    eprintln!("--export needs WxH (e.g. 9000x5000)");
                    return ExitCode::from(2);
                }
            },
            "--help" | "-h" => {
                print_usage();
                return ExitCode::SUCCESS;
            }
            s => {
                eprintln!("Unknown option: {s}");
                print_usage();
                return ExitCode::from(2);
            }
        }
    }

    match run(&config) {
        Ok(report) => {
            println!("{}", format_summary(&report));
            match write_report(&report, std::path::Path::new(&out)) {
                Ok(()) => {
                    println!("report written to {out}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("failed to write {out}: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
