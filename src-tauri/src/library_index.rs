//! 图库索引层（AR-4）：SQLite 驱动的可牺牲性索引。
//!
//! 设计原则——索引是**派生数据**：完全可从文件系统 + .rrdata sidecar 重建。
//! 因此索引不做事务级关键路径（元数据写路径仍以 sidecar 为事实源），只承担
//! 查询加速（10 万张库的筛选/搜索/标签过滤）与 DAM 功能（智能相册/地图）的数据底座。
//!
//! 接线计划：W5 file_management 拆分时由 metadata_repo 在扫描/元数据变更时写入；
//! tagging (FIL-3) 改为消费本索引查询。schema 迁移走 `meta.schema_version`。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Manager;

pub const SCHEMA_VERSION: u32 = 1;

/// W9-I3 前端索引消费：查询 DTO（camelCase，与前端 filterCriteria/searchCriteria 映射）。
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexQueryDto {
    pub folder_prefix: Option<String>,
    pub min_rating: Option<u8>,
    /// "only" | "exclude" | 其他(视为全部)
    pub raw_status: Option<String>,
    pub edited_status: Option<String>,
    pub with_tags: Option<Vec<String>>,
    pub without_tags: Option<Vec<String>>,
    pub limit: Option<u32>,
}

impl From<IndexQueryDto> for QueryFilter {
    fn from(dto: IndexQueryDto) -> Self {
        let raw_status = match dto.raw_status.as_deref() {
            Some("only") => Some(RawStatus::Only),
            Some("exclude") => Some(RawStatus::Exclude),
            _ => None,
        };
        let edited_status = match dto.edited_status.as_deref() {
            Some("only") => Some(EditedStatus::Only),
            Some("exclude") => Some(EditedStatus::Exclude),
            _ => None,
        };
        QueryFilter {
            folder_prefix: dto.folder_prefix,
            min_rating: dto.min_rating,
            raw_status,
            edited_status,
            with_tags: dto.with_tags.unwrap_or_default(),
            without_tags: dto.without_tags.unwrap_or_default(),
            limit: dto.limit,
        }
    }
}

/// W9-I3 索引可用性快照：available=false 表示索引不可用（前端必须回退本地过滤）。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub available: bool,
    pub count: Option<u64>,
}

/// 索引查询（W9-I3 数据源消费唯一读入口）。索引不可用返回空集，调用方据此回退。
#[tauri::command]
pub fn library_index_query(app_handle: tauri::AppHandle, filter: IndexQueryDto) -> Vec<ImageIndexRecord> {
    with_library_index(&app_handle, |index| index.query(&filter.into())).unwrap_or_default()
}

