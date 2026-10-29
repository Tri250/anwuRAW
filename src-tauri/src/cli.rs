//! CLI 子命令（G6）：`capabilities`、`validate`、`image-info`、`--help`、`--version`。
//!
//! 这些子命令在应用启动前由 `run_cli` 处理并直接退出，不启动 GUI 窗口，
//! 供 Agent/MCP 客户端做能力发现与参数校验（见 docs/agent-cli.md）。
//! `export` 子命令仍走完整启动流程（见 launch_request::parse_launch_args）。

use serde::Serialize;
use serde_json::Value;

/// 构建期内嵌的参数 schema（tools/generate-adjustments-schema.mjs 生成）。
pub const ADJUSTMENTS_SCHEMA_JSON: &str = include_str!("../resources/adjustments-schema.json");

const USAGE: &str = "\
anwuRAW command line interface

Usage:
  anwuRAW capabilities                  Print engine capabilities + adjustment schema (JSON)
  anwuRAW validate [--adjustments] FILE Validate an adjustments JSON file (JSON report)
  anwuRAW image-info FILE               Print image metadata (JSON)
  anwuRAW export [SOURCE] [OPTIONS]     Headless export
  anwuRAW --help | --version

Validate options:
  --adjustments FILE                    Adjustments JSON file to validate (GUI sidecar compatible)

Export options:
  SOURCE                                Image file or folder
  --output PATH                         Output file or folder (required)
  --format FORMAT                       jpeg | png | webp | tiff (default: jpeg)
  --quality N                           1-100 (default: 90)
  --tiff-bit-depth N                    8 | 16 (default: 16)
  --long-edge N                         Resize so the long edge is at most N pixels
  --keep-metadata                       Keep EXIF metadata
  --adjustments FILE                    Adjustments JSON (same schema as GUI sidecars)
";

