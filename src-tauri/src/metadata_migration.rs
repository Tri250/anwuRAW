//! .rrdata 元数据迁移链：v1 → v2 的唯一入口。
//!
//! v2 契约（相对 v1 的变化）：
//! - `version` 字段固定为 [`METADATA_VERSION`]（v1 文件缺省 version 或为 1）
//! - `adjustments` 规约为对象（v1 可能是 null）
//! - `tags` 过滤非字符串项并去重
//! - `exif` 过滤非字符串值
//! - `rating` 钳制到 0..=5
//!
//! 原则：只做无损规约——无法理解的字段原样保留，硬解析失败返回 Err 而非吞掉用户数据。
//! 所有 `.rrdata` 读取路径必须经由 [`parse_and_migrate`]，禁止直接 `serde_json::from_str::<ImageMetadata>`。

use crate::image_processing::ImageMetadata;
use serde_json::Value;

pub const METADATA_VERSION: u32 = 2;

/// 解析并迁移 sidecar 内容。`Ok((meta, report))` 中 report 非空表示发生了 v1→v2 迁移。
pub fn parse_and_migrate(content: &str) -> Result<(ImageMetadata, Vec<String>), String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok((ImageMetadata::default(), Vec::new()));
    }

    let mut raw: Value = serde_json::from_str(trimmed).map_err(|e| format!("invalid sidecar JSON: {e}"))?;
    if !raw.is_object() {
        return Err("sidecar root must be a JSON object".to_string());
    }

    // v2 快路径：版本号匹配且结构合法时零拷贝直读
    if raw.get("version").and_then(|v| v.as_u64()) == Some(METADATA_VERSION as u64) {
        let meta: ImageMetadata = serde_json::from_value(raw)
            .map_err(|e| format!("v2 sidecar failed strict parse: {e}"))?;
        return Ok((meta, Vec::new()));
    }

    // v1（或更早/无版本号）→ v2
    let mut report = Vec::new();

    match raw.get_mut("adjustments") {
        Some(Value::Null) | None => {
            raw["adjustments"] = serde_json::json!({});
            report.push("adjustments: null -> {}".to_string());
        }
        Some(Value::Object(_)) => {}
        Some(other) => {
            let was = other.take();
            *other = serde_json::json!({});
            report.push(format!(
                "adjustments: non-object ({}) -> {{}}",
                short_kind(&was)
            ));
        }
    }

    if let Some(tags) = raw.get_mut("tags") {
        match tags.take() {
            Value::Array(items) => {
                let total = items.len();
                let mut kept: Vec<String> = items
                    .into_iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                kept.sort();
                kept.dedup();
                if kept.len() != total {
                    report.push(format!(
                        "tags: normalized {} -> {} (non-string/empty/duplicate dropped)",
                        total,
                        kept.len()
                    ));
                }
                raw["tags"] = Value::Array(kept.into_iter().map(Value::String).collect());
            }
            Value::Null => {
                report.push("tags: null -> []".to_string());
                raw["tags"] = Value::Array(Vec::new());
            }
            other => {
                report.push(format!("tags: {} -> []", short_kind(&other)));
                raw["tags"] = Value::Array(Vec::new());
            }
        }
    }

    if let Some(exif) = raw.get_mut("exif") {
        match exif.take() {
            Value::Object(map) => {
                let before = map.len();
                let kept: serde_json::Map<String, Value> = map
                    .into_iter()
                    .filter(|(_, v)| v.is_string())
                    .collect();
                if kept.len() != before {
                    report.push(format!("exif: dropped {} non-string value(s)", before - kept.len()));
                }
                raw["exif"] = Value::Object(kept);
            }
            Value::Null => {
                report.push("exif: null -> absent".to_string());
                raw.as_object_mut().unwrap().remove("exif");
            }
            other => {
                report.push(format!("exif: {} -> absent", short_kind(&other)));
                raw.as_object_mut().unwrap().remove("exif");
            }
        }
    }

    if let Some(rating) = raw.get("rating").and_then(|v| v.as_i64()) {
        if !(0..=5).contains(&rating) {
            raw["rating"] = serde_json::json!(rating.clamp(0, 5));
            report.push(format!("rating: {rating} clamped"));
        }
    }

    raw["version"] = serde_json::json!(METADATA_VERSION);

    let meta: ImageMetadata = serde_json::from_value(raw)
        .map_err(|e| format!("post-migration parse failed: {e}"))?;
    Ok((meta, report))
}

/// 幂等性：把已迁移的元数据再写入再读出，应零迁移报告。
pub fn serialize(meta: &ImageMetadata) -> Result<String, String> {
    serde_json::to_string_pretty(meta).map_err(|e| e.to_string())
}

fn short_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TR-MIG-1: v1 样本（无 version、null adjustments、混合 tags）无损升 v2。
    #[test]
    fn tr_mig_1_v1_sample_migrates_losslessly() {
        let v1 = r#"{
            "rating": 4,
            "adjustments": null,
            "tags": ["travel", 42, "  travel ", ""],
            "exif": {"Make": "Canon", "LensData": 123}
        }"#;
        let (meta, report) = parse_and_migrate(v1).expect("v1 must migrate");
        assert_eq!(meta.version, METADATA_VERSION);
        assert_eq!(meta.rating, 4);
        assert!(meta.adjustments.is_object(), "adjustments must be object");
        let tags = meta.tags.as_ref().expect("tags present");
        assert_eq!(tags, &vec!["travel".to_string()]);
        let exif = meta.exif.as_ref().expect("exif present");
        assert_eq!(exif.get("Make").map(String::as_str), Some("Canon"));
        assert!(!exif.contains_key("LensData"), "non-string exif dropped");

        let joined = report.join("; ");
        assert!(joined.contains("adjustments"), "report: {joined}");
        assert!(joined.contains("exif"), "report: {joined}");
    }

    /// TR-MIG-2: v2 直读零迁移；循环写入后再读仍零迁移（幂等）。
    #[test]
    fn tr_mig_2_v2_passthrough_and_idempotence() {
        let (meta, report) = parse_and_migrate(
            r#"{"version":2,"rating":1,"adjustments":{"exposure":0.5},"tags":["a"],"exif":{"Make":"Nikon"}}"#,
        )
        .expect("v2 direct parse");
        assert!(report.is_empty(), "v2 must not report migration");

        let round = parse_and_migrate(&serialize(&meta).unwrap()).expect("roundtrip");
        assert!(round.1.is_empty(), "migrated output must be idempotent");
        assert_eq!(round.0.rating, meta.rating);
        assert_eq!(round.0.tags, meta.tags);
    }

    /// TR-MIG-3: 防御性——垃圾输入报错不吞数据；怪异类型被规约而非崩溃。
    #[test]
    fn tr_mig_3_defensive_edges() {
        assert!(parse_and_migrate("not json {").is_err());
        assert!(parse_and_migrate("[1,2,3]").is_err(), "top-level array is not metadata");

        let (meta, report) = parse_and_migrate(r#"{"rating": 200, "adjustments": "oops"}"#)
            .expect("weird v1 must be repaired");
        assert_eq!(meta.rating, 5, "rating clamped");
        assert!(meta.adjustments.is_object());
        let joined = report.join("; ");
        assert!(joined.contains("clamped") && joined.contains("adjustments"), "{joined}");

        let (empty, report) = parse_and_migrate("").expect("empty sidecar is fresh default");
        assert_eq!(empty.version, METADATA_VERSION);
        assert!(report.is_empty() && empty.tags.is_none());
    }
}
