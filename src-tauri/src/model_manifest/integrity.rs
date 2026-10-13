//! 本地模型完整性与差异更新（W7-G1）
//!
//! 对内嵌 manifest 声明的每个默认变体，扫描本地 `models_dir` 判定三态：
//! Missing（未下载）/ Intact（sha256 匹配）/ Corrupted（存在但哈希不符）。
//! 模型中心（W9-I4）与差异更新决策直接消费 `diff_local_models`；
//! 下载层的 ensure_model_hash 重下闭环与本层判定语义对齐。

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::ModelManifest;

/// 内嵌 manifest 支持的 schema 版本。manifest 升版（如新增字段/变体语义变更）
/// 时同步提升此常量并评估本地 models_dir 是否需要迁移。
pub const SUPPORTED_MANIFEST_VERSION: u32 = 1;

/// 本地模型文件状态
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalModelState {
    /// 不存在，需下载
    Missing,
    /// sha256 匹配
    Intact,
    /// 存在但哈希不符（损坏或过期版本），差异更新时重下
    Corrupted,
}

/// 单个模型文件本地状态（模型中心与差异更新消费）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ModelFileStatus {
    pub model_id: String,
    pub filename: String,
    pub size_bytes: Option<u64>,
    pub state: LocalModelState,
}

/// 流式计算文件 sha256（大模型不整载入内存）
pub fn file_sha256(path: &Path) -> anyhow::Result<String> {
    let mut file = File::open(path)
        .map_err(|e| anyhow::anyhow!("Cannot open {} for hashing: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 校验单个文件完整性：true 表示 sha256 与期望一致
pub fn verify_file(path: &Path, expected_sha256: &str) -> anyhow::Result<bool> {
    Ok(file_sha256(path)?.eq_ignore_ascii_case(expected_sha256))
}

/// 三态判定纯函数（单测锚点）
fn classify(local_hash: Option<String>, expected: &str) -> LocalModelState {
    match local_hash {
        None => LocalModelState::Missing,
        Some(h) if h.eq_ignore_ascii_case(expected) => LocalModelState::Intact,
        Some(_) => LocalModelState::Corrupted,
    }
}

/// 读取本地文件哈希；不存在返回 None，读取/哈希失败按损坏处理需重下
fn local_hash(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    file_sha256(path).ok()
}

/// 全量扫描：manifest 每个模型的默认变体在 models_dir 的本地状态
pub fn diff_local_models(models_dir: &Path) -> Vec<ModelFileStatus> {
    let manifest = ModelManifest::embedded();
    manifest
        .models
        .iter()
        .filter_map(|entry| {
            let variant = entry.default_variant()?;
            let path: PathBuf = models_dir.join(&variant.filename);
            let state = classify(local_hash(&path), &variant.sha256);
            Some(ModelFileStatus {
                model_id: entry.id.clone(),
                filename: variant.filename.clone(),
                size_bytes: variant.size_bytes,
                state,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// G1: 内嵌 manifest 版本与受支持版本对齐（升版时本测试强制同步评估）
    #[test]
    fn test_supported_manifest_version_alignment() {
        assert_eq!(
            ModelManifest::embedded().version,
            SUPPORTED_MANIFEST_VERSION,
            "manifest schema bump requires updating SUPPORTED_MANIFEST_VERSION and migration review"
        );
    }

    /// G1: 三态判定（缺失/匹配/哈希不符），大小写不敏感
    #[test]
    fn test_classify_three_states() {
        assert_eq!(classify(None, "abc"), LocalModelState::Missing);
        assert_eq!(
            classify(Some("abc".to_string()), "abc"),
            LocalModelState::Intact
        );
        assert_eq!(
            classify(Some("ABC".to_string()), "abc"),
            LocalModelState::Intact
        );
        assert_eq!(
            classify(Some("deadbeef".to_string()), "abc"),
            LocalModelState::Corrupted
        );
    }

    /// G1: file_sha256 流式哈希正确性（分块 > 单块边界）
    #[test]
    fn test_file_sha256_matches_known_vector() {
        let dir = std::env::temp_dir().join(format!(
            "rr-g1-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("probe.bin");
        // "abc" 的 sha256 标准测试向量
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            file_sha256(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // 分块边界：100KB 内容 > 64KB 缓冲
        let big: Vec<u8> = (0..100 * 1024).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &big).unwrap();
        let h1 = file_sha256(&path).unwrap();
        let mut expected = Sha256::new();
        expected.update(&big);
        assert_eq!(h1, hex::encode(expected.finalize()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// G1: verify_file 对损坏文件报 false，缺失文件报错
    #[test]
    fn test_verify_file_semantics() {
        let dir = std::env::temp_dir().join(format!(
            "rr-g1-verify-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.onnx");
        std::fs::write(&path, b"payload").unwrap();
        let good = file_sha256(&path).unwrap();
        assert!(verify_file(&path, &good).unwrap());
        assert!(verify_file(&path, &good.to_uppercase()).unwrap());
        assert!(!verify_file(&path, "0000").unwrap());
        assert!(verify_file(&dir.join("missing.onnx"), &good).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// G1: 空目录全量扫描 → 全部 Missing，且条目数与 manifest 模型数一致
    #[test]
    fn test_diff_local_models_empty_dir_all_missing() {
        let dir = std::env::temp_dir().join(format!(
            "rr-g1-diff-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let statuses = diff_local_models(&dir);
        let manifest = ModelManifest::embedded();
        assert_eq!(statuses.len(), manifest.models.len());
        for s in &statuses {
            assert_eq!(s.state, LocalModelState::Missing);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// G1: diff 对同名不同内容文件判 Corrupted（差异更新触发重下）
    #[test]
    fn test_diff_local_models_corrupted_detected() {
        let dir = std::env::temp_dir().join(format!(
            "rr-g1-corr-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let statuses = diff_local_models(&dir);
        let target = statuses.first().expect("manifest non-empty");
        std::fs::write(dir.join(&target.filename), b"corrupted payload").unwrap();
        let statuses = diff_local_models(&dir);
        let hit = statuses.iter().find(|s| s.filename == target.filename).unwrap();
        assert_eq!(hit.state, LocalModelState::Corrupted);
        assert_eq!(hit.model_id, target.model_id);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
