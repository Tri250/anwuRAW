// =============================================================================
// RapidRAW build script — 纯离线校验模式
// -----------------------------------------------------------------------------
// 本文件只做两件事：
//   1. 校验 ONNX Runtime native 库已经放在 src-tauri/resources/ 下
//      （平台相关的 .so/.dylib/.dll，带 SHA256 校验）
//   2. 校验 9 个 AI 模型已经放在 src-tauri/resources/ai_models/ 下
//      （全部 SHA256 校验）
//   3. 校验失败 → panic 并提示跑 scripts/prepare-ai-assets.sh
//
// ✗ 不再做任何网络下载 —— 所有 AI 资产都在构建前离线准备好
//   （CI 里跑一次 prepare 脚本 + 缓存，release build 全程离线）
//
// 前置准备：
//   bash scripts/prepare-ai-assets.sh
// =============================================================================
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

fn verify_sha256(path: &PathBuf, expected_hash: &str) -> Result<bool, std::io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    let hash_bytes = hasher.finalize();
    let calculated = hex::encode(hash_bytes);
    Ok(calculated == expected_hash)
}

fn check_file(path: &PathBuf, expected_hash: &str, label: &str) {
    if !path.exists() {
        panic!(
            "━━━ AI ASSET MISSING ━━━\n  Expected : {:?}\n  Purpose  : {}\n  Fix      : bash scripts/prepare-ai-assets.sh\n━━━━━━━━━━━━━━━━━━━━━━━━━",
            path, label
        );
    }
    match verify_sha256(path, expected_hash) {
        Ok(true) => { /* ok */ }
        Ok(false) => panic!(
            "━━━ AI ASSET CORRUPTED ━━━\n  Found   : {:?}\n  Purpose : {}\n  Reason  : SHA256 mismatch\n  Fix     : rm -f {:?}\n            bash scripts/prepare-ai-assets.sh\n━━━━━━━━━━━━━━━━━━━━━━━━━━",
            path, label, path
        ),
        Err(e) => panic!(
            "━━━ AI ASSET READ ERROR ━━━\n  File   : {:?}\n  Purpose: {}\n  Error  : {}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            path, label, e
        ),
    }
}

