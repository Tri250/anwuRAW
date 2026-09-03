//! IPTC 元数据读写 —— APP13 (Photoshop 3.0) Resource Block 段
//!
//! JPEG 中 IPTC 存放在 APP13 marker（FF E4）里，
//! 头部为字符串 "Photoshop 3.0\0"，后面是 Resource Block 列表。
//! 我们只关心 Resource Block 中的 IPTC-NAA 块。
//!
//! 参考:
//!   - Adobe Photoshop File Formats Specification v1.4
//!   - IPTC-NAA IIM 4.1

use std::collections::HashMap;
use std::io::Cursor;

// ============ Resource Block 签名 ============
/// Photoshop 3.0 IPTC 资源块签名
const RESOURCE_SIGNATURE: [u8; 4] = [b'8', b'B', b'I', b'M'];

/// IPTC-NAA 标准 Resource ID
const IPTC_NAA_2000: u16 = 0x0404;

/// Photoshop 3.0 "Image Source Data"（嵌入式）
const PHOTOSHOP_3_ID: u16 = 0x03E9;

// ============ JPEG Marker ============
const JPEG_SOI: u8 = 0xD8;
const JPEG_EOI: u8 = 0xD9;
const JPEG_APP13: u8 = 0xE4; // FF E4
const MARKER_PREFIX: u8 = 0xFF;

/// 常见 IPTC-NAA 2:xxx 字段标识（Record 2）
/// (record_number, data_set_number) → 描述
pub mod iptc_tags {
    /// Headline (2:105)
    pub const HEADLINE: (u16, u16) = (2, 105);
    /// Caption / Description (2:120)
    pub const CAPTION: (u16, u16) = (2, 120);
    /// Keywords (2:25) — 多个 0x1C 分隔
    pub const KEYWORDS: (u16, u16) = (2, 25);
    /// Creator / Byline (2:80)
    pub const CREATOR: (u16, u16) = (2, 80);
    /// Creator Title (2:85)
    pub const CREATOR_TITLE: (u16, u16) = (2, 85);
    /// City (2:90)
    pub const CITY: (u16, u16) = (2, 90);
    /// Province / State (2:95)
    pub const PROVINCE: (u16, u16) = (2, 95);
    /// Country Name (2:101)
    pub const COUNTRY: (u16, u16) = (2, 101);
    /// Country Code (2:100)
    pub const COUNTRY_CODE: (u16, u16) = (2, 100);
    /// Copyright Notice (2:116)
    pub const COPYRIGHT: (u16, u16) = (2, 116);
    /// Credit (2:110)
    pub const CREDIT: (u16, u16) = (2, 110);
    /// Source (2:115)
    pub const SOURCE: (u16, u16) = (2, 115);
    /// Special Instructions (2:40)
    pub const SPECIAL_INSTRUCTIONS: (u16, u16) = (2, 40);
    /// Date Created (2:55)
    pub const DATE_CREATED: (u16, u16) = (2, 55);
    /// Time Created (2:60)
    pub const TIME_CREATED: (u16, u16) = (2, 60);
    /// Digital Date (2:62)
    pub const DIGITAL_DATE: (u16, u16) = (2, 62);
    /// Digital Time (2:63)
    pub const DIGITAL_TIME: (u16, u16) = (2, 63);
    /// Job ID (2:184)
    pub const JOB_ID: (u16, u16) = (2, 184);
}

/// 单个 IPTC-NAA DataSet 条目
#[derive(Clone, Debug)]
pub struct IptcDataSet {
    pub record_number: u16,
    pub data_set_number: u16,
    pub data: Vec<u8>,
}

impl IptcDataSet {
    pub fn as_string(&self) -> String {
        // IPTC 通常使用 ISO-8859-1，这与 UTF-8 兼容度很高。
        String::from_utf8_lossy(&self.data).trim_end_matches('\0').to_string()
    }
}

