use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

fn verify_sha256(path: &Path, expected_hash: &str) -> Result<bool, io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let hash_bytes = hasher.finalize();
    let calculated_hash = hex::encode(hash_bytes);
    Ok(calculated_hash == expected_hash)
}

/// 读取系统代理（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 等环境变量）。
/// 在带代理的构建/内网环境中，缺少代理会导致 ONNX Runtime 下载一直失败而阻塞构建。
fn system_proxy() -> Option<reqwest::Proxy> {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(val) = std::env::var(key) {
            let val = val.trim().to_string();
            if !val.is_empty()
                && let Ok(proxy) = reqwest::Proxy::all(&val)
            {
                return Some(proxy);
            }
        }
    }
    None
}

fn download_and_verify(
    endpoints: &[&str],
    repo_path: &str,
    filename: &str,
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let temp_path = out_dir.join(filename);
    // 确保 temp_path 父目录存在（filename 可能包含子路径如 "onnxruntimes-v1.22.0/xxx.so"）
    if let Some(parent) = temp_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // 用 .part 作为断点续传的中间文件：下载中断后重试/换端点都从已保存字节继续，
    // 不必每次从头再下（ONNX Runtime 库体积较大，反复重下会明显阻塞构建）。
    let part_path = {
        let file_name = temp_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download");
        temp_path.with_file_name(format!(".{}.part", file_name))
    };

    let mut last_err: Option<Box<dyn std::error::Error>> = None;
    let backoff = |attempt: u32| {
        std::thread::sleep(std::time::Duration::from_millis(1500 * u64::from(attempt)));
    };

    for endpoint in endpoints {
        let url = format!(
            "{}/{}/resolve/main/{}?download=true",
            endpoint.trim_end_matches('/'),
            repo_path,
            filename
        );

        for attempt in 1..=3u32 {
            println!("cargo:warning=Trying {} (attempt {}/3) ...", url, attempt);

            let mut builder = reqwest::blocking::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(20))
                .timeout(std::time::Duration::from_secs(120));
            if let Some(proxy) = system_proxy() {
                builder = builder.proxy(proxy);
            }
            let client = builder.build()?;

            // 断点续传：已有 .part 文件时从已保存字节继续
            let existing_size = if part_path.exists() {
                fs::metadata(&part_path)?.len()
            } else {
                0
            };

            let mut request = client.get(&url);
            if existing_size > 0 {
                request = request.header(
                    reqwest::header::RANGE,
                    format!("bytes={}-", existing_size),
                );
            }

            let mut response = match request.send() {
                Ok(r) => r,
                Err(e) => {
                    last_err = Some(e.into());
                    if attempt < 3 {
                        backoff(attempt);
                    }
                    continue;
                }
            };

            let status = response.status().as_u16();
            let resumed = status == 206;
            if !resumed && !(200..300).contains(&status) {
                last_err = Some(format!("{} returned status {}", url, status).into());
                if attempt < 3 {
                    backoff(attempt);
                }
                continue;
            }

            let mut file = if resumed {
                fs::OpenOptions::new().append(true).open(&part_path)?
            } else {
                fs::File::create(&part_path)?
            };

            // 流式落盘（io::copy 边读边写），不会把整个库读入内存
            if let Err(e) = io::copy(&mut response, &mut file) {
                // 保留 .part，便于下次续传
                last_err = Some(
                    format!(
                        "Failed downloading {} ({} bytes already saved): {}",
                        url, existing_size, e
                    )
                    .into(),
                );
                if attempt < 3 {
                    backoff(attempt);
                }
                continue;
            }

            println!("cargo:warning=Download complete. Verifying file integrity...");

            match verify_sha256(&part_path, expected_hash) {
                Ok(true) => {
                    fs::copy(&part_path, dest_path)?;
                    fs::remove_file(&part_path)?;
                    println!(
                        "cargo:warning=Successfully downloaded and verified {:?}.",
                        dest_path
                    );
                    return Ok(());
                }
                Ok(false) => {
                    fs::remove_file(&part_path).ok();
                    last_err =
                        Some("Verification failed! The downloaded file is corrupt.".into());
                    if attempt < 3 {
                        backoff(attempt);
                    }
                    continue;
                }
                Err(e) => {
                    fs::remove_file(&part_path).ok();
                    last_err = Some(format!("Could not verify file after download: {}", e).into());
                    if attempt < 3 {
                        backoff(attempt);
                    }
                    continue;
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "All download endpoints failed".into()))
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    let (download_filename, lib_name, expected_hash) =
        match (target_os.as_str(), target_arch.as_str()) {
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

    let dest_dir = if target_os == "android" {
        manifest_dir.join("libs").join("arm64-v8a")
    } else {
        manifest_dir.join("resources")
    };

    fs::create_dir_all(&dest_dir).unwrap();
    let dest_path = dest_dir.join(lib_name);

    let mut is_valid = false;
    if dest_path.exists() {
        match verify_sha256(&dest_path, expected_hash) {
            Ok(true) => {
                println!(
                    "cargo:warning=ONNX Runtime library already exists and is valid. Skipping download."
                );
                is_valid = true;
            }
            Ok(false) => {
                println!(
                    "cargo:warning=File {:?} exists but has incorrect hash. Deleting and re-downloading.",
                    dest_path
                );
                fs::remove_file(&dest_path).unwrap();
            }
            Err(e) => {
                println!(
                    "cargo:warning=Could not verify file {:?}: {}. Re-downloading.",
                    dest_path, e
                );
            }
        }
    }

    if !is_valid {
        // 允许通过环境变量跳过 ONNX Runtime 库的下载（例如在离线构建环境中）
        if env::var("RAPIDRAW_SKIP_ORT_DOWNLOAD").is_ok() {
            println!(
                "cargo:warning=RAPIDRAW_SKIP_ORT_DOWNLOAD is set, skipping ONNX Runtime download. \
                 AI features will not work until {} is placed in {}.",
                lib_name,
                dest_dir.display()
            );
        } else {
            println!(
                "cargo:warning=Downloading ONNX Runtime library for {}-{}...",
                target_os, target_arch
            );
            // 国内优先：hf-mirror 镜像 + HuggingFace 官方降级
            const HF_MIRROR: &str = "https://hf-mirror.com";
            const HF_OFFICIAL: &str = "https://huggingface.co";
            let endpoints: &[&str] = &[HF_MIRROR, HF_OFFICIAL];
            let repo_path = "CyberTimon/RapidRAW-Models";
            let filename = format!("onnxruntimes-v1.22.0/{}", download_filename);
            println!("cargo:warning=Endpoints: {:?}", endpoints);

            if let Err(e) =
                download_and_verify(endpoints, repo_path, &filename, &dest_path, expected_hash)
            {
                panic!("Failed to download and verify ONNX Runtime library: {}", e);
            }
        }
    }

    if target_os == "android" {
        let jni_libs_dir = manifest_dir.join("gen/android/app/src/main/jniLibs/arm64-v8a");
        fs::create_dir_all(&jni_libs_dir).unwrap();
        fs::copy(&dest_path, jni_libs_dir.join(lib_name)).unwrap();

        println!("cargo:rustc-env=ORT_LIB_LOCATION={}", dest_dir.display());
        println!("cargo:rustc-env=ORT_STRATEGY=manual");
        println!("cargo:rustc-link-search=native={}", dest_dir.display());
    }

    println!("cargo:rerun-if-changed=build.rs");

    tauri_build::build()
}
