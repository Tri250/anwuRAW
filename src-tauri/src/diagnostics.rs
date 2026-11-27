//! P2-2: 诊断会话记录器。
//!
//! 进程内 JSONL 环形缓冲（默认 2000 行），记录诊断事件（GPU 探测/回退、
//! PTP 连接失败、导出失败等），导出为 ZIP（JSONL + 会话元数据）。写入前
//! 对消息做路径脱敏：绝对路径折叠为「…/末两级目录」，用户名/应用私有目录
//! 不离开设备。ZIP 采用 store（无压缩）实现，避免引入新依赖。

use std::collections::VecDeque;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

const RING_CAPACITY: usize = 2000;
const MAX_LINE_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLine {
    /// 毫秒级 UTC 时间戳
    pub ts: u64,
    /// 事件类型，如 "gpu_probe" / "ptp_error" / "export_error"
    pub kind: String,
    /// 事件负载（调用方构造；写入前统一脱敏）
    pub fields: serde_json::Value,
}

pub struct DiagnosticRecorder {
    ring: Mutex<VecDeque<DiagnosticLine>>,
    started: Instant,
}

static DIAGNOSTICS: OnceLock<DiagnosticRecorder> = OnceLock::new();

fn recorder() -> &'static DiagnosticRecorder {
    DIAGNOSTICS.get_or_init(|| DiagnosticRecorder {
        ring: Mutex::new(VecDeque::with_capacity(256)),
        started: Instant::now(),
    })
}

/// 路径脱敏：把字符串中出现的绝对路径（Unix `/…` 或 Windows `C:\…`）折叠为
/// `…/<last two segments>`，其余文本原样保留。目标是诊断里不出现
/// 用户主目录名 / 应用私有目录前缀。
pub fn sanitize_paths_in_str(input: &str) -> String {
    let is_sep = |c: char| c == '/' || c == '\\';
    let is_path_start = |bytes: &[u8], i: usize| -> bool {
        let c = bytes[i] as char;
        // Unix absolute path
        if c == '/' {
            return i == 0 || !bytes.get(i.wrapping_sub(1)).copied().is_some_and(|p| (p as char).is_ascii_alphanumeric() || p == b'_');
        }
        // Windows drive letter X:\ or X:/
        if c.is_ascii_alphabetic() && i + 2 < bytes.len() && bytes[i + 1] == b':' && is_sep(bytes[i + 2] as char) {
            return i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        }
        false
    };

    let bytes: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if is_path_start(&input.as_bytes(), input.char_indices().nth(i).map(|(b, _)| b).unwrap_or(0)) {
            // Try to consume a path-like run of chars.
            let mut j = i;
            let mut segs: Vec<String> = vec![String::new()];
            while j < bytes.len() && !bytes[j].is_whitespace() && bytes[j] != '"' && bytes[j] != '\'' && bytes[j] != ')' {
                if is_sep(bytes[j]) {
                    segs.push(String::new());
                } else {
                    segs.last_mut().unwrap().push(bytes[j]);
                }
                j += 1;
            }
            // Heuristic: an absolute path — Unix leading "/" (empty first
            // segment) or Windows drive letter ("C:").
            let looks_like_path = segs.len() >= 2
                && (segs[0].is_empty() || segs[0].ends_with(':'));
            if looks_like_path {
                let last_two: Vec<&str> = segs.iter().rev().take(2).map(|s| s.as_str()).collect();
                out.push_str("…/");
                out.push_str(last_two[1]);
                out.push('/');
                out.push_str(last_two[0]);
                i = j;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn sanitize_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => *s = sanitize_paths_in_str(s),
        serde_json::Value::Array(items) => items.iter_mut().for_each(sanitize_value),
        serde_json::Value::Object(map) => map.values_mut().for_each(sanitize_value),
        _ => {}
    }
}

impl DiagnosticRecorder {
    /// 记录一条诊断事件；超出容量即丢弃最旧的一行，单行超长截断。
    pub fn record(&self, kind: &str, mut fields: serde_json::Value) {
        sanitize_value(&mut fields);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let line = DiagnosticLine {
            ts,
            kind: kind.to_string(),
            fields,
        };
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        if ring.len() >= RING_CAPACITY {
            ring.pop_front();
        }
        ring.push_back(line);
    }

    pub fn snapshot(&self) -> Vec<DiagnosticLine> {
        self.ring.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    /// JSONL 序列化（含会话头一行）。
    pub fn to_jsonl(&self) -> Vec<u8> {
        let mut out = String::new();
        let header = serde_json::json!({
            "type": "session_header",
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "uptimeSec": self.started.elapsed().as_secs(),
        });
        out.push_str(&header.to_string());
        out.push('\n');
        for line in self.snapshot() {
            let mut obj = serde_json::to_string(&line).unwrap_or_default();
            if obj.len() > MAX_LINE_BYTES {
                obj.truncate(MAX_LINE_BYTES);
            }
            out.push_str(&obj);
            out.push('\n');
        }
        out.into_bytes()
    }
}

/// 进程内便捷入口（后端各模块调用）。
pub fn record_diagnostic(kind: &str, fields: serde_json::Value) {
    recorder().record(kind, fields);
}

// ---------------------------------------------------------------------------
// Store-only ZIP writer
// ---------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *entry = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

const DOS_TIME: u16 = 0; // 1980-01-01 00:00，时间戳不承载信息
const DOS_DATE: u16 = 0x0021; // 1980-01-01

/// 构造 store-only ZIP（无压缩）。`entries` 按顺序写入，文件名必须是
/// 安全 ASCII 路径（调用方控制）。
pub fn build_store_zip(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, data) in entries {
        let local_offset = out.len() as u32;
        let crc = crc32(data);
        let name_bytes = name.as_bytes();
        // Local file header
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method: store
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // compressed
        out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // uncompressed
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);
        // Central directory entry
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&0u16.to_le_bytes()); // method: store
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk start
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&local_offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }
    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);
    // EOCD
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // disk
    out.extend_from_slice(&0u16.to_le_bytes()); // start disk
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportedDiagnostics {
    pub path: String,
    pub lines: usize,
    pub size_bytes: u64,
}

