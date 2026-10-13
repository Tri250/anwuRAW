use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalEditSession {
    pub source: String,
    pub output: String,
    pub format: String,
    pub jpeg_quality: u8,
}

#[derive(Clone, Debug)]
pub struct HeadlessExportSession {
    pub source: String,
    pub output: String,
    pub format: String,
    pub quality: u8,
    pub keep_metadata: bool,
    pub adjustments_override: Option<String>,
}

#[derive(Clone, Debug)]
pub enum LaunchRequest {
    None,
    OpenFile(String),
    EditSession(ExternalEditSession),
    HeadlessExport(HeadlessExportSession),
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPayload {
    pub open_with_file: Option<String>,
    pub edit_session: Option<ExternalEditSession>,
}

pub fn parse_launch_args(args: &[String]) -> LaunchRequest {
    if args.first().map(|s| s.as_str()) == Some("export") {
        let mut iter = args.iter().skip(1);

        let mut source = String::new();
        let mut output = String::new();
        let mut format = String::from("jpeg");
        let mut quality = 90;
        let mut keep_metadata = false;
        let mut adjustments_override = None;

        if let Some(src) = iter.next()
            && !src.starts_with('-')
        {
            source = src.clone();
        }

        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--output" => {
                    if let Some(out) = iter.next() {
                        output = out.clone();
                    }
                }
                "--format" => {
                    if let Some(fmt) = iter.next() {
                        format = fmt.clone();
                    }
                }
                "--quality" => {
                    if let Some(q) = iter.next() {
                        quality = q.parse().unwrap_or(90);
                    }
                }
                "--keep-metadata" => keep_metadata = true,
                "--adjustments" => {
                    if let Some(adj) = iter.next() {
                        adjustments_override = Some(adj.clone());
                    }
                }
                _ => {}
            }
        }

        return LaunchRequest::HeadlessExport(HeadlessExportSession {
            source,
            output,
            format,
            quality,
            keep_metadata,
            adjustments_override,
        });
    }

    let mut edit: Option<String> = None;
    let mut output: Option<String> = None;
    let mut format: Option<String> = None;
    let mut quality: Option<u8> = None;
    let mut plain: Option<String> = None;

    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--edit" => edit = iter.next().cloned(),
            "--output" => output = iter.next().cloned(),
            "--format" => format = iter.next().cloned(),
            "--quality" => quality = iter.next().and_then(|q| q.parse().ok()),
            s if !s.starts_with('-') && plain.is_none() => plain = Some(s.to_string()),
            _ => {}
        }
    }

    match (edit, output) {
        (Some(source), Some(output)) => {
            let format = format.unwrap_or_else(|| {
                std::path::Path::new(&output)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_else(|| "jpg".to_string())
            });
            let format = match format.as_str() {
                "tif" => "tiff".to_string(),
                _ => format,
            };
            LaunchRequest::EditSession(ExternalEditSession {
                source,
                output,
                format,
                jpeg_quality: quality.unwrap_or(90),
            })
        }
        (Some(source), None) => LaunchRequest::OpenFile(source),
        _ => match plain {
            Some(path) => LaunchRequest::OpenFile(path),
            None => LaunchRequest::None,
        },
    }
}

fn handle_file_open(app_handle: &tauri::AppHandle, path: PathBuf) {
    if let Some(path_str) = path.to_str()
        && let Err(e) = app_handle.emit("open-with-file", path_str)
    {
        log::error!("Failed to emit open-with-file event: {}", e);
    }
}

pub fn emit_launch_request(app_handle: &tauri::AppHandle, request: LaunchRequest) {
    match request {
        LaunchRequest::EditSession(session) => {
            if let Err(e) = app_handle.emit("external-edit-session", &session) {
                log::error!("Failed to emit external-edit-session event: {}", e);
            }
        }
        LaunchRequest::OpenFile(path) => {
            handle_file_open(app_handle, PathBuf::from(path));
        }
        LaunchRequest::HeadlessExport(_) => {
            println!(
                "Error: Headless export cannot be attached to an already running GUI instance."
            );
        }
        LaunchRequest::None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// TR-LR-1: 无头导出参数全解析（含 quality 非法值回退 90、缺省 format）。
    #[test]
    fn tr_lr_1_headless_export_parse() {
        let req = parse_launch_args(&args(&["export", "in.raf", "--output", "out.tiff", "--quality", "75", "--keep-metadata", "--adjustments", "{\"exposure\":1}"]));
        match req {
            LaunchRequest::HeadlessExport(s) => {
                assert_eq!(s.source, "in.raf");
                assert_eq!(s.output, "out.tiff");
                // 语义：无头导出的格式只来自 --format（缺省 jpeg），
                // 不像 edit-session 分支那样从输出扩展名推断
                assert_eq!(s.format, "jpeg");
                assert_eq!(s.quality, 75);
                assert!(s.keep_metadata);
                assert_eq!(s.adjustments_override.as_deref(), Some("{\"exposure\":1}"));
            }
            other => panic!("expected headless export, got {other:?}"),
        }

        // 非法 quality 回退默认 90；无 --output 时字段为空（由执行侧报错）
        let req = parse_launch_args(&args(&["export", "in.jpg", "--quality", "abc"]));
        match req {
            LaunchRequest::HeadlessExport(s) => {
                assert_eq!(s.quality, 90);
                assert_eq!(s.format, "jpeg");
                assert!(s.output.is_empty());
                assert!(!s.keep_metadata);
            }
            other => panic!("expected headless export, got {other:?}"),
        }
    }

    /// TR-LR-2: 外部编辑会话——--edit + --output；tif→tiff 归一；quality 缺省 90。
    #[test]
    fn tr_lr_2_edit_session_parse() {
        let req = parse_launch_args(&args(&["--edit", "raw.raf", "--output", "out.tif", "--quality", "80"]));
        match req {
            LaunchRequest::EditSession(s) => {
                assert_eq!(s.source, "raw.raf");
                assert_eq!(s.format, "tiff");
                assert_eq!(s.jpeg_quality, 80);
            }
            other => panic!("expected edit session, got {other:?}"),
        }

        // 扩展名缺省格式推断
        let req = parse_launch_args(&args(&["--edit", "a.jpg", "--output", "b.png"]));
        match req {
            LaunchRequest::EditSession(s) => assert_eq!(s.format, "png"),
            other => panic!("expected edit session, got {other:?}"),
        }
    }

    /// TR-LR-3: 文件打开与空参数；--edit 无 --output → OpenFile。
    #[test]
    fn tr_lr_3_open_and_fallbacks() {
        assert!(matches!(parse_launch_args(&args(&["pic.jpg"])), LaunchRequest::OpenFile(p) if p == "pic.jpg"));
        assert!(matches!(parse_launch_args(&args(&["--edit", "x.raf"])), LaunchRequest::OpenFile(p) if p == "x.raf"));
        assert!(matches!(parse_launch_args(&args(&[])), LaunchRequest::None));
        // 选项在前、位置参数在后（--output 单独出现不构成 edit session）
        assert!(matches!(parse_launch_args(&args(&["--output", "o.jpg", "p.jpg"])), LaunchRequest::OpenFile(p) if p == "p.jpg"));
    }
}
