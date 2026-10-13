//! 资产版本戳清单：为 lensfun 数据库、内置 LUT、许可文本与 ONNX Runtime 提供确定性指纹。
//!
//! 清单 `resources/asset_manifest.json` 由维护者在资产变更后重新生成（见模块测试输出的
//! 现算指纹），CI 通过本模块测试验证清单与磁盘内容一致——防止资产被无意篡改或替换。
//! 运行时按需读取（如镜头库加载器上报版本），不做启动期全量哈希（避免无谓 IO）。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const MANIFEST_PATH: &str = "resources/asset_manifest.json";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // "file" | "directory"
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ort_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetManifest {
    pub version: u32,
    pub generated: String,
    #[serde(default)]
    pub algorithm: String,
    pub assets: Vec<AssetEntry>,
}

impl AssetManifest {
    /// 读取打包在仓库内的清单（`repo_root` 即 src-tauri 目录）。
    pub fn load(repo_root: &Path) -> std::io::Result<Self> {
        let raw = std::fs::read_to_string(repo_root.join(MANIFEST_PATH))?;
        serde_json::from_str(&raw).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    /// 按名称查找资产条目（运行时版本上报用，如镜头库版本戳）。
    pub fn entry(&self, name: &str) -> Option<&AssetEntry> {
        self.assets.iter().find(|a| a.name == name)
    }

    /// 校验全部条目与磁盘一致，返回不一致描述（空 = 全部通过）。
    pub fn verify(&self, repo_root: &Path) -> Vec<String> {
        let mut mismatches = Vec::new();
        for asset in &self.assets {
            let full = repo_root.join(&asset.path);
            let (actual_hash, count, size) = match asset.kind.as_str() {
                "directory" => match dir_aggregate_sha256(&full, repo_root) {
                    Ok((hash, count)) => (hash, count, 0),
                    Err(e) => {
                        mismatches.push(format!("{}: unreadable: {e}", asset.path));
                        continue;
                    }
                },
                "file" => match file_sha256(&full) {
                    Ok(h) => (h, 1, std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0)),
                    Err(e) => {
                        mismatches.push(format!("{}: unreadable: {e}", asset.path));
                        continue;
                    }
                },
                other => {
                    mismatches.push(format!("{}: unknown kind '{other}'", asset.path));
                    continue;
                }
            };

            if actual_hash != asset.sha256 {
                mismatches.push(format!(
                    "{}: sha256 mismatch (manifest {}, actual {actual_hash})",
                    asset.path, asset.sha256
                ));
            }
            if let Some(expected) = asset.file_count {
                if count != expected {
                    mismatches.push(format!(
                        "{}: file_count mismatch (manifest {expected}, actual {count})",
                        asset.path
                    ));
                }
            }
            if let Some(expected) = asset.size {
                if size != expected {
                    mismatches.push(format!(
                        "{}: size mismatch (manifest {expected}, actual {size})",
                        asset.path
                    ));
                }
            }
        }
        mismatches
    }
}

/// 单文件 sha256。
pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// 目录聚合指纹：文件按字典序排序后，每个文件产出一行 `{sha256}  {名称}\n`
///（名称 = 相对 `name_base` 的路径，与 `find <dir> | xargs sha256sum` 的输出行一致），
/// 对该字节流整体取 sha256。交叉核对：
/// `cd src-tauri && find <dir> -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`
pub fn dir_aggregate_sha256(root: &Path, name_base: &Path) -> std::io::Result<(String, usize)> {
    let mut files: Vec<PathBuf> = WalkDir::new(root)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect();
    files.sort();

    let mut hasher = Sha256::new();
    for path in &files {
        let rel = path
            .strip_prefix(name_base)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
            .to_string_lossy()
            .replace('\\', "/");
        let file_hash = file_sha256(path)?;
        hasher.update(file_hash.as_bytes());
        hasher.update(b"  ");
        hasher.update(rel.as_bytes());
        hasher.update(b"\n");
    }
    Ok((hex(&hasher.finalize()), files.len()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    /// 清单可解析且自洽（version ≥ 1、名称唯一、kind 合法）。
    #[test]
    fn manifest_loads_and_is_self_consistent() {
        let manifest = AssetManifest::load(&repo_root()).expect("manifest readable");
        assert!(manifest.version >= 1);

        let mut names: Vec<&str> = manifest.assets.iter().map(|a| a.name.as_str()).collect();
        names.sort();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "duplicate asset names in manifest");

        for asset in &manifest.assets {
            assert!(
                asset.kind == "file" || asset.kind == "directory",
                "{}: invalid kind '{}'",
                asset.name,
                asset.kind
            );
            assert_eq!(asset.sha256.len(), 64, "{}: sha256 must be hex64", asset.name);
        }
        assert!(manifest.entry("onnxruntime_android").is_some());
    }

    /// 核心验收：清单指纹与磁盘实际内容一致（防篡改 / 防漂移）。
    #[test]
    fn manifest_matches_disk() {
        let manifest = AssetManifest::load(&repo_root()).expect("manifest readable");
        let mismatches = manifest.verify(&repo_root());
        assert!(
            mismatches.is_empty(),
            "asset manifest drift detected:\n{}",
            mismatches.join("\n")
        );
    }

    /// 目录指纹与 sha256sum 管道语义一致（单行流 + 空目录行为）。
    #[test]
    fn dir_hash_matches_sha256sum_semantics() {
        let dir = repo_root().join("resources/licenses");
        let (hash, count) = dir_aggregate_sha256(&dir, &repo_root()).expect("hash dir");
        assert_eq!(count, 3);
        assert_eq!(hash.len(), 64);

        // 与 shell 管道交叉验证同一结果
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg("find resources/licenses -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum")
            .current_dir(repo_root())
            .output()
            .expect("run sha256sum pipeline");
        let shell_hash = String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        assert_eq!(hash, shell_hash, "Rust aggregate must match sha256sum pipeline");
    }
}
