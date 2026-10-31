//! Offline WGSL validation for every shader module shipped with the editor.
//!
//! wgpu compiles shaders lazily at pipeline creation, so syntax and typing
//! errors in WGSL only surface at first render on real hardware. These tests
//! parse and validate each module with naga (the same front-end wgpu uses)
//! so shader regressions fail in CI instead.

use naga::valid::{Capabilities, ValidationFlags, Validator};

fn validate(name: &str, source: &str) {
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|e| panic!("{name} failed to parse: {e:?}"));
    Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .unwrap_or_else(|e| panic!("{name} failed validation: {e:?}"));
    assert!(
        !module.entry_points.is_empty(),
        "{name} declares no entry points"
    );
}

#[test]
fn validate_all_shader_modules() {
    validate("shader.wgsl", include_str!("../src/shaders/shader.wgsl"));
    validate("bloom.wgsl", include_str!("../src/shaders/bloom.wgsl"));
    validate("blur.wgsl", include_str!("../src/shaders/blur.wgsl"));
    validate("display.wgsl", include_str!("../src/shaders/display.wgsl"));
    validate("flare.wgsl", include_str!("../src/shaders/flare.wgsl"));
    validate("guided.wgsl", include_str!("../src/shaders/guided.wgsl"));
}