/// 从字节缓冲区（游标位置）读取一个 Resource Block
fn read_resource_block(buf: &[u8], offset: usize) -> Option<(usize, u16, Vec<u8>)> {
    let data = buf.get(offset..)?;
    if data.len() < 4 {
        return None;
    }
    if data[0] != RESOURCE_SIGNATURE[0]
        || data[1] != RESOURCE_SIGNATURE[1]
        || data[2] != RESOURCE_SIGNATURE[2]
        || data[3] != RESOURCE_SIGNATURE[3]
    {
        return None;
    }
    let data = &data[4..];
    if data.len() < 2 {
        return None;
    }
    let resource_id = (data[0] as u16) << 8 | data[1] as u16;
    let data = &data[2..];

    // Pascal string 名称：1 字节长度 + length 字节名称（padded to even）
    if data.is_empty() {
        return None;
    }
    let name_len = data[0] as usize;
    let name_total = if (name_len + 1) % 2 == 0 {
        name_len + 1
    } else {
        name_len + 1 + 1
    };
    let data = data.get(name_total..)?;

    if data.len() < 4 {
        return None;
    }
    let size = (data[0] as usize) << 24
        | (data[1] as usize) << 16
        | (data[2] as usize) << 8
        | data[3] as usize;
    let data = &data[4..];

    let padding = if size % 2 == 0 { 0 } else { 1 };
    if data.len() < size {
        return None;
    }
    let payload = data[..size].to_vec();
    let consumed = 4 + name_total + 4 + size + padding;
    let abs_consumed = offset + consumed;

    Some((abs_consumed, resource_id, payload))
}

/// 解析 IPTC-NAA IIM 4.1 块，提取所有 DataSet
fn parse_iim_block(iim: &[u8]) -> Vec<IptcDataSet> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos + 1 <= iim.len() {
        let marker = iim[pos];
        if marker != 0x1C {
            pos += 1;
            continue;
        }
        if pos + 1 + 2 + 2 + 2 > iim.len() {
            break;
        }
        // 0x1C + record_number(2) + data_set_number(2) + data_size(2 或 4)
        let mut p = pos + 1;
        let record = (iim[p] as u16) << 8 | iim[p + 1] as u16;
        p += 2;
        let dset = (iim[p] as u16) << 8 | iim[p + 1] as u16;
        p += 2;

        // 扩展数据大小标志
        let (size, size_bytes) = if iim[p] & 0x80 != 0 {
            if pos + 1 + 2 + 2 + 4 > iim.len() {
                break;
            }
            let _ = iim[p]; // extended marker
            let size = (iim[p + 1] as usize) << 24
                | (iim[p + 2] as usize) << 16
                | (iim[p + 3] as usize) << 8
                | iim[p + 4] as usize;
            (size, 5)
        } else {
            let size = (iim[p] as usize) << 8 | iim[p + 1] as usize;
            (size, 2)
        };
        p += size_bytes;
        if p + size > iim.len() {
            break;
        }
        let data = iim[p..p + size].to_vec();
        out.push(IptcDataSet {
            record_number: record,
            data_set_number: dset,
            data,
        });
        pos = p + size;
    }
    out
}

/// 解析 JPEG 文件，返回 IPTC 字段 key→value map。
/// 只在 APP13 (FF E4) marker 中查找 Photoshop 3.0 IPTC-NAA 块。
pub fn read_iptc_from_jpeg(bytes: &[u8]) -> Result<HashMap<String, String>, String> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != JPEG_SOI {
        return Err("Not a valid JPEG file".to_string());
    }

    let mut pos = 2;
    let mut found_iim: Option<Vec<u8>> = None;

    while pos + 4 < bytes.len() {
        // 跳过填充 0xFF
        while pos < bytes.len() && bytes[pos] == 0xFF {
            pos += 1;
        }
        if pos >= bytes.len() {
            break;
        }
        let marker = bytes[pos];
        pos += 1;

        if marker == JPEG_EOI || marker == 0xDA /* SOS */ {
            break;
        }
        if pos + 2 > bytes.len() {
            break;
        }
        let length = (bytes[pos] as usize) << 8 | bytes[pos + 1] as usize;
        if length < 2 {
            break;
        }
        let segment_start = pos + 2;
        let segment_end = pos + length;
        if segment_end > bytes.len() {
            break;
        }

        if marker == JPEG_APP13 {
            let header = &bytes[segment_start..segment_end.min(segment_start + 16)];
            let expected = b"Photoshop 3.0\0";
            if header.len() >= expected.len() && &header[..expected.len()] == expected {
                let rest = &bytes[segment_start + expected.len()..segment_end];
                // 遍历所有 Resource Blocks
                let mut rb_pos = 0;
                while let Some((next, rid, payload)) = read_resource_block(rest, rb_pos) {
                    if rid == IPTC_NAA_2000 {
                        found_iim = Some(payload);
                        break;
                    }
                    rb_pos = next;
                    if rb_pos >= rest.len() {
                        break;
                    }
                }
            }
        }

        pos = segment_end;
    }

    let iim = found_iim.ok_or_else(|| "No IPTC data found".to_string())?;
    let data_sets = parse_iim_block(&iim);
    let mut map = HashMap::new();
    for ds in data_sets {
        let key = format!("{}:{}", ds.record_number, ds.data_set_number);
        map.insert(key, ds.as_string());
    }
    Ok(map)
}