/// 前端推送诊断事件（如 GPU 回退通知）。
#[tauri::command]
pub fn record_diagnostic_event(kind: String, fields: serde_json::Value) {
    record_diagnostic(&kind, fields);
}

/// 导出诊断会话 ZIP（JSONL + 元数据），原子落盘。
#[tauri::command]
pub fn export_diagnostics_session(dest_path: String) -> Result<ExportedDiagnostics, String> {
    let rec = recorder();
    let jsonl = rec.to_jsonl();
    let lines = jsonl.iter().filter(|&&b| b == b'\n').count();
    let meta = serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "uptimeSec": rec.started.elapsed().as_secs(),
        "lineCount": lines,
    });
    let entries = vec![
        ("diagnostics.jsonl".to_string(), jsonl),
        ("session.json".to_string(), serde_json::to_vec_pretty(&meta).unwrap_or_default()),
    ];
    let zip = build_store_zip(&entries);

    let dest = PathBuf::from(&dest_path);
    let tmp = dest.with_file_name(format!(
        ".{}.part",
        dest.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "diagnostics.zip".to_string())
    ));
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create temp file '{}': {}", tmp.display(), e))?;
        f.write_all(&zip)
            .map_err(|e| format!("Failed to write diagnostics: {e}"))?;
        f.sync_all().map_err(|e| format!("Failed to flush diagnostics: {e}"))?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize '{}': {}", dest.display(), e)
    })?;
    Ok(ExportedDiagnostics {
        path: dest_path,
        lines: lines.saturating_sub(1), // 不含会话头
        size_bytes: zip.len() as u64,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_folds_absolute_paths() {
        assert_eq!(
            sanitize_paths_in_str("failed to write /home/alice/Photos/IMG_0001.CR2 in export"),
            "failed to write …/Photos/IMG_0001.CR2 in export"
        );
        assert_eq!(
            sanitize_paths_in_str("PTP download /data/user/0/com.anwu/raw/cache/dl.jpg failed"),
            "PTP download …/cache/dl.jpg failed"
        );
        assert_eq!(
            sanitize_paths_in_str("windows C:\\Users\\bob\\out.jpg skipped"),
            "windows …/bob/out.jpg skipped"
        );
        // Extension-less paths still fold.
        assert_eq!(
            sanitize_paths_in_str("read /etc/hosts ok"),
            "read …/etc/hosts ok"
        );
        // Non-path text untouched.
        assert_eq!(sanitize_paths_in_str("plain text 42%"), "plain text 42%");
    }

    #[test]
    fn ring_evicts_oldest() {
        let rec = DiagnosticRecorder {
            ring: Mutex::new(VecDeque::new()),
            started: Instant::now(),
        };
        for i in 0..(RING_CAPACITY + 50) {
            rec.record("t", serde_json::json!({ "i": i }));
        }
        let snap = rec.snapshot();
        assert_eq!(snap.len(), RING_CAPACITY);
        assert_eq!(snap[0].fields["i"], 50);
        assert_eq!(snap.last().unwrap().fields["i"], RING_CAPACITY + 49);
    }

    #[test]
    fn sanitize_value_walks_structures() {
        let mut v = serde_json::json!({
            "msg": "load /home/secret/Photos/raw.nef failed",
            "list": ["/etc/hosts", 1],
            "nested": { "p": "/data/user/0/app/files/x.jpg" }
        });
        sanitize_value(&mut v);
        assert_eq!(v["msg"], "load …/Photos/raw.nef failed");
        assert_eq!(v["list"][0], "…/etc/hosts");
        assert_eq!(v["nested"]["p"], "…/files/x.jpg");
    }

    #[test]
    fn store_zip_is_parseable() {
        let entries = vec![
            ("a.txt".to_string(), b"hello".to_vec()),
            ("dir/b.json".to_string(), b"{\"k\":1}".to_vec()),
        ];
        let zip = build_store_zip(&entries);
        // EOCD signature at the end (no comment).
        let tail = &zip[zip.len() - 22..];
        assert_eq!(&tail[0..4], &0x0605_4b50u32.to_le_bytes());
        assert_eq!(u16::from_le_bytes([tail[10], tail[11]]), 2);
        let central_offset = u32::from_le_bytes(tail[16..20].try_into().unwrap()) as usize;
        // First central entry signature.
        assert_eq!(&zip[central_offset..central_offset + 4], &0x0201_4b50u32.to_le_bytes());
        // Local header at offset 0.
        assert_eq!(&zip[0..4], &0x0403_4b50u32.to_le_bytes());
        // Stored sizes match payload sizes (no compression).
        let size = u32::from_le_bytes(zip[18..22].try_into().unwrap());
        assert_eq!(size, 5);
        // Local header: 30-byte fixed part, then name "a.txt" (5 bytes),
        // then the stored payload.
        let name_len = u16::from_le_bytes(zip[26..28].try_into().unwrap()) as usize;
        assert_eq!(name_len, 5);
        assert_eq!(&zip[30..35], b"a.txt");
        assert_eq!(&zip[35..40], b"hello");
        assert_eq!(crc32(b"hello"), 0x3610_A686);
    }
}
