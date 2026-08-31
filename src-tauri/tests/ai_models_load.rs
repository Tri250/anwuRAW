// =============================================================================
// 离线模型可用性回归测试
// -----------------------------------------------------------------------------
// 目的：在纯本地环境下用 ONNX Runtime 真正加载全部 9 个模型 + clip tokenizer，
//       验证它们不是损坏/不完整的文件。任何模型无法加载都会让本测试失败。
//
// 运行：cargo test --package RapidRAW --test ai_models_load
// 前置：资源已由 scripts/prepare-ai-assets.sh 准备 + build.rs 校验。
// =============================================================================
use std::path::PathBuf;

/// Re-export consistent with app code (`use ort::session::Session;`)
use ort::session::Session;

fn resources_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = /workspace/src-tauri
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    manifest.join("resources")
}

fn models() -> Vec<(&'static str, &'static str)> {
    vec![
        ("sam_vit_b_01ec64_encoder.onnx", "SAM Encoder"),
        ("sam_vit_b_01ec64_decoder.onnx", "SAM Decoder"),
        ("u2net.onnx", "Foreground U2Net"),
        ("skyseg-u2net.onnx", "Sky U2Net"),
        ("depth_anything_v2_vits.onnx", "Depth Anything V2 (vits)"),
        ("nind_denoise_utnet_684.onnx", "NIND UTNet (denoise)"),
        ("clip_model.onnx", "CLIP image embedding"),
        ("lama_fp16.onnx", "LaMa FP16 (inpainting)"),
        ("clip_tokenizer.json", "CLIP tokenizer JSON"),
    ]
}

#[test]
fn all_bundled_models_load_and_are_valid() {
    let rt = ort::init().with_name("ai_models_load_test").commit().unwrap();

    // 让 ort 的 "load-dynamic" 找到本地捆绑的 libonnxruntime.*
    // 由调用方通过 ORT_DYLIB_PATH 指定（见脚本/命令）。
    let ort_lib = if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    };
    assert!(
        resources_dir().join(ort_lib).exists(),
        "Missing bundled ORT native lib {}, run scripts/prepare-ai-assets.sh",
        ort_lib
    );

    let resources = resources_dir();
    let ai_models = resources.join("ai_models");

    for (filename, label) in models() {
        let path = ai_models.join(filename);
        assert!(
            path.exists(),
            "Missing AI model '{}' ({}): {:?} — run bash scripts/prepare-ai-assets.sh",
            filename, label, path
        );
        if filename.ends_with(".onnx") {
            let _session = Session::builder()
                .unwrap()
                .commit_from_file(&path)
                .unwrap_or_else(|e| {
                    panic!("Failed to LOAD {} ({}) ONNX model: {e}", filename, label)
                });
            println!("  ✓ {:<40} (onnx session loaded)", filename);
        } else {
            println!("  ✓ {:<40} (tokenizer, presence only)", filename);
        }
    }

    let _ = rt;
    println!("━━━ All bundled AI models load successfully ✓ ━━━");
}