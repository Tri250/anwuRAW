//! Shared include of the test-support module.
//!
//! The canonical sources live in `src-tauri/src/testing/` (see the docs in
//! `src/testing/mod.rs`); they are compiled directly into every test binary
//! via `#[path]` so that `lib.rs` does not need to register them.

// The path is relative to this file's directory (`tests/common/`).
#[path = "../../src/testing/mod.rs"]
pub mod testing;
