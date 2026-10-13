//! W5-E1 命令分域 façade：engine/library/files/metadata/ai/export/compose/system。
//! invoke_handler 仅经本模块注册；lib.rs 装配化（W5-E3）后命令体不再落根模块。

pub mod ai;
pub mod compose;
pub mod engine;
pub mod export;
pub mod files;
pub mod library;
pub mod metadata;
pub mod system;
