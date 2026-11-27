//! PTP/IP (ISO 15740 Picture Transfer Protocol over TCP/IP, TCP port 15740):
//! wireless camera import for Android builds where no USB tethering stack
//! (gphoto2) is available. Implements the minimum viable session needed to
//! browse and download images:
//!
//!   InitCommand → InitEvent → OpenSession → GetDeviceInfo → GetObjectHandles
//!   → GetObjectInfo → GetObject (written to disk via temp-file + rename).
//!
//! The session is kept in a module-level mutex (one camera per app run —
//! reconnecting replaces the previous session). All command-driven logic lives
//! on `PtpSession`/`connect_session` so the unit tests can exercise the real
//! protocol state machine against an in-process mock TCP responder.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

pub const PTP_IP_PORT: u16 = 15740;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound for a single PTP/IP packet body (512 MB covers any dataset a
/// camera can return in one transfer while still catching corrupted headers).
const MAX_PACKET_LEN: usize = 512 * 1024 * 1024;

// --- PTP/IP packet container types (u32 LE length + u32 LE type + payload) ---
const PT_INIT_CMD_REQ: u32 = 0x0000_0001;
const PT_INIT_CMD_ACK: u32 = 0x0000_0002;
const PT_INIT_EVT_REQ: u32 = 0x0000_0003;
const PT_INIT_EVT_ACK: u32 = 0x0000_0004;
const PT_OPERATION_REQ: u32 = 0x0000_0006;
const PT_OPERATION_RSP: u32 = 0x0000_0007;
const PT_DATA_START: u32 = 0x0000_0009;
const PT_DATA: u32 = 0x0000_000A;
const PT_DATA_END: u32 = 0x0000_000C;

// --- PTP operation codes used by the import flow ---
const OP_OPEN_SESSION: u16 = 0x1002;
const OP_GET_DEVICE_INFO: u16 = 0x1001;
const OP_GET_OBJECT_HANDLES: u16 = 0x1007;
const OP_GET_OBJECT_INFO: u16 = 0x1008;
const OP_GET_OBJECT: u16 = 0x1009;

const RC_OK: u16 = 0x2001;
const PTP_FORMAT_ASSOCIATION: u16 = 0x3001;

fn describe_response_code(code: u16) -> &'static str {
    match code {
        0x2002 => "general error",
        0x2003 => "session not open",
        0x2005 => "device busy",
        0x2006 => "invalid parameter",
        0x2007 => "transfer cancelled",
        0x2009 => "incomplete transfer",
        0x200d => "invalid object handle",
        0x200e => "access denied",
        0x201d => "invalid parent object",
        _ => "unknown response code",
    }
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

fn read_packet(stream: &mut TcpStream) -> Result<(u32, Vec<u8>), String> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .map_err(|e| format!("PTP/IP connection lost while reading packet header: {e}"))?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len < 8 || len > MAX_PACKET_LEN {
        return Err(format!("Invalid PTP/IP packet length {len}."));
    }
    let mut body = vec![0u8; len - 4];
    stream
        .read_exact(&mut body)
        .map_err(|e| format!("PTP/IP connection lost while reading packet body: {e}"))?;
    let ptype = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    Ok((ptype, body.split_off(4)))
}

fn write_packet(stream: &mut TcpStream, ptype: u32, payload: &[u8]) -> Result<(), String> {
    let total = (8 + payload.len()) as u32;
    let mut buf = Vec::with_capacity(total as usize);
    buf.extend_from_slice(&total.to_le_bytes());
    buf.extend_from_slice(&ptype.to_le_bytes());
    buf.extend_from_slice(payload);
    stream
        .write_all(&buf)
        .map_err(|e| format!("PTP/IP connection lost while sending a packet: {e}"))
}