const VALIDATE_ERROR_LIMIT: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliCapabilities {
    name: &'static str,
    version: &'static str,
    commands: Vec<&'static str>,
    schema: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidateReport {
    path: String,
    valid: bool,
    errors: Vec<Value>,
}

fn push_error(errors: &mut Vec<Value>, path: &str, message: String) {
    if errors.len() < VALIDATE_ERROR_LIMIT {
        errors.push(serde_json::json!({ "path": path, "message": message }));
    }
}

/// 递归校验：JSON 值 vs 参数 spec。null 视为"重置为默认"，总是通过。
fn validate_value(path: &str, value: &Value, spec: &Value, errors: &mut Vec<Value>) {
    if value.is_null() {
        return;
    }
    let spec_type = spec.get("type").and_then(Value::as_str).unwrap_or("any");
    match spec_type {
        "number" => match value.as_f64() {
            Some(num) => {
                if let Some(min) = spec.get("min").and_then(Value::as_f64)
                    && num < min
                {
                    push_error(
                        errors,
                        path,
                        format!("value {num} is below the minimum {min}"),
                    );
                }
                if let Some(max) = spec.get("max").and_then(Value::as_f64)
                    && num > max
                {
                    push_error(
                        errors,
                        path,
                        format!("value {num} is above the maximum {max}"),
                    );
                }
            }
            None => push_error(errors, path, "expected a number".to_string()),
        },
        "boolean" => {
            if value.as_bool().is_none() {
                push_error(errors, path, "expected a boolean".to_string());
            }
        }
        "enum" => {
            let allowed = spec.get("values").and_then(Value::as_array);
            let is_valid = value.as_str().is_some_and(|s| {
                allowed.is_some_and(|vals| vals.iter().any(|v| v.as_str() == Some(s)))
            });
            if !is_valid {
                let shown = allowed
                    .map(|vals| {
                        vals.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                push_error(
                    errors,
                    path,
                    format!("expected one of [{shown}], got '{}'", format_json(value)),
                );
            }
        }
        "string" => {
            if !value.is_string() {
                push_error(errors, path, "expected a string".to_string());
            }
        }
        "array" => {
            if !value.is_array() {
                push_error(errors, path, "expected an array".to_string());
            } else if let Some(item_spec) = spec.get("items")
                && let Some(items) = value.as_array()
            {
                for (index, item) in items.iter().enumerate() {
                    let item_path = format!("{path}[{index}]");
                    validate_value(&item_path, item, item_spec, errors);
                }
            }
        }
        "object" => {
            let Some(obj) = value.as_object() else {
                push_error(errors, path, "expected an object".to_string());
                return;
            };
            let Some(props) = spec.get("properties").and_then(Value::as_object) else {
                return;
            };
            for (key, item) in obj {
                let item_path = format!("{path}.{key}");
                if let Some(item_spec) = props.get(key) {
                    validate_value(&item_path, item, item_spec, errors);
                } else {
                    push_error(errors, &item_path, format!("unknown key '{}'", key));
                }
            }
        }
        _ => {}
    }
}

fn format_json(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn validate_adjustments_value(adjustments: &Value, schema: &Value, errors: &mut Vec<Value>) {
    let Some(adjustments) = adjustments.as_object() else {
        push_error(
            errors,
            "",
            "expected a JSON object at the top level".to_string(),
        );
        return;
    };
    let Some(params) = schema.get("params").and_then(Value::as_object) else {
        push_error(errors, "", "schema is missing 'params'".to_string());
        return;
    };
    for (key, value) in adjustments {
        let item_path = key.clone();
        if let Some(spec) = params.get(key) {
            validate_value(&item_path, value, spec, errors);
        } else {
            push_error(errors, &item_path, format!("unknown adjustment '{}'", key));
        }
    }
}

fn parse_schema() -> Result<Value, String> {
    serde_json::from_str(ADJUSTMENTS_SCHEMA_JSON)
        .map_err(|e| format!("Failed to parse embedded adjustments schema: {}", e))
}

fn cmd_capabilities() -> i32 {
    let schema = match parse_schema() {
        Ok(schema) => schema,
        Err(error) => {
            cli_eprintln!("{}", error);
            return 2;
        }
    };
    let output = CliCapabilities {
        name: "anwuRAW",
        version: env!("CARGO_PKG_VERSION"),
        commands: vec![
            "capabilities",
            "validate",
            "image-info",
            "export",
            "help",
            "version",
        ],
        schema,
    };
    match serde_json::to_string_pretty(&output) {
        Ok(json) => {
            cli_println!("{}", json);
            0
        }
        Err(error) => {
            cli_eprintln!("Failed to serialize capabilities: {}", error);
            2
        }
    }
}

/// `validate [--adjustments] FILE` -> exit 0 valid / 1 invalid / 2 usage or IO error.
fn cmd_validate(rest: &[String]) -> i32 {
    let mut path: Option<&String> = None;
    let mut iter = rest.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--adjustments" => path = iter.next(),
            s if !s.starts_with('-') => path = Some(arg),
            _ => {}
        }
    }
    let Some(path) = path else {
        cli_eprintln!("Usage: anwuRAW validate [--adjustments] FILE");
        return 2;
    };

    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => {
            cli_eprintln!("Failed to read {}: {}", path, error);
            return 2;
        }
    };
    let adjustments: Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(error) => {
            cli_eprintln!("Failed to parse {} as JSON: {}", path, error);
            return 2;
        }
    };
    let schema = match parse_schema() {
        Ok(schema) => schema,
        Err(error) => {
            cli_eprintln!("{}", error);
            return 2;
        }
    };

    let mut errors = Vec::new();
    validate_adjustments_value(&adjustments, &schema, &mut errors);
    if errors.len() >= VALIDATE_ERROR_LIMIT {
        errors.push(serde_json::json!({
            "path": "",
            "message": format!("more than {} errors; output truncated", VALIDATE_ERROR_LIMIT),
        }));
    }
    let report = ValidateReport {
        path: path.clone(),
        valid: errors.is_empty(),
        errors,
    };
    match serde_json::to_string_pretty(&report) {
        Ok(json) => cli_println!("{}", json),
        Err(error) => {
            cli_eprintln!("Failed to serialize validation report: {}", error);
            return 2;
        }
    }
    if report.valid { 0 } else { 1 }
}

