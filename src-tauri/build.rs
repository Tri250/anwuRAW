use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

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

/// HuggingFace is unreachable from some regions (notably mainland China), so
/// build-time downloads walk the same candidate endpoints as the runtime model
/// downloads in `ai_processing.rs`: custom mirror -> official -> hf-mirror.com.
const HF_DEFAULT_HOST: &str = "https://huggingface.co";
const HF_FALLBACK_HOST: &str = "https://hf-mirror.com";
const HF_ENDPOINT_ENV: &str = "RAPIDRAW_HF_ENDPOINT";

fn candidate_urls(url: &str) -> Vec<String> {
    let Some(rest) = url.strip_prefix(HF_DEFAULT_HOST) else {
        return vec![url.to_string()];
    };
    let mut urls = Vec::new();
    if let Ok(custom) = env::var(HF_ENDPOINT_ENV) {
        let custom = custom.trim().trim_end_matches('/');
        if !custom.is_empty() {
            urls.push(format!("{custom}{rest}"));
        }
    }
    urls.push(url.to_string());
    urls.push(format!("{HF_FALLBACK_HOST}{rest}"));
    urls
}

/// Build-time downloads face the same flaky networks as the runtime model
/// downloads in `ai_processing.rs`: a single attempt per endpoint occasionally
/// dies with a transport error (proxy reset, DNS hiccup). Retry each endpoint
/// a few times with backoff so `cargo build` survives transient failures.
const MAX_DOWNLOAD_ATTEMPTS: usize = 3;

fn build_http_client() -> Result<reqwest::blocking::Client, Box<dyn std::error::Error>> {
    Ok(reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()?)
}

fn download_and_verify(
    urls: &[String],
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let temp_filename = dest_path.file_name().unwrap();
    let temp_path = out_dir.join(temp_filename);
    let client = build_http_client()?;

    let mut failures: Vec<String> = Vec::new();
    for url in urls {
        for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
            println!(
                "cargo:warning=Downloading to temporary path: {:?} (attempt {attempt})",
                temp_path
            );
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                let _ = fs::remove_file(&temp_path);
                let mut response = client.get(url).send()?;

                if !response.status().is_success() {
                    let status = response.status();
                    let error_body = response
                        .text()
                        .unwrap_or_else(|_| "Could not read error body".to_string());
                    return Err(format!("Download failed with status {}: {}", status, error_body).into());
                }

                let mut temp_file = fs::File::create(&temp_path)?;
                response.copy_to(&mut temp_file)?;
                println!("cargo:warning=Download complete. Verifying file integrity...");

                match verify_sha256(&temp_path, expected_hash) {
                    Ok(true) => {
                        fs::copy(&temp_path, dest_path)?;
                        fs::remove_file(&temp_path)?;
                        println!(
                            "cargo:warning=Successfully downloaded and verified {:?}.",
                            dest_path
                        );
                        Ok(())
                    }
                    Ok(false) => {
                        Err("Verification failed! The downloaded file is corrupt.".into())
                    }
                    Err(e) => {
                        Err(format!("Could not verify file after download: {}", e).into())
                    }
                }
            })();
            match result {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let _ = fs::remove_file(&temp_path);
                    failures.push(format!("{} (attempt {attempt}): {}", url, e));
                    if attempt < MAX_DOWNLOAD_ATTEMPTS {
                        sleep(Duration::from_secs(attempt as u64));
                    }
                }
            }
        }
    }
    Err(format!(
        "Failed to download and verify {}: {}",
        dest_path.display(),
        failures.join("; ")
    )
    .into())
}

fn runtime_libraries(
    target_os: &str,
    target_arch: &str,
) -> Vec<(&'static str, &'static str, &'static str)> {
    match (target_os, target_arch) {
        ("windows", "x86_64") => vec![
            (
                "onnxruntime-directml-windows-x86_64.dll",
                "onnxruntime.dll",
                "95366724919f4e95ecc60010912ed538ad9804b6683fbd0aad389749102834b9",
            ),
            (
                "directml-windows-x86_64.dll",
                "DirectML.dll",
                "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1",
            ),
        ],
        ("windows", "aarch64") => vec![
            (
                "onnxruntime-directml-windows-aarch64.dll",
                "onnxruntime.dll",
                "c544001fbb76c7217fce76e9c24dada4a35d263b7ae3c0024474d9d7323a888f",
            ),
            (
                "directml-windows-aarch64.dll",
                "DirectML.dll",
                "77b0db83ff903f2323f5caf538499d75af6038bbea23b7959f7d232d9a4ab9d4",
            ),
        ],
        ("linux", "x86_64") => vec![(
            "libonnxruntime-linux-x86_64.so",
            "libonnxruntime.so",
            "3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673",
        )],
        ("linux", "aarch64") => vec![(
            "libonnxruntime-linux-aarch64.so",
            "libonnxruntime.so",
            "0afd69a0ae38c5099fd0e8604dda398ac43dee67cd9c6394b5142b19e82528de",
        )],
        ("macos", "x86_64") => vec![(
            "libonnxruntime-macos-x86_64.dylib",
            "libonnxruntime.dylib",
            "283e595e61cf65df7a6b1d59a1616cbd35c8b6399dd90d799d99b71a3ff83160",
        )],
        ("macos", "aarch64") => vec![(
            "libonnxruntime-macos-aarch64.dylib",
            "libonnxruntime.dylib",
            "2b885992d3d6fa4130d39ec84a80d7504ff52750027c547bb22c86165f19406a",
        )],
        ("android", "aarch64") => vec![(
            "libonnxruntime-android-arm64-v8a.so",
            "libonnxruntime.so",
            "999ecfdb5b5a13e4097487773b6d71ce8a075408a237daab072e8f5e817bd78e",
        )],
        _ => panic!("Unsupported target: {}-{}", target_os, target_arch),
    }
}