fn check_file_optional_hash(path: &PathBuf, label: &str) {
    if !path.exists() {
        panic!(
            "━━━ AI ASSET MISSING ━━━\n  Expected : {:?}\n  Purpose  : {}\n  Fix      : bash scripts/prepare-ai-assets.sh\n━━━━━━━━━━━━━━━━━━━━━━━━━",
            path, label
        );
    }
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let resources_dir = manifest_dir.join("resources");
    let ai_models_dir = resources_dir.join("ai_models");

    // ── 1. ONNX Runtime native 库 ───────────────────────────────────────
    let (ort_filename, ort_lib_name, ort_hash) = match (target_os.as_str(), target_arch.as_str()) {
        ("windows", "x86_64") => (
            "onnxruntime-windows-x86_64.dll",
            "onnxruntime.dll",
            "579b636403983254346a5c1d80bd28f1519cd1e284cd204f8d4ff41f8d711559",
        ),
        ("windows", "aarch64") => (
            "onnxruntime-windows-aarch64.dll",
            "onnxruntime.dll",
            "79281671a386ed1baab9dbdbb09fe55f99577011472e9526cf9d0b468bb6bcc7",
        ),
        ("linux", "x86_64") => (
            "libonnxruntime-linux-x86_64.so",
            "libonnxruntime.so",
            "3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673",
        ),
        ("linux", "aarch64") => (
            "libonnxruntime-linux-aarch64.so",
            "libonnxruntime.so",
            "0afd69a0ae38c5099fd0e8604dda398ac43dee67cd9c6394b5142b19e82528de",
        ),
        ("macos", "x86_64") => (
            "libonnxruntime-macos-x86_64.dylib",
            "libonnxruntime.dylib",
            "283e595e61cf65df7a6b1d59a1616cbd35c8b6399dd90d799d99b71a3ff83160",
        ),
        ("macos", "aarch64") => (
            "libonnxruntime-macos-aarch64.dylib",
            "libonnxruntime.dylib",
            "2b885992d3d6fa4130d39ec84a80d7504ff52750027c547bb22c86165f19406a",
        ),
        ("android", "aarch64") => (
            "libonnxruntime-android-arm64-v8a.so",
            "libonnxruntime.so",
            "999ecfdb5b5a13e4097487773b6d71ce8a075408a237daab072e8f5e817bd78e",
        ),
        _ => panic!("Unsupported target: {}-{}", target_os, target_arch),
    };

    let ort_path = resources_dir.join(ort_lib_name);
    println!(
        "cargo:warning=[AI assets] Checking ONNX Runtime ({}) at {:?}",
        ort_filename, ort_path
    );
    check_file(&ort_path, ort_hash, &format!("ONNX Runtime native for {}-{}", target_os, target_arch));

    // Android: 额外拷贝到 jniLibs
    if target_os == "android" {
        let jni_libs_dir = manifest_dir.join("gen/android/app/src/main/jniLibs/arm64-v8a");
        fs::create_dir_all(&jni_libs_dir).unwrap();
        let jni_dest = jni_libs_dir.join(ort_lib_name);
        if !jni_dest.exists() || fs::metadata(&jni_dest).unwrap().len() != fs::metadata(&ort_path).unwrap().len() {
            fs::copy(&ort_path, &jni_dest).unwrap();
            println!("cargo:warning=[AI assets] Copied ORT to jniLibs: {:?}", jni_dest);
        }

        println!("cargo:rustc-env=ORT_LIB_LOCATION={}", resources_dir.display());
        println!("cargo:rustc-env=ORT_STRATEGY=manual");
        println!("cargo:rustc-link-search=native={}", resources_dir.display());
    }

    // ── 2. 9 个 AI 模型 ──────────────────────────────────────────────────
    println!("cargo:warning=[AI assets] Checking {} AI models in {:?}...", 9, ai_models_dir);

    fs::create_dir_all(&ai_models_dir).unwrap();

    let models: &[(&str, &str, &str)] = &[
        ("sam_vit_b_01ec64_encoder.onnx",    "16ab73d9c824886f0de2938c19df22fb9ec3deebfd0de58e65177e479213d7d1", "SAM subject mask encoder"),
        ("sam_vit_b_01ec64_decoder.onnx",    "85d0d672cf5b7fe763edcde429e5533e62f674af4b15c7d688b7673b0ef00bf7", "SAM subject mask decoder"),
        ("u2net.onnx",                       "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491", "Foreground U2Net mask"),
        ("skyseg-u2net.onnx",                "ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39", "Sky U2Net mask"),
        ("depth_anything_v2_vits.onnx",      "d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be", "Depth Anything V2 (vits)"),
        ("nind_denoise_utnet_684.onnx",      "ee3586279d514df557ff3f7dec6df37fafc51ba5d3a3435b2cc9ac2d9017e7fe", "NIND UTNet AI denoise"),
        ("clip_model.onnx",                  "57879bb1c23cdeb350d23569dd251ed4b740a96d747c529e94a2bb8040ac5d00", "CLIP image embedding (tagging)"),
        ("lama_fp16.onnx",                   "2d6be6277c400d6f1b91819737f7c3da935e5c63d1b521d393be1196a2bfa82c", "LaMa FP16 inpainting"),
    ];

    for (filename, hash, label) in models {
        let path = ai_models_dir.join(filename);
        check_file(&path, hash, label);
    }

    // clip_tokenizer.json — 上游仓库没给 hash，只校验存在
    let tokenizer_path = ai_models_dir.join("clip_tokenizer.json");
    check_file_optional_hash(&tokenizer_path, "CLIP tokenizer JSON");

    println!("cargo:warning=[AI assets] All {} files verified ✓", 1 + models.len() + 1);

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=resources/libonnxruntime.so");
    println!("cargo:rerun-if-changed=resources/libonnxruntime.dylib");
    println!("cargo:rerun-if-changed=resources/onnxruntime.dll");
    for (filename, _, _) in models {
        println!("cargo:rerun-if-changed=resources/ai_models/{}", filename);
    }
    println!("cargo:rerun-if-changed=resources/ai_models/clip_tokenizer.json");

    tauri_build::build()
}