fn rational_to_f64(rational: Option<rawler::formats::tiff::Rational>) -> Option<f64> {
    rational.and_then(|r| {
        if r.d == 0 {
            None
        } else {
            Some(r.n as f64 / r.d as f64)
        }
    })
}

/// `image-info FILE` -> JSON 元数据（rawler 解析，不启动 GUI）。
fn cmd_image_info(path: &str) -> i32 {
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let mut info = serde_json::json!({
        "path": path,
        "fileSizeBytes": file_size,
        "extension": extension,
    });

    match rawler::rawsource::RawSource::new(std::path::Path::new(path)) {
        Ok(source) => {
            let loader = rawler::RawLoader::new();
            match loader.get_decoder(&source) {
                Ok(decoder) => match decoder.raw_metadata(&source, &Default::default()) {
                    Ok(meta) => {
                        info["make"] = serde_json::json!(meta.make);
                        info["model"] = serde_json::json!(meta.model);
                        info["camera"] = serde_json::json!(
                            format!("{} {}", meta.make, meta.model).trim().to_string()
                        );
                        let exif = &meta.exif;
                        if let Some(iso) = exif
                            .iso_speed
                            .map(|v| v as u64)
                            .or(exif.iso_speed_ratings.map(|v| v as u64))
                        {
                            info["iso"] = serde_json::json!(iso);
                        }
                        if let Some(seconds) = rational_to_f64(exif.exposure_time) {
                            info["exposureTimeSeconds"] = serde_json::json!(seconds);
                        }
                        if let Some(fnumber) = rational_to_f64(exif.fnumber) {
                            info["fNumber"] = serde_json::json!(fnumber);
                        }
                        if let Some(focal_length) = rational_to_f64(exif.focal_length) {
                            info["focalLengthMm"] = serde_json::json!(focal_length);
                        }
                        if let Some(lens_make) = &exif.lens_make {
                            info["lensMake"] = serde_json::json!(lens_make);
                        }
                        if let Some(lens_model) = &exif.lens_model {
                            info["lensModel"] = serde_json::json!(lens_model);
                        }
                        if let Some(date_time) = &exif.date_time_original {
                            info["dateTimeOriginal"] = serde_json::json!(date_time);
                        }
                        if let Some(orientation) = exif.orientation {
                            info["orientation"] = serde_json::json!(orientation);
                        }
                    }
                    Err(error) => {
                        info["warning"] =
                            serde_json::json!(format!("metadata extraction failed: {}", error));
                    }
                },
                Err(error) => {
                    info["warning"] =
                        serde_json::json!(format!("no decoder for this file: {}", error));
                }
            }
        }
        Err(error) => {
            info["warning"] = serde_json::json!(format!("failed to open file: {}", error));
        }
    }

    match serde_json::to_string_pretty(&info) {
        Ok(json) => {
            cli_println!("{}", json);
            0
        }
        Err(error) => {
            cli_eprintln!("Failed to serialize image info: {}", error);
            2
        }
    }
}

/// 处理纯 CLI 子命令。返回 `Some(exit_code)` 表示已处理完毕、进程应立即退出；
/// 返回 `None` 表示继续常规启动（GUI / headless export / 文件打开）。
pub fn try_run_cli(args: &[String]) -> Option<i32> {
    match args.first().map(String::as_str) {
        Some("capabilities") => Some(cmd_capabilities()),
        Some("validate") => Some(cmd_validate(args.get(1..).unwrap_or(&[]))),
        Some("image-info") => match args.get(1) {
            Some(path) => Some(cmd_image_info(path)),
            None => {
                cli_eprintln!("Usage: anwuRAW image-info FILE");
                Some(2)
            }
        },
        Some("--help") | Some("-h") | Some("help") => {
            cli_println!("{}", USAGE);
            Some(0)
        }
        Some("--version") | Some("-V") | Some("version") => {
            cli_println!("anwuRAW {}", env!("CARGO_PKG_VERSION"));
            Some(0)
        }
        _ => None,
    }
}