fn write_wchar(buf: &mut Vec<u8>, s: &str) {
    for unit in s.encode_utf16() {
        buf.extend_from_slice(&unit.to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes());
}

/// PTP dataset string: u16 character count (including the terminating null)
/// followed by UTF-16LE code units (ISO 15740 "String" datatype).
fn read_ptp_string(data: &[u8], offset: &mut usize) -> String {
    if *offset + 2 > data.len() {
        return String::new();
    }
    let count = u16::from_le_bytes([data[*offset], data[*offset + 1]]) as usize;
    *offset += 2;
    let content = count.saturating_sub(1); // last unit is the terminator
    let mut out = String::new();
    for _ in 0..content {
        if *offset + 2 > data.len() {
            break;
        }
        let unit = u16::from_le_bytes([data[*offset], data[*offset + 1]]);
        *offset += 2;
        if unit == 0 {
            break;
        }
        out.push(char::from_u32(unit as u32).unwrap_or('\u{FFFD}'));
    }
    // Skip the terminator when present so the caller stays aligned; tolerate
    // firmware that omits it.
    if *offset + 2 <= data.len() {
        let is_null = data[*offset] == 0 && data[*offset + 1] == 0;
        if is_null {
            *offset += 2;
        }
    }
    out
}

#[cfg(test)]
fn push_ptp_string(buf: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    buf.extend_from_slice(&((units.len() + 1) as u16).to_le_bytes());
    for unit in &units {
        buf.extend_from_slice(&unit.to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes());
}

fn u16_at(data: &[u8], off: usize) -> u16 {
    if off + 2 <= data.len() {
        u16::from_le_bytes([data[off], data[off + 1]])
    } else {
        0
    }
}

fn u32_at(data: &[u8], off: usize) -> u32 {
    if off + 4 <= data.len() {
        u32::from_le_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

pub struct PtpSession {
    cmd: TcpStream,
    /// Event socket per PTP/IP spec; reserved for capture events (not used by
    /// the import flow) but opened/closed with the session for correctness.
    _evt: Option<TcpStream>,
    transaction: u32,
    pub manufacturer: String,
    pub model: String,
    pub device_version: String,
}

static PTP_SESSION: OnceLock<Mutex<Option<PtpSession>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<PtpSession>> {
    PTP_SESSION.get_or_init(|| Mutex::new(None))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PtpCameraInfo {
    pub manufacturer: String,
    pub model: String,
    pub device_version: String,
    pub host: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PtpObjectSummary {
    pub handle: u32,
    pub parent: u32,
    pub name: String,
    pub format_code: u16,
    pub is_folder: bool,
    pub size: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PtpDownloadResult {
    pub path: String,
    pub size: u64,
}

impl PtpSession {
    fn next_transaction(&mut self) -> u32 {
        self.transaction += 1;
        self.transaction
    }

    fn send_operation(&mut self, opcode: u16, session: u32, args: &[u32]) -> Result<(), String> {
        let txn = self.next_transaction();
        let mut payload = Vec::with_capacity(10 + args.len() * 4);
        payload.extend_from_slice(&opcode.to_le_bytes());
        payload.extend_from_slice(&session.to_le_bytes());
        payload.extend_from_slice(&txn.to_le_bytes());
        for arg in args {
            payload.extend_from_slice(&arg.to_le_bytes());
        }
        write_packet(&mut self.cmd, PT_OPERATION_REQ, &payload)
    }

    /// Receives the data phase (if any) and the operation response, returning
    /// `(response_code, response_args, accumulated_data)`.
    fn read_response(&mut self) -> Result<(u16, Vec<u32>, Vec<u8>), String> {
        let mut data: Vec<u8> = Vec::new();
        let mut expected_total: Option<usize> = None;
        loop {
            let (ptype, payload) = read_packet(&mut self.cmd)?;
            match ptype {
                PT_DATA_START => {
                    if payload.len() < 8 {
                        return Err("Truncated PTP/IP DataStart packet.".to_string());
                    }
                    expected_total =
                        Some(u32::from_le_bytes(payload[4..8].try_into().unwrap()) as usize);
                }
                PT_DATA => {
                    let start = payload.len().min(4); // leading transaction id
                    data.extend_from_slice(&payload[start..]);
                }
                PT_DATA_END => {
                    // Payload: txn id (4) + total length (4) + alignment tail of
                    // the dataset (length % 4 bytes) when the camera follows the
                    // spec; some firmware puts everything into Data packets.
                    if payload.len() > 8 {
                        data.extend_from_slice(&payload[8..]);
                    }
                    if let Some(total) = expected_total {
                        data.truncate(total);
                    }
                }
                PT_OPERATION_RSP => {
                    if payload.len() < 10 {
                        return Err("Truncated PTP/IP Response packet.".to_string());
                    }
                    let code = u16::from_le_bytes([payload[0], payload[1]]);
                    let mut args = Vec::new();
                    let mut off = 10;
                    while off + 4 <= payload.len() {
                        args.push(u32::from_le_bytes(
                            payload[off..off + 4].try_into().unwrap(),
                        ));
                        off += 4;
                    }
                    if let Some(total) = expected_total {
                        data.truncate(total);
                    }
                    return Ok((code, args, data));
                }
                _ => {} // probes, event packets: ignore on the command socket
            }
        }
    }

    fn execute(
        &mut self,
        opcode: u16,
        session: u32,
        args: &[u32],
    ) -> Result<(u16, Vec<u32>, Vec<u8>), String> {
        self.send_operation(opcode, session, args)?;
        let (code, resp_args, data) = self.read_response()?;
        if code != RC_OK {
            return Err(format!(
                "PTP operation 0x{opcode:04X} failed: 0x{code:04X} ({})",
                describe_response_code(code)
            ));
        }
        Ok((code, resp_args, data))
    }

    /// Lists objects below `parent` (`None`/0 = storage root, 0xFFFFFFFF =
    /// everything). Unreadable entries are skipped so one corrupt card record
    /// does not fail the whole listing.
    pub fn list_objects(&mut self, parent: Option<u32>) -> Result<Vec<PtpObjectSummary>, String> {
        let parent = parent.unwrap_or(0);
        let (_, _, data) = self.execute(OP_GET_OBJECT_HANDLES, 1, &[0xFFFF_FFFF, 0, parent])?;
        if data.len() < 4 {
            return Ok(Vec::new());
        }
        let count = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
        let mut handles = Vec::with_capacity(count.min(8192));
        for i in 0..count {
            let off = 4 + i * 4;
            if off + 4 > data.len() {
                break;
            }
            handles.push(u32_at(&data, off));
        }
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            if let Ok(summary) = self.get_object_info(handle) {
                out.push(summary);
            }
        }
        out.sort_by(|a, b| {
            b.is_folder
                .cmp(&a.is_folder)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    fn get_object_info(&mut self, handle: u32) -> Result<PtpObjectSummary, String> {
        let (_, args, data) = self.execute(OP_GET_OBJECT_INFO, 1, &[handle])?;
        let parent = args.first().copied().unwrap_or(0);
        parse_object_info(handle, parent, &data)
            .ok_or_else(|| format!("Malformed ObjectInfo for handle 0x{handle:08X}."))
    }

    /// Downloads the object and writes it to `dest` atomically
    /// (temp file + rename, so an interrupted transfer never leaves a
    /// half-written "image" in the library).
    pub fn download_object(&mut self, handle: u32, dest: &Path) -> Result<u64, String> {
        let (_, _, data) = self.execute(OP_GET_OBJECT, 1, &[handle])?;
        if data.is_empty() {
            return Err(format!("Camera returned no data for handle 0x{handle:08X}."));
        }
        let tmp = dest.with_file_name(format!(
            "{}.part",
            dest.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "download".to_string())
        ));
        std::fs::write(&tmp, &data)
            .map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Failed to finalize {}: {e}", dest.display())
        })?;
        Ok(data.len() as u64)
    }
}

fn connect_session(host: &str) -> Result<PtpSession, String> {
    // Host may be "host" (port defaults to 15740) or "host:port" (tests and
    // non-standard setups).
    let addr = if host.contains(':') {
        host.to_socket_addrs()
            .map_err(|e| format!("Invalid camera address {host:?}: {e}"))?
            .next()
            .ok_or_else(|| format!("Could not resolve camera address {host:?}."))?
    } else {
        (host, PTP_IP_PORT)
            .to_socket_addrs()
            .map_err(|e| format!("Invalid camera address {host:?}: {e}"))?
            .next()
            .ok_or_else(|| format!("Could not resolve camera address {host:?}."))?
    };

    let mut cmd = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("Could not reach {host}:{PTP_IP_PORT}: {e}"))?;
    configure_stream(&mut cmd);

    // InitCommandRequest: GUID + friendly name + protocol version 1.0
    let guid: [u8; 16] = *uuid::Uuid::new_v4().as_bytes();
    let mut payload = Vec::with_capacity(64);
    payload.extend_from_slice(&guid);
    write_wchar(&mut payload, "anwuRAW");
    payload.extend_from_slice(&0x0001_0000u32.to_le_bytes());
    write_packet(&mut cmd, PT_INIT_CMD_REQ, &payload)?;

    let (ptype, ack) = read_packet(&mut cmd)?;
    if ptype != PT_INIT_CMD_ACK {
        return Err(format!(
            "Camera replied 0x{ptype:08X} instead of an InitCommandAck."
        ));
    }
    if ack.len() < 4 {
        return Err("Truncated InitCommandAck.".to_string());
    }
    let connection_number = u32::from_le_bytes(ack[0..4].try_into().unwrap());

    // Event socket (best-effort: ancient firmware may refuse it, the command
    // channel alone is enough for the import flow).
    let mut evt: Option<TcpStream> = None;
    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        configure_stream(&mut stream);
        let mut evt_payload = Vec::with_capacity(4);
        evt_payload.extend_from_slice(&connection_number.to_le_bytes());
        if write_packet(&mut stream, PT_INIT_EVT_REQ, &evt_payload).is_ok() {
            if let Ok((etype, _)) = read_packet(&mut stream) {
                if etype == PT_INIT_EVT_ACK {
                    evt = Some(stream);
                }
            }
        }
    }

    let mut session = PtpSession {
        cmd,
        _evt: evt,
        transaction: 0,
        manufacturer: String::new(),
        model: String::new(),
        device_version: String::new(),
    };

    // OpenSession (session id 1; request header session is 0 before open).
    session.execute(OP_OPEN_SESSION, 0, &[1])?;

    let (_, _, info) = session.execute(OP_GET_DEVICE_INFO, 1, &[])?;
    let (manufacturer, model, device_version) = parse_device_info(&info);
    session.manufacturer = manufacturer;
    session.model = model;
    session.device_version = device_version;
    Ok(session)
}

fn configure_stream(stream: &mut TcpStream) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
}

/// Extracts Manufacturer / Model / DeviceVersion from the DeviceInfo dataset.
/// Tolerant: returns empty strings for malformed trailing fields.
fn parse_device_info(data: &[u8]) -> (String, String, String) {
    if data.len() < 8 {
        return (String::new(), String::new(), String::new());
    }
    let mut off = 0usize;
    off += 2; // StandardVersion
    off += 4; // VendorExtensionID
    // VendorExtensionDesc is a PTP string (length-prefixed).
    let _desc = read_ptp_string(data, &mut off);
    off += 2; // FunctionalMode
    for _ in 0..5 {
        // OperationsSupported, EventsSupported, DevicePropertiesSupported,
        // CaptureFormats, ImageFormats — ArrayOfUInt16 (u32 count + elements).
        let count = u32_at(data, off) as usize;
        off += 4 + count * 2;
    }
    let manufacturer = read_ptp_string(data, &mut off);
    let model = read_ptp_string(data, &mut off);
    let device_version = read_ptp_string(data, &mut off);
    (manufacturer, model, device_version)
}

/// Parses an ObjectInfo dataset into a [`PtpObjectSummary`].
/// Layout (52-byte fixed header, then three PTP strings):
/// StorageID(4) ObjectFormat(2) Protection(2) CompressedSize(4) ThumbFormat(2)
/// ThumbSize(4) ThumbW(4) ThumbH(4) ImageW(4) ImageH(4) BitDepth(4)
/// ParentObject(4) AssociationType(2) AssociationDesc(4) SequenceNumber(4)
/// Filename, CaptureDate, ModificationDate.
fn parse_object_info(handle: u32, parent_fallback: u32, data: &[u8]) -> Option<PtpObjectSummary> {
    if data.len() < 52 {
        return None;
    }
    let format_code = u16_at(data, 4);
    let size = u32_at(data, 8) as u64;
    let width = u32_at(data, 26);
    let height = u32_at(data, 30);
    let parent = u32_at(data, 38);
    let mut off = 52usize;
    let name = read_ptp_string(data, &mut off);
    let is_folder = format_code == PTP_FORMAT_ASSOCIATION;
    let name = if name.is_empty() {
        format!("Object_{handle:08X}")
    } else {
        name
    };
    Some(PtpObjectSummary {
        handle,
        parent: if parent == 0 { parent_fallback } else { parent },
        name,
        format_code,
        is_folder,
        size: if is_folder { 0 } else { size },
        width,
        height,
    })
}

/// Sanitizes a camera-side filename for local storage and guarantees it does
/// not collide with an existing file (appends " (n)" before the extension).
fn unique_destination(dir: &Path, filename: &str) -> PathBuf {
    let safe: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    let safe = if safe.is_empty() {
        format!("camera_{}.jpg", chrono_like_stamp())
    } else if Path::new(&safe).extension().is_none() {
        // Camera filenames normally carry extensions; sanitize output might
        // not — keep gallery-importable names.
        format!("{safe}.jpg")
    } else {
        safe
    };
    let candidate = dir.join(&safe);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(&safe)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "camera".to_string());
    let ext = Path::new(&safe)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..10000u32 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}_{}{ext}", chrono_like_stamp()))
}

/// Compact timestamp used for fallback filenames (UTC seconds).
fn chrono_like_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs:08x}")
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ptp_ip_connect(host: String) -> Result<PtpCameraInfo, String> {
    let mut guard = session_slot().lock().unwrap_or_else(|e| e.into_inner());
    // Reconnecting replaces any stale session (dropped socket from a camera
    // that went to sleep, etc.).
    *guard = None;
    let session = match connect_session(&host) {
        Ok(s) => s,
        Err(e) => {
            crate::diagnostics::record_diagnostic(
                "ptp_error",
                serde_json::json!({ "phase": "connect", "message": e, "host": host }),
            );
            return Err(e);
        }
    };
    let info = PtpCameraInfo {
        manufacturer: session.manufacturer.clone(),
        model: session.model.clone(),
        device_version: session.device_version.clone(),
        host,
    };
    *guard = Some(session);
    Ok(info)
}

