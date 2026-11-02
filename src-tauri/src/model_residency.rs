//! Model residency policy for AI sessions.
//!
//! Inference sessions (SAM encoders, BiRefNet, CLIP, LaMa, depth/normal models)
//! are expensive to build and can hold hundreds of megabytes of weights. On
//! desktop keeping them resident is a win; on mobile it is a liability. This
//! module owns the *policy*: when a resident model is idle for too long or too
//! many are loaded at once, the caller is told which sessions to drop.
//!
//! The tracker is deliberately time-injected (`now_secs` parameters) so the
//! policy is unit-testable without sleeping.

// Part of this policy surface (pinning, explicit resets, introspection) is
// exercised by tests and will be wired by callers incrementally, so it is
// intentionally kept together rather than pruned to today's call sites.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Android: unload aggressive, the OS reclaims the process otherwise.
pub const ANDROID_IDLE_TIMEOUT_SECS: u64 = 60;
/// Android: at most this many inference sessions resident at once. The
/// EfficientSAM3 text-mask path needs encoder + decoder + text encoder
/// simultaneously, so the budget must fit that whole chain or it thrashes.
pub const ANDROID_MAX_LOADED: usize = 3;
/// Desktop: long-lived sessions keep autosave/export flows warm.
pub const DESKTOP_IDLE_TIMEOUT_SECS: u64 = 600;
pub const DESKTOP_MAX_LOADED: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResidencyPolicy {
    idle_timeout_secs: u64,
    max_loaded: usize,
}

impl Default for ResidencyPolicy {
    fn default() -> Self {
        Self::for_platform(false)
    }
}

impl ResidencyPolicy {
    pub fn new(idle_timeout_secs: u64, max_loaded: usize) -> Self {
        Self {
            idle_timeout_secs,
            max_loaded: max_loaded.max(1),
        }
    }

    pub fn for_platform(is_android: bool) -> Self {
        if is_android {
            Self::new(ANDROID_IDLE_TIMEOUT_SECS, ANDROID_MAX_LOADED)
        } else {
            Self::new(DESKTOP_IDLE_TIMEOUT_SECS, DESKTOP_MAX_LOADED)
        }
    }

    /// Idle-only policy for heavyweight models that live outside the session
    /// pool (CLIP, LaMa, denoise, normals): they unload on idle but are not
    /// counted against the pool budget, so a long batch job cannot evict a
    /// model another feature is actively using.
    pub fn idle_only(is_android: bool) -> Self {
        Self::new(
            if is_android {
                ANDROID_IDLE_TIMEOUT_SECS
            } else {
                DESKTOP_IDLE_TIMEOUT_SECS
            },
            usize::MAX,
        )
    }

    pub fn idle_timeout_secs(&self) -> u64 {
        self.idle_timeout_secs
    }

