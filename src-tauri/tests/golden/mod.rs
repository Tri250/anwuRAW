//! 契约测试共享模块（spec: v2-engine-contract-tests）。
//!
//! 位于 `tests/golden/`，仅被集成测试 crate 引用（dev 侧代码，不进生产二进制）。

pub mod delta_e;
pub mod generator;
pub mod snapshot;
pub mod stats;