fn encode_iim_data_set(record: u16, dset: u16, value: &str) -> Vec<u8> {
    let data = value.as_bytes();
    let len = data.len();
    let mut out = Vec::new();
    out.push(0x1C); // IIM marker
    out.push(((record >> 8) & 0xFF) as u8);
    out.push((record & 0xFF) as u8);
    out.push(((dset >> 8) & 0xFF) as u8);
    out.push((dset & 0xFF) as u8);
    if len <= 0x7FFF {
        out.push(((len >> 8) & 0xFF) as u8);
        out.push((len & 0xFF) as u8);
    } else {
        // 扩展模式（16bit 数据长度）
        out.push(0x80);
        out.push(0);
        out.push(0);
        out.push(((len >> 8) & 0xFF) as u8);
        out.push((len & 0xFF) as u8);
    }
    out.extend_from_slice(data);
    out
}

/// 构造一个 APP13 segment 的完整字节（从 FFE4 marker 开始到 segment end 前）
fn build_app13_segment(iim_bytes: &[u8]) -> Vec<u8> {
    let mut seg = Vec::new();
    // Photoshop 3.0 header
    seg.extend_from_slice(b"Photoshop 3.0\0");
    // Resource Block
    let mut rb = Vec::new();
    rb.extend_from_slice(&RESOURCE_SIGNATURE);
    rb.push((IPTC_NAA_2000 >> 8) as u8);
    rb.push((IPTC_NAA_2000 & 0xFF) as u8);
    // Pascal 空名称（0长度 + padding）
    rb.push(0u8);
    rb.push(0u8);
    // size
    rb.push(((iim_bytes.len() >> 24) & 0xFF) as u8);
    rb.push(((iim_bytes.len() >> 16) & 0xFF) as u8);
    rb.push(((iim_bytes.len() >> 8) & 0xFF) as u8);
    rb.push((iim_bytes.len() & 0xFF) as u8);
    rb.extend_from_slice(iim_bytes);

    seg.extend_from_slice(&rb);
    seg
}