#[tauri::command]
pub fn ptp_ip_disconnect() -> Result<(), String> {
    let mut guard = session_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut session) = guard.take() {
        // Best-effort CloseSession; the streams are dropped either way.
        let _ = session.execute(0x1003, 1, &[]);
    }
    Ok(())
}

#[tauri::command]
pub fn ptp_ip_list_objects(parent: Option<u32>) -> Result<Vec<PtpObjectSummary>, String> {
    let mut guard = session_slot().lock().unwrap_or_else(|e| e.into_inner());
    let session = guard
        .as_mut()
        .ok_or("No PTP/IP camera is connected.")?;
    session.list_objects(parent)
}

#[tauri::command]
pub fn ptp_ip_download_object(
    app_handle: tauri::AppHandle,
    handle: u32,
    filename: String,
) -> Result<PtpDownloadResult, String> {
    let library_root = crate::file_management::get_or_create_internal_library_root(
        app_handle.clone(),
    )?;
    let mut guard = session_slot().lock().unwrap_or_else(|e| e.into_inner());
    let session = guard
        .as_mut()
        .ok_or("No PTP/IP camera is connected.")?;
    let dest = unique_destination(Path::new(&library_root), &filename);
    let size = session.download_object(handle, &dest)?;
    Ok(PtpDownloadResult {
        path: dest.to_string_lossy().to_string(),
        size,
    })
}

