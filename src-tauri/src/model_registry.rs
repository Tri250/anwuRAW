//! Governance for downloadable AI models.
//!
//! Every model file the app can fetch is described by a [`ModelSpec`]: what it
//! is for, where it comes from, the hash that pins its content, and the license
//! it ships under. [`build_manifest`] turns the in-code table into a
//! serializable manifest and reports integrity problems instead of silently
//! trusting the table. User-facing surfaces (settings, support bundles) read the
//! manifest, so a missing hash or a non-HTTPS source becomes visible rather than
//! discovered after a bad download.

// The manifest API is consumed incrementally (settings UI today, model-set
// downloads next); tests are its other consumer, so non-test builds see parts
// of it as unused.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    /// Stable identifier used by residency tracking and UI keys.
    pub role: String,
    pub display_name: String,
    pub filename: String,
    pub download_url: String,
    /// Hex-encoded SHA-256 of the downloaded file.
    pub sha256: String,
    pub license: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    /// Size on disk once installed. `None` when the file is not present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifest {
    pub schema: u32,
    pub models: Vec<ModelSpec>,
    /// Human-readable integrity problems; empty means the table is consistent.
    pub issues: Vec<String>,
    pub installed_count: usize,
    pub total_count: usize,
}

impl ModelManifest {
    pub fn is_healthy(&self) -> bool {
        self.issues.is_empty()
    }
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validates a model table and assembles the manifest. Returns issues rather
/// than failing so a partially broken table still renders in the UI (marked as
/// unhealthy) instead of disappearing.
pub fn build_manifest(mut models: Vec<ModelSpec>) -> ModelManifest {
    let mut issues = Vec::new();
    let mut seen_filenames: Vec<&str> = Vec::new();
    let mut seen_roles: Vec<&str> = Vec::new();

    for model in &models {
        if model.role.trim().is_empty() {
            issues.push(format!("{}: empty role", model.filename));
        } else if seen_roles.contains(&model.role.as_str()) {
            issues.push(format!(
                "{}: duplicate role '{}'",
                model.filename, model.role
            ));
        } else {
            seen_roles.push(&model.role);
        }

        if model.filename.trim().is_empty() {
            issues.push(format!("{}: empty filename", model.role));
        } else if seen_filenames.contains(&model.filename.as_str()) {
            issues.push(format!("{}: duplicate filename", model.filename));
        } else {
            seen_filenames.push(&model.filename);
        }

        if !is_lower_hex_64(&model.sha256) {
            issues.push(format!(
                "{}: sha256 must be 64 lowercase hex characters",
                model.filename
            ));
        }

        if !model.download_url.starts_with("https://") {
            issues.push(format!("{}: download URL must use HTTPS", model.filename));
        }

        if model.license.trim().is_empty() {
            issues.push(format!("{}: missing license", model.filename));
        }
    }

    models.sort_by(|a, b| a.role.cmp(&b.role));
    let installed_count = models
        .iter()
        .filter(|model| model.installed_bytes.is_some())
        .count();
    let total_count = models.len();

    ModelManifest {
        schema: MANIFEST_SCHEMA_VERSION,
        models,
        issues,
        installed_count,
        total_count,
    }
}

/// Fills `installed_bytes` from the filesystem without failing on a missing
/// directory (models are downloaded on demand, so an empty dir is normal).
pub fn with_installed_sizes(mut models: Vec<ModelSpec>, models_dir: &Path) -> Vec<ModelSpec> {
    for model in &mut models {
        model.installed_bytes = std::fs::metadata(models_dir.join(&model.filename))
            .ok()
            .map(|meta| meta.len());
    }
    models
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Verifies a downloaded model file against its pinned hash.
pub fn verify_file(path: &Path, expected_sha256: &str) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let actual = sha256_hex(&bytes);
    if actual == expected_sha256 {
        Ok(())
    } else {
        Err(format!(
            "{}: sha256 mismatch (expected {expected_sha256}, got {actual})",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(role: &str, filename: &str) -> ModelSpec {
        ModelSpec {
            role: role.to_string(),
            display_name: role.to_string(),
            filename: filename.to_string(),
            download_url: format!("https://example.test/{filename}"),
            sha256: "a".repeat(64),
            license: "Apache-2.0".to_string(),
            license_url: None,
            installed_bytes: None,
        }
    }

    #[test]
    fn consistent_table_has_no_issues() {
        let manifest = build_manifest(vec![
            spec("sam_encoder", "sam.onnx"),
            spec("clip", "clip.onnx"),
        ]);
        assert!(manifest.issues.is_empty());
        assert_eq!(manifest.total_count, 2);
        assert_eq!(manifest.installed_count, 0);
        assert_eq!(manifest.schema, MANIFEST_SCHEMA_VERSION);
        // Sorted by role.
        assert_eq!(manifest.models[0].role, "clip");
    }

    #[test]
    fn duplicate_filenames_are_reported() {
        let manifest = build_manifest(vec![spec("a", "same.onnx"), spec("b", "same.onnx")]);
        assert!(
            manifest
                .issues
                .iter()
                .any(|issue| issue.contains("duplicate filename"))
        );
    }

    #[test]
    fn duplicate_roles_are_reported() {
        let manifest = build_manifest(vec![spec("a", "one.onnx"), spec("a", "two.onnx")]);
        assert!(
            manifest
                .issues
                .iter()
                .any(|issue| issue.contains("duplicate role"))
        );
    }

    #[test]
    fn bad_hash_and_plain_http_are_reported() {
        let mut model = spec("x", "x.onnx");
        model.sha256 = "ABC".to_string();
        model.download_url = "http://example.test/x.onnx".to_string();
        let manifest = build_manifest(vec![model]);
        assert_eq!(manifest.issues.len(), 2);
        assert!(manifest.issues[0].contains("sha256") || manifest.issues[1].contains("sha256"));
        assert!(manifest.issues.iter().any(|issue| issue.contains("HTTPS")));
    }

    #[test]
    fn missing_license_is_reported() {
        let mut model = spec("x", "x.onnx");
        model.license = "  ".to_string();
        let manifest = build_manifest(vec![model]);
        assert!(
            manifest
                .issues
                .iter()
                .any(|issue| issue.contains("missing license"))
        );
    }

    #[test]
    fn sha256_matches_known_digest() {
        // SHA-256 of the empty input.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_file_detects_mismatch() {
        let dir = std::env::temp_dir().join(format!("rapidraw-registry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("model.bin");
        std::fs::write(&path, b"abc").unwrap();
        assert!(
            verify_file(
                &path,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            )
            .is_ok()
        );
        assert!(verify_file(&path, &"0".repeat(64)).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installed_sizes_track_existing_files() {
        let dir = std::env::temp_dir().join(format!("rapidraw-sizes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("present.onnx"), b"hello").unwrap();
        let models = with_installed_sizes(
            vec![
                spec("present", "present.onnx"),
                spec("absent", "absent.onnx"),
            ],
            &dir,
        );
        let manifest = build_manifest(models);
        assert_eq!(manifest.installed_count, 1);
        assert_eq!(
            manifest
                .models
                .iter()
                .find(|m| m.role == "present")
                .unwrap()
                .installed_bytes,
            Some(5)
        );
        assert_eq!(
            manifest
                .models
                .iter()
                .find(|m| m.role == "absent")
                .unwrap()
                .installed_bytes,
            None
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