/// 把 IPTC 字段写回 JPEG。
/// 先清理旧的 APP13 段，再插入新的 APP13 段（紧跟在 APP0 JFIF 之后，或 SOF 之前）。
pub fn write_iptc_to_jpeg(bytes: &[u8], fields: &HashMap<String, String>) -> Result<Vec<u8>, String> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != JPEG_SOI {
        return Err("Not a valid JPEG file".to_string());
    }

    // 先构建新的 IIM block
    let mut iim = Vec::new();
    for (key, value) in fields {
        let parts: Vec<&str> = key.split(':').collect();
        if parts.len() != 2 {
            continue;
        }
        let record = parts[0].parse::<u16>().unwrap_or(2);
        let dset = parts[1].parse::<u16>().unwrap_or(0);
        iim.extend(encode_iim_data_set(record, dset, value));
    }
    if iim.is_empty() {
        return Err("No IPTC fields to write".to_string());
    }

    let new_app13_body = build_app13_segment(&iim);
    let new_app13_total = 2 + 2 + new_app13_body.len(); // FFE4 + length + body
    let length = new_app13_total - 2;
    let mut new_app13_seg = Vec::with_capacity(new_app13_total);
    new_app13_seg.push(MARKER_PREFIX);
    new_app13_seg.push(JPEG_APP13);
    new_app13_seg.push(((length >> 8) & 0xFF) as u8);
    new_app13_seg.push((length & 0xFF) as u8);
    new_app13_seg.extend_from_slice(&new_app13_body);

    // 第一遍：收集非 APP13 段，记录插入点
    struct Seg {
        data: Vec<u8>,
    }
    let mut segments: Vec<Seg> = Vec::new();
    let mut insert_idx = 0; // 在哪个 segment 之后插入新 APP13
    let mut pos = 2;
    while pos + 4 < bytes.len() {
        while pos < bytes.len() && bytes[pos] == 0xFF {
            pos += 1;
        }
        if pos >= bytes.len() {
            break;
        }
        let marker = bytes[pos];
        pos += 1;
        if marker == JPEG_EOI || marker == 0xDA {
            break;
        }
        if pos + 2 > bytes.len() {
            break;
        }
        let length = (bytes[pos] as usize) << 8 | bytes[pos + 1] as usize;
        if length < 2 {
            break;
        }
        let seg_start = pos - 1; // 包含 marker
        let seg_end = pos + length;
        if seg_end > bytes.len() {
            break;
        }
        let segment_data = bytes[seg_start..seg_end].to_vec();

        if marker == JPEG_APP13 {
            // 找到第一个 APP13（可能不是 Photoshop 3.0 的就跳过清理了）
            let body = &bytes[pos + 2..seg_end];
            if body.len() >= 14 && &body[..13] == b"Photoshop 3.0\0" {
                // 替换为 None（不加入 segments），记录插入位置
                pos = seg_end;
                continue;
            }
        }

        // 在 SOF 之前或 APP0 之后插入
        let marker_prefix = bytes[pos - 1];
        let _ = marker_prefix;
        let marker_byte = marker;
        if marker_byte == 0xC0
            || marker_byte == 0xC1
            || marker_byte == 0xC2
            || marker_byte == 0xC3
            || marker_byte == 0xC5
            || marker_byte == 0xC6
            || marker_byte == 0xC7
            || marker_byte == 0xC9
            || marker_byte == 0xCA
            || marker_byte == 0xCB
            || marker_byte == 0xCD
            || marker_byte == 0xCE
            || marker_byte == 0xCF
        {
            // SOF：在这之前插入
            if insert_idx == 0 {
                insert_idx = segments.len();
            }
        }
        segments.push(Seg { data: segment_data });
        pos = seg_end;
    }
    // 如果没有找到好的插入点，就在第一个 segment 后面（通常是 APP0 JFIF）
    if insert_idx == 0 {
        insert_idx = 1;
    }

    // 第二遍：组装新的 JPEG
    let mut out = Vec::new();
    out.push(0xFF);
    out.push(JPEG_SOI);
    for (i, seg) in segments.iter().enumerate() {
        if i == insert_idx {
            out.extend_from_slice(&new_app13_seg);
        }
        out.extend_from_slice(&seg.data);
    }
    // 追加剩余数据（如果有）
    if pos < bytes.len() {
        out.extend_from_slice(&bytes[pos..]);
    }
    // 确保 EOI
    if out.len() >= 2 && (out[out.len() - 2] != 0xFF || out[out.len() - 1] != JPEG_EOI) {
        out.push(0xFF);
        out.push(JPEG_EOI);
    }

    // 清理 unused
    let _ = Cursor::new(out.clone());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip_empty_is_invalid() {
        let data = HashMap::new();
        // 空 map 不能写
        let bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9];
        let result = write_iptc_to_jpeg(&bytes, &data);
        assert!(result.is_err());
    }
}

#[tauri::command]
pub fn read_iptc_metadata(path: String) -> Result<HashMap<String, String>, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    read_iptc_from_jpeg(&bytes)
}

#[tauri::command]
pub fn write_iptc_metadata(path: String, fields: HashMap<String, String>) -> Result<(), String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let new_bytes = write_iptc_to_jpeg(&bytes, &fields)?;
    std::fs::write(&path, new_bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn batch_update_iptc_metadata(
    paths: Vec<String>,
    fields: HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let mut success = 0u32;
    let mut failed = 0u32;
    let mut errors: Vec<String> = Vec::new();
    for p in &paths {
        match std::fs::read(p) {
            Ok(bytes) => {
                match write_iptc_to_jpeg(&bytes, &fields) {
                    Ok(new_bytes) => {
                        if let Err(e) = std::fs::write(p, new_bytes) {
                            failed += 1;
                            errors.push(format!("{}: write error {}", p, e));
                        } else {
                            success += 1;
                        }
                    }
                    Err(e) => {
                        failed += 1;
                        errors.push(format!("{}: {}", p, e));
                    }
                }
            }
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: {}", p, e));
            }
        }
    }
    Ok(serde_json::json!({
        "success": success,
        "failed": failed,
        "total": paths.len() as u32,
        "errors": errors
    }))
}