// ---------------------------------------------------------------------------
// Tests: real protocol state machine against an in-process mock camera
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{SocketAddr, TcpListener};

    const DATA_CHUNK: usize = 512 * 1024;

    /// Minimal PTP/IP responder: answers the two-socket handshake, OpenSession,
    /// GetDeviceInfo, GetObjectHandles, GetObjectInfo and GetObject with canned
    /// datasets. Exercises the non-multiple-of-4 DataEnd tail path.
    fn spawn_mock() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock bind");
        let addr = listener.local_addr().expect("mock addr");
        std::thread::spawn(move || {
            let mut sockets: Vec<TcpStream> = Vec::new();
            for _ in 0..2 {
                let (mut sock, _) = match listener.accept() {
                    Ok(a) => a,
                    Err(_) => return,
                };
                let (ptype, _payload) = match read_packet(&mut sock) {
                    Ok(p) => p,
                    Err(_) => return,
                };
                match ptype {
                    PT_INIT_CMD_REQ => {
                        let mut ack = Vec::new();
                        ack.extend_from_slice(&7u32.to_le_bytes()); // connection number
                        ack.extend_from_slice(&[0u8; 16]); // camera GUID
                        write_wchar(&mut ack, "MockCam");
                        write_packet(&mut sock, PT_INIT_CMD_ACK, &ack).expect("ack write");
                    }
                    PT_INIT_EVT_REQ => {
                        write_packet(&mut sock, PT_INIT_EVT_ACK, &7u32.to_le_bytes())
                            .expect("evt ack write");
                    }
                    _ => return,
                }
                sockets.push(sock);
            }
            let mut cmd = sockets.remove(0);
            loop {
                let (ptype, payload) = match read_packet(&mut cmd) {
                    Ok(p) => p,
                    Err(_) => return,
                };
                if ptype != PT_OPERATION_REQ {
                    return;
                }
                let opcode = u16::from_le_bytes([payload[0], payload[1]]);
                let txn = u32::from_le_bytes(payload[6..10].try_into().unwrap());
                match opcode {
                    OP_OPEN_SESSION => send_ok(&mut cmd, txn),
                    OP_GET_DEVICE_INFO => send_with_data(&mut cmd, txn, &build_device_info()),
                    OP_GET_OBJECT_HANDLES => {
                        let mut handles = Vec::new();
                        handles.extend_from_slice(&1u32.to_le_bytes());
                        handles.extend_from_slice(&0x1234_5678u32.to_le_bytes());
                        send_with_data(&mut cmd, txn, &handles);
                    }
                    OP_GET_OBJECT_INFO => send_with_data(&mut cmd, txn, &build_object_info()),
                    OP_GET_OBJECT => {
                        // 100003 bytes (not a multiple of 4) exercises the
                        // DataEnd alignment-tail path in both directions.
                        let jpeg = vec![0xA5u8; 100003];
                        send_with_data(&mut cmd, txn, &jpeg);
                    }
                    _ => send_ok(&mut cmd, txn),
                }
            }
        });
        addr
    }

    fn send_ok(cmd: &mut TcpStream, txn: u32) {
        let mut payload = Vec::new();
        payload.extend_from_slice(&RC_OK.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes()); // session id
        payload.extend_from_slice(&txn.to_le_bytes());
        write_packet(cmd, PT_OPERATION_RSP, &payload).expect("rsp write");
    }

    fn send_with_data(cmd: &mut TcpStream, txn: u32, data: &[u8]) {
        let mut start = Vec::new();
        start.extend_from_slice(&txn.to_le_bytes());
        start.extend_from_slice(&(data.len() as u32).to_le_bytes());
        write_packet(cmd, PT_DATA_START, &start).expect("data start write");

        let aligned = data.len() - data.len() % 4;
        let mut off = 0usize;
        while off < aligned {
            let end = (off + DATA_CHUNK.min(aligned - off)).min(aligned);
            let mut chunk = Vec::with_capacity(4 + (end - off));
            chunk.extend_from_slice(&txn.to_le_bytes());
            chunk.extend_from_slice(&data[off..end]);
            write_packet(cmd, PT_DATA, &chunk).expect("data write");
            off = end;
        }

        let mut end_packet = Vec::new();
        end_packet.extend_from_slice(&txn.to_le_bytes());
        end_packet.extend_from_slice(&(data.len() as u32).to_le_bytes());
        end_packet.extend_from_slice(&data[aligned..]); // alignment tail
        write_packet(cmd, PT_DATA_END, &end_packet).expect("data end write");
        send_ok(cmd, txn);
    }

    fn build_device_info() -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&100u16.to_le_bytes()); // StandardVersion
        d.extend_from_slice(&0u32.to_le_bytes()); // VendorExtensionID
        push_ptp_string(&mut d, "none: 1.0;"); // VendorExtensionDesc
        d.extend_from_slice(&0u16.to_le_bytes()); // FunctionalMode
        for _ in 0..5 {
            d.extend_from_slice(&0u32.to_le_bytes()); // empty arrays
        }
        push_ptp_string(&mut d, "Mock Works");
        push_ptp_string(&mut d, "MockCam X100");
        push_ptp_string(&mut d, "1.0");
        d
    }

    fn build_object_info() -> Vec<u8> {
        let mut o = Vec::new();
        o.extend_from_slice(&0x0001_0001u32.to_le_bytes()); // StorageID
        o.extend_from_slice(&0x3801u16.to_le_bytes()); // ObjectFormat: JPEG
        o.extend_from_slice(&0u16.to_le_bytes()); // ProtectionStatus
        o.extend_from_slice(&100003u32.to_le_bytes()); // CompressedSize
        o.extend_from_slice(&0x3808u16.to_le_bytes()); // ThumbFormat
        o.extend_from_slice(&0u32.to_le_bytes()); // ThumbCompressedSize
        o.extend_from_slice(&0u32.to_le_bytes()); // ThumbPixWidth
        o.extend_from_slice(&0u32.to_le_bytes()); // ThumbPixHeight
        o.extend_from_slice(&6000u32.to_le_bytes()); // ImagePixWidth
        o.extend_from_slice(&4000u32.to_le_bytes()); // ImagePixHeight
        o.extend_from_slice(&8u32.to_le_bytes()); // ImageBitDepth
        o.extend_from_slice(&0u32.to_le_bytes()); // ParentObject (root)
        o.extend_from_slice(&0u16.to_le_bytes()); // AssociationType
        o.extend_from_slice(&0u32.to_le_bytes()); // AssociationDesc
        o.extend_from_slice(&0u32.to_le_bytes()); // SequenceNumber
        push_ptp_string(&mut o, "DSC_0001.JPG");
        push_ptp_string(&mut o, "20241127T120000");
        push_ptp_string(&mut o, "20241127T120000");
        o
    }

    #[test]
    fn connect_list_download_roundtrip() {
        let addr = spawn_mock();
        let host = format!("{}:{}", addr.ip(), addr.port());
        let mut session = connect_session(&host).expect("connect");
        assert_eq!(session.model, "MockCam X100");
        assert_eq!(session.manufacturer, "Mock Works");

        let objects = session.list_objects(None).expect("list");
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].name, "DSC_0001.JPG");
        assert_eq!(objects[0].format_code, 0x3801);
        assert_eq!(objects[0].size, 100003);
        assert_eq!(objects[0].width, 6000);
        assert_eq!(objects[0].height, 4000);
        assert!(!objects[0].is_folder);

        let tmp = std::env::temp_dir().join(format!("ptp_ip_test_{}.jpg", std::process::id()));
        let written = session
            .download_object(0x1234_5678, &tmp)
            .expect("download");
        assert_eq!(written, 100003);
        let on_disk = std::fs::read(&tmp).expect("read temp");
        assert_eq!(on_disk.len(), 100003);
        assert!(on_disk.iter().all(|&b| b == 0xA5));
        // No leftover temp file after a successful transfer.
        let part = tmp.with_file_name(format!(
            "{}.part",
            tmp.file_name().unwrap().to_string_lossy()
        ));
        assert!(!part.exists());
        std::fs::remove_file(&tmp).expect("cleanup");
    }

    #[test]
    fn object_info_parses_folders_and_names() {
        let mut info = build_object_info();
        // Flip ObjectFormat to Association and shrink the header below the
        // minimum to verify tolerance paths.
        info[4] = 0x01;
        info[5] = 0x30;
        let parsed = parse_object_info(0x42, 0, &info).expect("parse");
        assert!(parsed.is_folder);
        assert_eq!(parsed.name, "DSC_0001.JPG");
        assert_eq!(parsed.size, 0); // folders report no size

        assert!(parse_object_info(0x42, 0, &info[..40]).is_none());
    }

    #[test]
    fn unique_destination_sanitizes_and_avoids_collisions() {
        let dir = std::env::temp_dir().join(format!("ptp_ip_dest_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let first = unique_destination(&dir, "IMG_0001/CR2:*.JPG");
        assert_eq!(first.file_name().unwrap().to_string_lossy(), "IMG_0001_CR2__.JPG");
        std::fs::write(&first, b"x").expect("seed collision");
        let second = unique_destination(&dir, "IMG_0001/CR2:*.JPG");
        assert_eq!(second.file_name().unwrap().to_string_lossy(), "IMG_0001_CR2__ (1).JPG");
        let fallback = unique_destination(&dir, "///");
        assert!(fallback.file_name().unwrap().to_string_lossy().ends_with(".jpg"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
