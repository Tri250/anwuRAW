//! Test-support modules for the M0 test foundation (plan §6, M0-1..M0-4).
//!
//! This module is intentionally NOT registered in `lib.rs`. The integration
//! tests in `src-tauri/tests/` compile it directly via `#[path]`:
//!
//! ```ignore
//! #[path = "../src/testing/mod.rs"]
//! mod testing;
//! ```
//!
//! That keeps the production library surface untouched while giving every test
//! binary access to the objective metrics and the reference CPU harness. If
//! runtime code ever needs these helpers, register the module with a single
//! `pub mod testing;` line in `lib.rs`.
//!
//! Contents:
//! - [`metrics`]: PSNR, SSIM, max-delta, CIEDE2000, gradient energy and
//!   blake3 content hashes used by golden/consistency tests and CI gates.
//! - [`harness`]: a deterministic, pure-CPU reference pipeline (synthetic
//!   scenes, point ops, USM, cubic-Hermite curves, Lanczos3 resampler and
//!   tetrahedral LUT interpolation) that mirrors the corresponding WGSL
//!   stages. It is the cross-check oracle for future GPU-side changes.

// Each integration-test binary includes this module via `#[path]` and uses a
// different subset of the helpers; dead_code would otherwise fire per binary.
#![allow(dead_code)]

pub mod harness;
pub mod metrics;