fn copy_and_verify(
    source_path: &Path,
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if !verify_sha256(source_path, expected_hash)? {
        return Err(format!("Local file {:?} has an incorrect hash.", source_path).into());
    }
    fs::copy(source_path, dest_path)?;
    println!(
        "cargo:warning=Copied and verified {:?} from {:?}.",
        dest_path, source_path
    );
    Ok(())
}

fn ensure_runtime_library(
    dest_dir: &Path,
    download_filename: &str,
    lib_name: &str,
    expected_hash: &str,
) -> PathBuf {
    let dest_path = dest_dir.join(lib_name);

    if dest_path.exists() {
        match verify_sha256(&dest_path, expected_hash) {
            Ok(true) => {
                println!(
                    "cargo:warning={} already exists and is valid. Skipping download.",
                    lib_name
                );
                return dest_path;
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

    let local_path = env::var_os("RAPIDRAW_RUNTIME_DIR")
        .map(|dir| PathBuf::from(dir).join(download_filename))
        .filter(|path| path.exists());

    let result = if let Some(local_path) = local_path {
        copy_and_verify(&local_path, &dest_path, expected_hash)
    } else {
        println!("cargo:warning=Downloading {}...", download_filename);
        let base_url =
            "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/onnxruntimes-v1.22.0/";
        let download_url = format!("{}{}?download=true", base_url, download_filename);
        let candidate_urls = candidate_urls(&download_url);
        println!("cargo:warning=URLs: {:?}", candidate_urls);
        download_and_verify(&candidate_urls, &dest_path, expected_hash)
    };

    if let Err(e) = result {
        panic!("Failed to download and verify {}: {}", lib_name, e);
    }

    dest_path
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    let dest_dir = if target_os == "android" {
        manifest_dir.join("libs").join("arm64-v8a")
    } else {
        manifest_dir.join("resources")
    };

    fs::create_dir_all(&dest_dir).unwrap();

    let lib_paths: Vec<PathBuf> = runtime_libraries(&target_os, &target_arch)
        .into_iter()
        .map(|(download_filename, lib_name, expected_hash)| {
            ensure_runtime_library(&dest_dir, download_filename, lib_name, expected_hash)
        })
        .collect();

    if target_os == "android" {
        let jni_libs_dir = manifest_dir.join("gen/android/app/src/main/jniLibs/arm64-v8a");
        fs::create_dir_all(&jni_libs_dir).unwrap();
        for lib_path in &lib_paths {
            fs::copy(lib_path, jni_libs_dir.join(lib_path.file_name().unwrap())).unwrap();
        }

        println!("cargo:rustc-env=ORT_LIB_LOCATION={}", dest_dir.display());
        println!("cargo:rustc-env=ORT_STRATEGY=manual");
        println!("cargo:rustc-link-search=native={}", dest_dir.display());
    }

    // 生成内置 LUT 文件名清单（film_luts / master_luts）：Android 上 bundle 资源在
    // APK assets 内无法枚举，运行时据此把资源物化到应用数据目录（见 lut_processing）。
    for lut_dir in ["film_luts", "master_luts"] {
        let src = manifest_dir.join("resources").join(lut_dir);
        let mut manifest = String::new();
        if let Ok(entries) = fs::read_dir(&src) {
            let mut names: Vec<String> = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_file())
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .collect();
            names.sort();
            manifest = names.join("\n");
        }
        let manifest_path =
            PathBuf::from(env::var("OUT_DIR").unwrap()).join(format!("{}_manifest.txt", lut_dir));
        fs::write(&manifest_path, manifest).unwrap();
        println!("cargo:rerun-if-changed=resources/{}", lut_dir);
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=RAPIDRAW_RUNTIME_DIR");

    tauri_build::build()
}
