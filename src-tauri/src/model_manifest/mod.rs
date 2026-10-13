//! 模型 Manifest 数据层（v2.0 Task 2）
//!
//! 将原先散落在 ai_processing.rs 中的硬编码文件名/哈希常量收敛为一份内嵌
//! `models.json`，为模型管理器（A1）、量化变体（Task 3）与 EP 委托（Task 4）
//! 提供统一的数据结构。本模块只做数据层，不做管理 UI。
//!
//! 设计要点：
//! - `ModelVariant` 承载 filename/size/sha256/precision/optional/recommended_ep，
//!   同一模型未来可挂多个量化变体（int8 等），`default` 标记当前使用项；
//! - `legacy_filenames` 记录历史文件名（如 skyseg 双横线/下划线两种命名），
//!   下载前先把本地旧文件晋升为新名，已下载模型不重下；
//! - `recommended_ep` 为 Task 0 PoC 结论的挂载点，当前全部为 `["cpu"]`。

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

const MANIFEST_JSON: &str = include_str!("models.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelVariant {
    /// 数值精度：fp32 / fp16 / int8；非模型资产（如 tokenizer）为 null
    pub precision: Option<String>,
    pub filename: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    pub sha256: String,
    /// 可选下载包（大体积生成式模型）标记，数据层预留，Task 5 消费
    #[serde(default)]
    pub optional: bool,
    /// 多变体时的当前使用项；单变体恒为 true
    #[serde(default = "default_true")]
    pub default: bool,
    /// 每模型 EP 约束（Task 0 PoC 结论挂载点），按优先级排序
    #[serde(default)]
    pub recommended_ep: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    /// 功能用途：subject_masking / sky_masking / inpainting / ...
    pub purpose: String,
    /// 历史文件名（本地旧文件晋升用），不含当前文件名
    #[serde(default)]
    pub legacy_filenames: Vec<String>,
    pub variants: Vec<ModelVariant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelManifest {
    pub version: u32,
    pub repo: String,
    pub models: Vec<ModelEntry>,
}

impl ModelManifest {
    /// 解析内嵌 manifest。数据随二进制编译期固定，解析失败属于构建期缺陷，
    /// panic 是合理的失败方式（并有单测保障）。
    pub fn embedded() -> &'static ModelManifest {
        static MANIFEST: OnceLock<ModelManifest> = OnceLock::new();
        MANIFEST.get_or_init(|| {
            serde_json::from_str(MANIFEST_JSON).expect("embedded models.json must be valid")
        })
    }

    pub fn get(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.id == id)
    }

    /// 按文件名反查模型条目：同时匹配当前变体名与历史 legacy 名，
    /// 保证旧文件名兼容映射可双向解析（下载前旧文件晋升、数据迁移等场景）
    pub fn entry_by_filename(&self, filename: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| {
            m.variants.iter().any(|v| v.filename == filename)
                || m.legacy_filenames.iter().any(|f| f == filename)
        })
    }
}

impl ModelEntry {
    /// 默认变体：显式 `default: true` 的变体优先，否则取第一个
    pub fn default_variant(&self) -> Option<&ModelVariant> {
        self.variants
            .iter()
            .find(|v| v.default)
            .or_else(|| self.variants.first())
    }

    pub fn filename(&self) -> Option<&str> {
        self.default_variant().map(|v| v.filename.as_str())
    }

    /// 默认变体的 sha256（A1 模型管理器预留 API，本任务仅数据层）
    #[allow(dead_code)]
    pub fn sha256(&self) -> Option<&str> {
        self.default_variant().map(|v| v.sha256.as_str())
    }
}

/// 按 id 取条目，缺失视为代码与 manifest 不同步的编程错误
pub fn require(id: &str) -> anyhow::Result<&'static ModelEntry> {
    ModelManifest::embedded().get(id).ok_or_else(|| {
        anyhow::anyhow!(
            "Model id '{}' is missing from the embedded manifest (version {})",
            id,
            ModelManifest::embedded().version
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TR-2.1: 内嵌 manifest 可解析且结构合法
    #[test]
    fn test_embedded_manifest_parses_and_valid() {
        let manifest = ModelManifest::embedded();
        assert_eq!(manifest.version, 1);
        assert!(!manifest.repo.is_empty());
        assert_eq!(manifest.models.len(), 9);

        let mut ids: Vec<&str> = manifest.models.iter().map(|m| m.id.as_str()).collect();
        let id_count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), id_count, "model ids must be unique");

        let mut filenames: Vec<&str> = manifest
            .models
            .iter()
            .flat_map(|m| m.variants.iter().map(|v| v.filename.as_str()))
            .collect();
        let filename_count = filenames.len();
        filenames.sort_unstable();
        filenames.dedup();
        assert_eq!(filenames.len(), filename_count, "variant filenames must be unique");

        for model in &manifest.models {
            assert!(!model.display_name.is_empty());
            assert!(!model.purpose.is_empty());
            assert!(!model.variants.is_empty(), "{} must have variants", model.id);
            let default_count = model.variants.iter().filter(|v| v.default).count();
            assert_eq!(default_count, 1, "{} must have exactly one default variant", model.id);
            for variant in &model.variants {
                assert_eq!(
                    variant.sha256.len(),
                    64,
                    "{} sha256 must be 64 hex chars",
                    variant.filename
                );
                assert!(
                    variant.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{} sha256 must be hex",
                    variant.filename
                );
                assert!(
                    !variant.recommended_ep.is_empty(),
                    "{} recommended_ep must not be empty",
                    variant.filename
                );
            }
            assert!(
                model.default_variant().is_some(),
                "{} must resolve a default variant",
                model.id
            );
        }
    }

    /// TR-2.1: 现有全部模型 id 在 manifest 中可查询
    #[test]
    fn test_required_ids_present() {
        for id in [
            "sam_encoder",
            "sam_decoder",
            "foreground_u2net",
            "sky_seg",
            "depth_anything",
            "denoise_nind",
            "clip_model",
            "clip_tokenizer",
            "inpainting_lama",
        ] {
            let entry = require(id).expect(id);
            assert!(entry.filename().is_some());
            assert!(entry.sha256().is_some());
        }
    }

    /// TR-2.1: 旧文件名兼容映射 —— skyseg 双命名（仓库正名为连字符，
    /// 历史代码误用下划线导致 404，manifest 以仓库名为正、旧名为 legacy）
    #[test]
    fn test_legacy_filename_mapping() {
        let manifest = ModelManifest::embedded();

        let sky = manifest.get("sky_seg").expect("sky_seg entry");
        assert_eq!(sky.filename(), Some("skyseg-u2net.onnx"));
        assert_eq!(sky.legacy_filenames, vec!["skyseg_u2net.onnx".to_string()]);

        // 当前名与 legacy 名都能反查到同一模型（下载前旧文件晋升依赖此查询）
        assert_eq!(manifest.entry_by_filename("skyseg-u2net.onnx").unwrap().id, "sky_seg");
        assert_eq!(
            manifest.entry_by_filename("skyseg_u2net.onnx").unwrap().id,
            "sky_seg"
        );

        // 其它模型无历史文件名
        for id in ["sam_encoder", "inpainting_lama", "clip_tokenizer"] {
            assert!(
                manifest.get(id).unwrap().legacy_filenames.is_empty(),
                "{} should have no legacy filenames",
                id
            );
        }
    }
}