    pub fn max_loaded(&self) -> usize {
        self.max_loaded
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModel {
    pub key: String,
    pub idle_secs: u64,
    pub pinned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Entry {
    last_used_secs: u64,
    pinned: bool,
}

#[derive(Debug)]
pub struct ResidencyTracker {
    policy: ResidencyPolicy,
    entries: HashMap<String, Entry>,
}

impl Default for ResidencyTracker {
    fn default() -> Self {
        Self::new(ResidencyPolicy::default())
    }
}

impl ResidencyTracker {
    pub fn new(policy: ResidencyPolicy) -> Self {
        Self {
            policy,
            entries: HashMap::new(),
        }
    }

    pub fn policy(&self) -> ResidencyPolicy {
        self.policy
    }

    pub fn set_policy(&mut self, policy: ResidencyPolicy) {
        self.policy = policy;
    }

    /// Records a use of `key` at `now_secs`. Loading and using are the same
    /// event from the policy's point of view.
    pub fn touch(&mut self, key: &str, now_secs: u64) {
        self.entries
            .entry(key.to_string())
            .and_modify(|entry| entry.last_used_secs = now_secs)
            .or_insert(Entry {
                last_used_secs: now_secs,
                pinned: false,
            });
    }

    pub fn mark_released(&mut self, key: &str) {
        self.entries.remove(key);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn is_loaded(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Pinned entries are never evicted (e.g. a model used by an in-flight job).
    pub fn set_pinned(&mut self, key: &str, pinned: bool) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.pinned = pinned;
        }
    }

    pub fn loaded(&self, now_secs: u64) -> Vec<LoadedModel> {
        let mut models: Vec<LoadedModel> = self
            .entries
            .iter()
            .map(|(key, entry)| LoadedModel {
                key: key.clone(),
                idle_secs: now_secs.saturating_sub(entry.last_used_secs),
                pinned: entry.pinned,
            })
            .collect();
        models.sort_by(|a, b| b.idle_secs.cmp(&a.idle_secs).then(a.key.cmp(&b.key)));
        models
    }

    /// Keys the caller should drop now: everything idle past the timeout, then
    /// least-recently-used entries until the loaded count fits the budget.
    pub fn due_for_eviction(&self, now_secs: u64) -> Vec<String> {
        self.due_for_eviction_reserving(now_secs, 0)
    }

    /// Same as [`Self::due_for_eviction`], but `reserve` counts slots the
    /// caller is about to fill with a new session, so the budget is checked
    /// against the upcoming count instead of the current one.
    pub fn due_for_eviction_reserving(&self, now_secs: u64, reserve: usize) -> Vec<String> {
        let mut due: Vec<String> = Vec::new();
        let mut remaining: Vec<(&String, &Entry)> = Vec::new();

        for (key, entry) in &self.entries {
            let idle = now_secs.saturating_sub(entry.last_used_secs);
            if !entry.pinned && idle >= self.policy.idle_timeout_secs {
                due.push(key.clone());
            } else {
                remaining.push((key, entry));
            }
        }

        // Idle evictions already reclaim slots, so the LRU pass only has to
        // make up the difference.
        let over = (self.entries.len() + reserve).saturating_sub(self.policy.max_loaded);
        let mut to_drop = over.saturating_sub(due.len());
        let mut candidates: Vec<(&String, &Entry)> = remaining
            .iter()
            .copied()
            .filter(|(_, entry)| !entry.pinned)
            .collect();
        candidates.sort_by_key(|(_, entry)| entry.last_used_secs);
        for (key, _) in candidates {
            if to_drop == 0 {
                break;
            }
            if !due.iter().any(|candidate| candidate == key) {
                due.push(key.clone());
                to_drop -= 1;
            }
        }

        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker(timeout: u64, max_loaded: usize) -> ResidencyTracker {
        ResidencyTracker::new(ResidencyPolicy::new(timeout, max_loaded))
    }

    #[test]
    fn touch_records_and_refreshes() {
        let mut tracker = tracker(60, 2);
        tracker.touch("a.onnx", 10);
        assert!(tracker.is_loaded("a.onnx"));
        assert_eq!(tracker.len(), 1);

        tracker.touch("a.onnx", 40);
        let loaded = tracker.loaded(40);
        assert_eq!(loaded[0].idle_secs, 0);
        assert!(!loaded[0].pinned);
    }

    #[test]
    fn idle_timeout_evicts_at_boundary_only() {
        let mut tracker = tracker(60, 8);
        tracker.touch("a.onnx", 0);
        assert!(tracker.due_for_eviction(59).is_empty());
        assert_eq!(tracker.due_for_eviction(60), vec!["a.onnx".to_string()]);
    }

    #[test]
    fn pinned_models_survive_idle_timeout() {
        let mut tracker = tracker(10, 8);
        tracker.touch("job.onnx", 0);
        tracker.set_pinned("job.onnx", true);
        assert!(tracker.due_for_eviction(1_000).is_empty());
        tracker.set_pinned("job.onnx", false);
        assert_eq!(
            tracker.due_for_eviction(1_000),
            vec!["job.onnx".to_string()]
        );
    }

    #[test]
    fn lru_eviction_respects_budget() {
        let mut tracker = tracker(600, 2);
        tracker.touch("old.onnx", 0);
        tracker.touch("mid.onnx", 5);
        tracker.touch("new.onnx", 9);
        let due = tracker.due_for_eviction(9);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0], "old.onnx");
        // Nothing else is over budget once one entry goes.
        assert!(tracker.due_for_eviction(9).len() <= 1);
    }

    #[test]
    fn eviction_never_exceeds_budget_by_half() {
        let mut tracker = tracker(600, 2);
        for (index, key) in ["a", "b", "c", "d"].iter().enumerate() {
            tracker.touch(key, index as u64);
        }
        assert_eq!(tracker.due_for_eviction(4).len(), 2);
    }

    #[test]
    fn reserving_a_slot_evicts_before_loading() {
        let mut tracker = tracker(600, 2);
        tracker.touch("a.onnx", 0);
        tracker.touch("b.onnx", 1);
        // Two loaded and a third about to load: reclaim the oldest first.
        assert_eq!(
            tracker.due_for_eviction_reserving(1, 1),
            vec!["a.onnx".to_string()]
        );
        // A reserve that still fits the budget evicts nothing.
        let fresh = ResidencyTracker::new(ResidencyPolicy::new(600, 2));
        assert!(fresh.due_for_eviction_reserving(0, 1).is_empty());
    }

    #[test]
    fn idle_only_policy_never_evicts_for_budget() {
        let mut idle_only = ResidencyTracker::new(ResidencyPolicy::idle_only(false));
        for index in 0..10 {
            idle_only.touch(&format!("m{index}.onnx"), 0);
        }
        // Way over any pool budget, but freshly used: nothing to unload.
        assert!(idle_only.due_for_eviction_reserving(0, 100).is_empty());
        // Once idle, every entry goes regardless of the "budget".
        assert_eq!(idle_only.due_for_eviction(600).len(), 10);
    }

    #[test]
    fn release_and_clear_forget_entries() {
        let mut tracker = tracker(60, 2);
        tracker.touch("a.onnx", 0);
        tracker.touch("b.onnx", 0);
        tracker.mark_released("a.onnx");
        assert_eq!(tracker.len(), 1);
        tracker.clear();
        assert!(tracker.is_empty());
        assert!(tracker.due_for_eviction(10_000).is_empty());
    }

    #[test]
    fn android_policy_is_stricter_than_desktop() {
        let android = ResidencyPolicy::for_platform(true);
        let desktop = ResidencyPolicy::for_platform(false);
        assert_eq!(android.idle_timeout_secs(), ANDROID_IDLE_TIMEOUT_SECS);
        assert_eq!(android.max_loaded(), ANDROID_MAX_LOADED);
        assert!(android.idle_timeout_secs() < desktop.idle_timeout_secs());
        assert!(android.max_loaded() < desktop.max_loaded());
    }
}
