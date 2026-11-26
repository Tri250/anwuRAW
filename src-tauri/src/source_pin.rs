//! PinnedSourceFile（RawLab 0.13 borrow）。
//!
//! 照片在编辑器中打开期间，其源文件被"钉住"：加载成功时记录一份文件身份快照
//! （size + mtime，Unix 下另含 dev/inode）。钉住期间：
//!
//! - 库内对源文件的移动/重命名/删除等破坏性操作被拒绝（见 file_management
//!   各命令），防止编辑器与 sidecar 落到旧路径或产生悬空引用；
//! - [`PinnedSourceFile::drifted`] 检测源文件是否被外部替换/截断，作为
//!   任何"写回源文件"操作的前置校验入口。当前仓库没有原地写源文件的
//!   路径（导出与 EXIF 更新均不触碰原图字节），该 API 与测试先行就位，
//!   后续新增写回路径时直接接入。
//!
//! 虚拟副本（`?vc=`）与原图共用同一实体文件：钉住的比较一律使用
//! `parse_virtual_path` 解析出的真实路径。

use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// 钉住源文件的身份快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedSourceFile {
    path: PathBuf,
    size: u64,
    mtime_secs: u64,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    inode: u64,
}

impl PinnedSourceFile {
    /// 为 `path` 拍摄身份快照；文件必须存在。
    pub fn capture(path: &Path) -> std::io::Result<Self> {
        let meta = std::fs::metadata(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            size: meta.len(),
            mtime_secs: mtime_epoch_secs(&meta),
            #[cfg(unix)]
            dev: meta.dev(),
            #[cfg(unix)]
            inode: meta.ino(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 源文件是否已与钉住时的快照不一致（被外部替换、截断或删除）。
    /// 文件缺失视为已漂移。
    pub fn drifted(&self) -> bool {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return true;
        };
        if meta.len() != self.size || mtime_epoch_secs(&meta) != self.mtime_secs {
            return true;
        }
        // size/mtime 一致但 inode 变了（同名替换）只有在同设备上才可靠；
        // Unix 下 dev/inode 比对兜底，Windows 无此信息，快照即全部依据。
        #[cfg(unix)]
        if meta.dev() != self.dev || meta.ino() != self.inode {
            return true;
        }
        false
    }
}

fn mtime_epoch_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// AppState 中钉住源文件的槽位。
pub type PinnedSourceSlot = Mutex<Option<PinnedSourceFile>>;

/// （重新）钉住一个源文件。文件此刻已消失时返回 false 并记录日志，
/// 不阻断加载主流程。
pub fn pin(slot: &PinnedSourceSlot, path: &Path) -> bool {
    match PinnedSourceFile::capture(path) {
        Ok(pinned) => {
            log::info!("Pinned source file: {}", pinned.path().display());
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(pinned);
            true
        }
        Err(e) => {
            log::warn!("Failed to pin source file {}: {}", path.display(), e);
            false
        }
    }
}

/// 解除钉住（换图或清空编辑器时调用）。
pub fn unpin(slot: &PinnedSourceSlot) {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(pinned) = guard.take() {
        log::info!("Unpinned source file: {}", pinned.path().display());
    }
}

/// `path` 是否正是当前钉住的源文件。
pub fn is_pinned(slot: &PinnedSourceSlot, path: &Path) -> bool {
    slot.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|pinned| pinned.path() == path)
}

/// 当前钉住的源文件是否位于 `dir` 目录之内（含子目录）。
pub fn is_pinned_under(slot: &PinnedSourceSlot, dir: &Path) -> bool {
    slot.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|pinned| pinned.path().starts_with(dir))
}

/// 当前钉住的源文件是否已被外部替换（编辑器仍持有旧内存副本）。
/// 预留给未来的"写回源文件"路径做前置校验（当前无原地写原图路径，
/// 详见模块文档）；单测覆盖其判定逻辑。
#[allow(dead_code)]
pub fn drifted(slot: &PinnedSourceSlot) -> bool {
    slot.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(PinnedSourceFile::drifted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

    fn temp_file(label: &str) -> PathBuf {
        let dir = std::env::temp_dir();
        let n = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = dir.join(format!(
            "crystal-source-pin-{}-{}-{}",
            std::process::id(),
            label,
            n
        ));
        std::fs::write(&path, b"v1").expect("write temp file");
        path
    }

    #[test]
    fn capture_missing_file_fails() {
        let missing = std::env::temp_dir().join("crystal-source-pin-missing-file.jpg");
        let _ = std::fs::remove_file(&missing);
        assert!(PinnedSourceFile::capture(&missing).is_err());
    }

    #[test]
    fn pin_unpin_is_pinned_roundtrip() {
        let path = temp_file("roundtrip");
        let slot: PinnedSourceSlot = Mutex::new(None);

        unpin(&slot); // 空槽拔钉不panic
        assert!(!is_pinned(&slot, &path));
        assert!(pin(&slot, &path));
        assert!(is_pinned(&slot, &path));
        assert!(!is_pinned(&slot, &path.with_extension("other.jpg")));

        unpin(&slot);
        assert!(!is_pinned(&slot, &path));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drift_detects_size_change_and_missing_file() {
        let path = temp_file("drift");
        let slot: PinnedSourceSlot = Mutex::new(None);
        assert!(pin(&slot, &path));
        assert!(!drifted(&slot));

        // 同名替换且长度不同 → size 变化必被捕获
        std::fs::write(&path, b"v1-longer-content").unwrap();
        assert!(drifted(&slot));

        // 重新钉住恢复一致
        assert!(pin(&slot, &path));
        assert!(!drifted(&slot));

        // 文件被删除 → 视为漂移
        std::fs::remove_file(&path).unwrap();
        assert!(drifted(&slot));
    }

    #[test]
    fn is_pinned_under_checks_containment() {
        let dir = std::env::temp_dir().join(format!("crystal-pin-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("photo.jpg");
        std::fs::write(&path, b"x").unwrap();

        let slot: PinnedSourceSlot = Mutex::new(None);
        assert!(pin(&slot, &path));

        assert!(is_pinned_under(&slot, &dir));
        assert!(is_pinned_under(&slot, &std::env::temp_dir()));
        assert!(!is_pinned_under(&slot, &Path::new("/definitely/not/parent")));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