#[tauri::command]
pub fn library_index_stats(app_handle: tauri::AppHandle) -> IndexStats {
    match with_library_index(&app_handle, |index| index.record_count()) {
        Some(count) => IndexStats {
            available: true,
            count: Some(count),
        },
        None => IndexStats {
            available: false,
            count: None,
        },
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ImageIndexRecord {
    pub path: String,
    pub folder: String,
    pub filename: String,
    pub is_raw: bool,
    pub rating: u8,
    pub edited: bool,
    /// sidecar/图像的 mtime（秒），用于陈旧检测
    pub mtime_secs: i64,
    /// 简单标签集合（层级标签见 tag_hierarchies 表）
    pub tags: Vec<String>,
    /// 查询用扁平字段（exif 中的 city/country/gps 等由写入方提取）
    pub indexed_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct QueryFilter {
    /// folder 前缀（None = 全库）
    pub folder_prefix: Option<String>,
    /// rating ≥ min_rating
    pub min_rating: Option<u8>,
    pub raw_status: Option<RawStatus>,
    pub edited_status: Option<EditedStatus>,
    /// 须包含全部指定标签
    pub with_tags: Vec<String>,
    /// 排除包含任一指定标签
    pub without_tags: Vec<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RawStatus {
    Only,
    Exclude,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EditedStatus {
    Only,
    Exclude,
}

pub struct LibraryIndex {
    conn: Connection,
}

impl LibraryIndex {
    /// 内存库（测试与临时索引用）。
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let index = Self { conn };
        index.init_schema()?;
        Ok(index)
    }

    /// 文件库（app_data_dir/library.index）。损坏时由调用方删除重建（可牺牲性）。
    pub fn open_at(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        let index = Self { conn };
        index.init_schema()?;
        Ok(index)
    }

    fn init_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(&format!(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;

                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '{SCHEMA_VERSION}');

                CREATE TABLE IF NOT EXISTS images (
                    id INTEGER PRIMARY KEY,
                    path TEXT UNIQUE NOT NULL,
                    folder TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    is_raw INTEGER NOT NULL DEFAULT 0,
                    rating INTEGER NOT NULL DEFAULT 0,
                    edited INTEGER NOT NULL DEFAULT 0,
                    mtime_secs INTEGER NOT NULL DEFAULT 0,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    indexed_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder);
                CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating);
                CREATE INDEX IF NOT EXISTS idx_images_raw ON images(is_raw);

                CREATE TABLE IF NOT EXISTS tag_hierarchies (
                    name TEXT PRIMARY KEY,
                    parent TEXT NOT NULL DEFAULT ''
                );
                "#
            ))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn schema_version(&self) -> Result<u32, String> {
        let v: String = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        v.parse().map_err(|e| format!("bad schema_version: {e}"))
    }

    pub fn record_count(&self) -> Result<u64, String> {
        self.conn
            .query_row("SELECT COUNT(*) FROM images", [], |row| row.get::<_, i64>(0))
            .map(|v| v as u64)
            .map_err(|e| e.to_string())
    }

    /// 插入或按 path 更新（扫描管线与元数据变更事件的唯一写入口）。
    pub fn upsert_image(&self, record: &ImageIndexRecord) -> Result<(), String> {
        let tags_json = serde_json::to_string(&record.tags).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                r#"
                INSERT INTO images (path, folder, filename, is_raw, rating, edited, mtime_secs, tags_json, indexed_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(path) DO UPDATE SET
                    folder = excluded.folder,
                    filename = excluded.filename,
                    is_raw = excluded.is_raw,
                    rating = excluded.rating,
                    edited = excluded.edited,
                    mtime_secs = excluded.mtime_secs,
                    tags_json = excluded.tags_json,
                    indexed_at = excluded.indexed_at
                "#,
                rusqlite::params![
                    record.path,
                    record.folder,
                    record.filename,
                    record.is_raw as i64,
                    record.rating as i64,
                    record.edited as i64,
                    record.mtime_secs,
                    tags_json,
                    record.indexed_at
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 批量 upsert（单事务，万张扫描用）。
    pub fn upsert_images(&self, records: &[ImageIndexRecord]) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for record in records {
            let tags_json = serde_json::to_string(&record.tags).map_err(|e| e.to_string())?;
            tx.execute(
                r#"
                INSERT INTO images (path, folder, filename, is_raw, rating, edited, mtime_secs, tags_json, indexed_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(path) DO UPDATE SET
                    folder = excluded.folder,
                    filename = excluded.filename,
                    is_raw = excluded.is_raw,
                    rating = excluded.rating,
                    edited = excluded.edited,
                    mtime_secs = excluded.mtime_secs,
                    tags_json = excluded.tags_json,
                    indexed_at = excluded.indexed_at
                "#,
                rusqlite::params![
                    record.path,
                    record.folder,
                    record.filename,
                    record.is_raw as i64,
                    record.rating as i64,
                    record.edited as i64,
                    record.mtime_secs,
                    tags_json,
                    record.indexed_at
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_paths(&self, paths: &[String]) -> Result<u64, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut removed = 0u64;
        {
            let mut stmt = tx
                .prepare("DELETE FROM images WHERE path = ?1")
                .map_err(|e| e.to_string())?;
            for path in paths {
                removed += stmt.execute([path]).map_err(|e| e.to_string())? as u64;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(removed)
    }

    /// 陈旧检测：返回索引中存在但 mtime 晚于给定时间的路径集合之外的记录数（供增量扫描决策）。
    pub fn stale_paths(&self, since_secs: i64) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM images WHERE mtime_secs > ?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([since_secs], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn query(&self, filter: &QueryFilter) -> Result<Vec<ImageIndexRecord>, String> {
        let mut sql = String::from("SELECT path, folder, filename, is_raw, rating, edited, mtime_secs, tags_json, indexed_at FROM images WHERE 1=1");
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(prefix) = &filter.folder_prefix {
            sql.push_str(&format!(" AND folder LIKE ?{} ESCAPE '\\'", params.len() + 1));
            let escaped = prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            params.push(Box::new(format!("{escaped}%")));
        }
        if let Some(min) = filter.min_rating {
            sql.push_str(&format!(" AND rating >= ?{}", params.len() + 1));
            params.push(Box::new(min as i64));
        }
        if filter.raw_status == Some(RawStatus::Only) {
            sql.push_str(" AND is_raw = 1");
        } else if filter.raw_status == Some(RawStatus::Exclude) {
            sql.push_str(" AND is_raw = 0");
        }
        if filter.edited_status == Some(EditedStatus::Only) {
            sql.push_str(" AND edited = 1");
        } else if filter.edited_status == Some(EditedStatus::Exclude) {
            sql.push_str(" AND edited = 0");
        }
        for tag in &filter.with_tags {
            sql.push_str(&format!(" AND tags_json LIKE ?{}", params.len() + 1));
            params.push(Box::new(format!("%\"{tag}\"%")));
        }
        for tag in &filter.without_tags {
            sql.push_str(&format!(" AND tags_json NOT LIKE ?{}", params.len() + 1));
            params.push(Box::new(format!("%\"{tag}\"%")));
        }
        sql.push_str(" ORDER BY path");
        if let Some(limit) = filter.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }

        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(refs.as_slice(), |row| {
                let tags_json: String = row.get(7)?;
                Ok(ImageIndexRecord {
                    path: row.get(0)?,
                    folder: row.get(1)?,
                    filename: row.get(2)?,
                    is_raw: row.get::<_, i64>(3)? != 0,
                    rating: row.get::<_, i64>(4)? as u8,
                    edited: row.get::<_, i64>(5)? != 0,
                    mtime_secs: row.get(6)?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    indexed_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 层级标签：登记/查询（FIL-3 层级懒加载底座）。
    pub fn upsert_tag_hierarchy(&self, name: &str, parent: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO tag_hierarchies (name, parent) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET parent = excluded.parent",
                rusqlite::params![name, parent],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 某父标签的直接子标签（懒加载一跳）。
    pub fn child_tags(&self, parent: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM tag_hierarchies WHERE parent = ?1 ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([parent], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 元数据变更：批量更新评分（W9-I3 索引消费接线，best-effort 调用方忽略错误）。
    pub fn update_ratings(&self, updates: &[(String, u8)]) -> Result<u64, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut updated = 0u64;
        {
            let mut stmt = tx
                .prepare("UPDATE images SET rating = ?1 WHERE path = ?2")
                .map_err(|e| e.to_string())?;
            for (path, rating) in updates {
                updated += stmt
                    .execute(rusqlite::params![*rating as i64, path])
                    .map_err(|e| e.to_string())? as u64;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated)
    }

    /// 元数据变更：批量重写标签集合（色标/用户标签/清空均走此入口）。
    pub fn update_tags(&self, updates: &[(String, Vec<String>)]) -> Result<u64, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut updated = 0u64;
        {
            let mut stmt = tx
                .prepare("UPDATE images SET tags_json = ?1 WHERE path = ?2")
                .map_err(|e| e.to_string())?;
            for (path, tags) in updates {
                let tags_json = serde_json::to_string(tags).map_err(|e| e.to_string())?;
                updated += stmt
                    .execute(rusqlite::params![tags_json, path])
                    .map_err(|e| e.to_string())? as u64;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated)
    }

    /// 元数据变更：编辑标记（保存调整置 true，重置置 false）。
    pub fn update_edited(&self, updates: &[(String, bool)]) -> Result<u64, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut updated = 0u64;
        {
            let mut stmt = tx
                .prepare("UPDATE images SET edited = ?1 WHERE path = ?2")
                .map_err(|e| e.to_string())?;
            for (path, edited) in updates {
                updated += stmt
                    .execute(rusqlite::params![*edited as i64, path])
                    .map_err(|e| e.to_string())? as u64;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(updated)
    }

    /// 删除文件及其全部虚拟副本条目（物理删除/连带删除后索引清理）。
    pub fn remove_path_with_virtual_copies(&self, paths: &[String]) -> Result<u64, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut removed = 0u64;
        {
            let mut stmt = tx
                .prepare("DELETE FROM images WHERE path = ?1 OR path LIKE ?1 || '?vc=%'")
                .map_err(|e| e.to_string())?;
            for path in paths {
                removed += stmt.execute([path]).map_err(|e| e.to_string())? as u64;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(removed)
    }
}

/// 惰性打开并缓存于 AppState 的索引共享访问。
///
/// 可牺牲性契约：打不开/写失败只记日志返回 None，绝不阻断扫描或元数据主路径。
pub fn with_library_index<R>(
    app_handle: &tauri::AppHandle,
    f: impl FnOnce(&LibraryIndex) -> Result<R, String>,
) -> Option<R> {
    let state = app_handle.state::<crate::AppState>();
    let mut guard = state.library_index.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let dir = app_handle.path().app_data_dir().ok()?;
        match LibraryIndex::open_at(&dir.join("library.index")) {
            Ok(index) => *guard = Some(index),
            Err(e) => {
                eprintln!("[library_index] open failed (expendable, skipped): {e}");
                return None;
            }
        }
    }
    match f(guard.as_ref().expect("just initialized")) {
        Ok(r) => Some(r),
        Err(e) => {
            eprintln!("[library_index] operation failed (expendable, skipped): {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(path: &str, rating: u8, is_raw: bool, edited: bool, tags: &[&str]) -> ImageIndexRecord {
        ImageIndexRecord {
            path: path.to_string(),
            folder: Path::new(path).parent().unwrap().to_string_lossy().to_string(),
            filename: Path::new(path).file_name().unwrap().to_string_lossy().to_string(),
            is_raw,
            rating,
            edited,
            mtime_secs: 1000,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            indexed_at: 42,
        }
    }

    /// TR-IDX-1: upsert + 计数 + 陈旧检测 + 删除。
    #[test]
    fn tr_idx_1_upsert_count_stale_remove() {
        let index = LibraryIndex::open_in_memory().unwrap();
        index
            .upsert_images(&[
                record("/p/a.CR3", 5, true, true, &["portrait"]),
                record("/p/b.jpg", 0, false, false, &[]),
                record("/q/c.NEF", 3, true, false, &["travel", "2025"]),
            ])
            .unwrap();
        assert_eq!(index.record_count().unwrap(), 3);

        // upsert 幂等（同 path 更新而非新增）
        let mut updated = record("/p/a.CR3", 4, true, true, &["portrait", "best"]);
        updated.mtime_secs = 2000;
        index.upsert_image(&updated).unwrap();
        assert_eq!(index.record_count().unwrap(), 3);

        assert_eq!(index.stale_paths(1500).unwrap(), vec!["/p/a.CR3"]);

        assert_eq!(
            index
                .remove_paths(&["/p/a.CR3".to_string(), "/missing.jpg".to_string()])
                .unwrap(),
            1
        );
        assert_eq!(index.record_count().unwrap(), 2);
    }

    /// TR-IDX-2: 过滤矩阵（rating/raw/edited/文件夹前缀/标签含与排）。
    #[test]
    fn tr_idx_2_filter_matrix() {
        let index = LibraryIndex::open_in_memory().unwrap();
        index
            .upsert_images(&[
                record("/p/a.CR3", 5, true, true, &["portrait"]),
                record("/p/b.jpg", 0, false, false, &["portrait"]),
                record("/q/c.NEF", 3, true, false, &["travel"]),
            ])
            .unwrap();

        let mut f = QueryFilter::default();
        f.min_rating = Some(3);
        assert_eq!(index.query(&f).unwrap().len(), 2);

        let mut f = QueryFilter::default();
        f.raw_status = Some(RawStatus::Exclude);
        assert_eq!(index.query(&f).unwrap().len(), 1);

        let mut f = QueryFilter::default();
        f.edited_status = Some(EditedStatus::Only);
        assert_eq!(index.query(&f).unwrap().len(), 1);

        let mut f = QueryFilter::default();
        f.folder_prefix = Some("/q".to_string());
        assert_eq!(index.query(&f).unwrap().len(), 1);

        let mut f = QueryFilter::default();
        f.with_tags = vec!["portrait".to_string()];
        assert_eq!(index.query(&f).unwrap().len(), 2);

        let mut f = QueryFilter::default();
        f.without_tags = vec!["portrait".to_string()];
        assert_eq!(index.query(&f).unwrap().len(), 1);

        let mut f = QueryFilter::default();
        f.limit = Some(1);
        assert_eq!(index.query(&f).unwrap().len(), 1);
    }

    /// TR-IDX-3: 文件库持久化（重开可读）+ schema 版本 + 层级标签。
    #[test]
    fn tr_idx_3_file_backed_and_hierarchy() {
        let dir = std::env::temp_dir().join(format!("rr_idx_test_{}", std::process::id()));
        let db_path = dir.join("library.index");
        let _ = std::fs::remove_file(&db_path);

        {
            let index = LibraryIndex::open_at(&db_path).unwrap();
            assert_eq!(index.schema_version().unwrap(), SCHEMA_VERSION);
            index.upsert_image(&record("/p/a.CR3", 5, true, true, &[])).unwrap();
            index.upsert_tag_hierarchy("家族", "travel").unwrap();
        }
        {
            let index = LibraryIndex::open_at(&db_path).unwrap();
            assert_eq!(index.record_count().unwrap(), 1);
            assert_eq!(index.child_tags("travel").unwrap(), vec!["家族".to_string()]);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
