//! Non-linear edit history (a revision DAG per image).
//!
//! The editor keeps a linear in-memory undo stack for the current session. This
//! module adds the durable layer: every snapshot the user pins becomes a
//! revision with a parent, so they can branch, jump back, and keep snapshots
//! across restarts. The graph is pure data (`EditHistoryGraph`) so it can be
//! unit-tested without Tauri; the commands in `lib.rs` only handle disk I/O and
//! timestamps.
//!
//! Persistence is one JSON file per image under `<app_data>/edit_history`, keyed
//! by the SHA-256 of the image path. Writes go through a temp file + rename so a
//! crash never leaves a half-written graph.

// The command layer consumes this API from lib.rs; tests are the other consumer.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Snapshots beyond this count are pruned (oldest non-head revisions first).
pub const MAX_REVISIONS: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub created_at: u64,
    pub adjustments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditHistoryGraph {
    pub revisions: HashMap<String, Revision>,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub id: String,
    pub parent_id: Option<String>,
    pub label: String,
    pub created_at: u64,
    pub depth: u32,
    pub is_head: bool,
}

/// Serialized to the UI: summaries only, so a deep graph does not ship every
/// adjustment blob to the frontend just to render the menu.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditHistoryView {
    pub head: Option<String>,
    pub revisions: Vec<RevisionSummary>,
}

impl EditHistoryView {
    pub fn empty() -> Self {
        Self {
            head: None,
            revisions: Vec::new(),
        }
    }
}

impl EditHistoryGraph {
    /// Creates a graph whose single root revision is already checked out.
    pub fn new(adjustments: Value, label: impl Into<String>, now: u64) -> Self {
        let id = new_id();
        let revision = Revision {
            id: id.clone(),
            parent_id: None,
            label: label.into(),
            created_at: now,
            adjustments,
        };
        let mut revisions = HashMap::new();
        revisions.insert(id.clone(), revision);
        Self {
            revisions,
            head: Some(id),
        }
    }

    /// Adds a revision as a child of `parent_id` (or the current head when
    /// omitted) and moves the head to it. Unknown parents are rejected instead
    /// of silently creating an orphan.
    pub fn commit(
        &mut self,
        parent_id: Option<&str>,
        label: impl Into<String>,
        adjustments: Value,
        now: u64,
    ) -> Result<String, String> {
        let parent = match parent_id {
            Some(id) => Some(id.to_string()),
            None => self.head.clone(),
        };
        if let Some(parent_id) = &parent
            && !self.revisions.contains_key(parent_id)
        {
            return Err(format!("Unknown parent revision: {parent_id}"));
        }

        let id = new_id();
        let revision = Revision {
            id: id.clone(),
            parent_id: parent,
            label: label.into(),
            created_at: now,
            adjustments,
        };
        self.revisions.insert(id.clone(), revision);
        self.head = Some(id.clone());
        Ok(id)
    }

    /// Moves the head to `id` and returns that revision's adjustments so the
    /// caller can apply them as a whole (not a merge).
    pub fn checkout(&mut self, id: &str) -> Result<Value, String> {
        let adjustments = self
            .revisions
            .get(id)
            .ok_or_else(|| format!("Unknown revision: {id}"))?
            .adjustments
            .clone();
        self.head = Some(id.to_string());
        Ok(adjustments)
    }

    pub fn set_label(&mut self, id: &str, label: impl Into<String>) -> Result<(), String> {
        let revision = self
            .revisions
            .get_mut(id)
            .ok_or_else(|| format!("Unknown revision: {id}"))?;
        revision.label = label.into();
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&Revision> {
        self.revisions.get(id)
    }

    /// Direct children, newest last, for branch-aware UI.
    pub fn children(&self, id: &str) -> Vec<&Revision> {
        let mut children: Vec<&Revision> = self
            .revisions
            .values()
            .filter(|revision| revision.parent_id.as_deref() == Some(id))
            .collect();
        children.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        children
    }

    /// Deletes `id` and its descendants. The root and any subtree containing
    /// the head are protected so the graph always keeps a valid checkout.
    pub fn delete_subtree(&mut self, id: &str) -> Result<usize, String> {
        let revision = self
            .revisions
            .get(id)
            .ok_or_else(|| format!("Unknown revision: {id}"))?;
        if revision.parent_id.is_none() {
            return Err("Cannot delete the root revision".to_string());
        }

        let doomed = self.subtree_ids(id);
        if let Some(head) = &self.head
            && doomed.contains(head)
        {
            return Err("Cannot delete a revision that contains the current head".to_string());
        }

        let removed = doomed.len();
        for revision_id in doomed {
            self.revisions.remove(&revision_id);
        }
        Ok(removed)
    }

    /// Drops the oldest revisions (never the root or the head) until the graph
    /// fits in `max_revisions`. Children are re-parented to the removed node's
    /// parent, so a linear chain still shrinks instead of being stuck because
    /// its only leaf is the head.
    pub fn prune(&mut self, max_revisions: usize) -> usize {
        let mut removed = 0;
        while self.revisions.len() > max_revisions {
            let candidate = self
                .revisions
                .values()
                .filter(|revision| {
                    revision.parent_id.is_some()
                        && self.head.as_deref() != Some(revision.id.as_str())
                })
                .min_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)))
                .map(|revision| (revision.id.clone(), revision.parent_id.clone()));
            let Some((id, parent)) = candidate else {
                break;
            };

            let children: Vec<String> = self
                .revisions
                .values()
                .filter(|revision| revision.parent_id.as_deref() == Some(id.as_str()))
                .map(|revision| revision.id.clone())
                .collect();
            for child in children {
                if let Some(revision) = self.revisions.get_mut(&child) {
                    revision.parent_id = parent.clone();
                }
            }
            self.revisions.remove(&id);
            removed += 1;
        }
        removed
    }

    /// Summaries for the history menu, oldest first so the UI can render a
    /// tree top-down. Depth is derived from parent links, with a cycle guard.
    pub fn summary(&self) -> Vec<RevisionSummary> {
        let mut summaries: Vec<RevisionSummary> = self
            .revisions
            .values()
            .map(|revision| RevisionSummary {
                id: revision.id.clone(),
                parent_id: revision.parent_id.clone(),
                label: revision.label.clone(),
                created_at: revision.created_at,
                depth: self.depth_of(&revision.id),
                is_head: self.head.as_deref() == Some(revision.id.as_str()),
            })
            .collect();
        summaries.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        summaries
    }

    pub fn view(&self) -> EditHistoryView {
        EditHistoryView {
            head: self.head.clone(),
            revisions: self.summary(),
        }
    }

    pub fn len(&self) -> usize {
        self.revisions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.revisions.is_empty()
    }

    fn children_ids(&self, id: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .revisions
            .values()
            .filter(|revision| revision.parent_id.as_deref() == Some(id))
            .map(|revision| revision.id.clone())
            .collect();
        ids.sort();
        ids
    }

    fn subtree_ids(&self, root: &str) -> HashSet<String> {
        let mut ids = HashSet::new();
        let mut pending = vec![root.to_string()];
        while let Some(id) = pending.pop() {
            if !ids.insert(id.clone()) {
                continue;
            }
            pending.extend(self.children_ids(&id));
        }
        ids
    }

    fn depth_of(&self, id: &str) -> u32 {
        let mut depth = 0u32;
        let mut current = self.revisions.get(id);
        // Each step consumes one node; the cap makes a corrupted cache with a
        // cycle render as a bounded depth instead of hanging the UI.
        for _ in 0..=self.revisions.len() {
            match current {
                Some(revision) => match revision
                    .parent_id
                    .as_deref()
                    .and_then(|pid| self.revisions.get(pid))
                {
                    Some(parent) => {
                        depth += 1;
                        current = Some(parent);
                    }
                    None => break,
                },
                None => break,
            }
        }
        depth
    }
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Directory holding one graph file per image.
pub fn storage_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("edit_history")
}

/// Deterministic per-image filename. Hashing the full path keeps arbitrary
/// filesystem names out of the filename while avoiding collisions between
/// images that share a basename.
pub fn history_path(app_data_dir: &Path, image_path: &str) -> PathBuf {
    let digest = crate::model_registry::sha256_hex(image_path.as_bytes());
    storage_dir(app_data_dir).join(format!("{digest}.json"))
}

/// Returns `Ok(None)` when the image has no snapshots yet and an error when an
/// existing file is unreadable, so corruption is visible instead of silently
/// wiping the user's history.
pub fn load(path: &Path) -> Result<Option<EditHistoryGraph>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let graph: EditHistoryGraph =
        serde_json::from_str(&contents).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(Some(graph))
}

/// Atomic write: unique temp file first, then rename over the real file. The
/// temp name is per-call so two saves racing on the same image can never
/// clobber each other's temp file or fail on an already-renamed one.
pub fn save(path: &Path, graph: &EditHistoryGraph) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let serialized =
        serde_json::to_string_pretty(graph).map_err(|error| format!("serialize: {error}"))?;
    let temp = path.with_extension(format!("json.{}.tmp", new_id()));
    fs::write(&temp, serialized).map_err(|error| format!("{}: {error}", temp.display()))?;
    fs::rename(&temp, path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alcedo-edit-history-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn new_graph_has_checked_out_root() {
        let graph = EditHistoryGraph::new(json!({"exposure": 1.0}), "Original", 10);
        assert_eq!(graph.len(), 1);
        assert!(!graph.is_empty());
        let summary = graph.summary();
        assert_eq!(summary.len(), 1);
        assert_eq!(summary[0].depth, 0);
        assert!(summary[0].is_head);
        assert!(summary[0].parent_id.is_none());
        assert_eq!(graph.head.as_deref(), Some(summary[0].id.as_str()));
    }

    #[test]
    fn commit_branches_from_explicit_parent_and_moves_head() {
        let mut graph = EditHistoryGraph::new(json!({"exposure": 0.0}), "Original", 10);
        let root = graph.head.clone().unwrap();
        let first = graph
            .commit(Some(&root), "Warm", json!({"exposure": 1.0}), 20)
            .unwrap();
        let second = graph
            .commit(Some(&root), "Cool", json!({"exposure": -1.0}), 21)
            .unwrap();
        assert_eq!(graph.head.as_deref(), Some(second.as_str()));
        assert_eq!(graph.len(), 3);
        let children = graph.children(&root);
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].id, first);
        assert_eq!(children[1].id, second);
    }

    #[test]
    fn commit_rejects_unknown_parent() {
        let mut graph = EditHistoryGraph::new(json!({}), "Original", 10);
        let error = graph
            .commit(Some("missing"), "Bad", json!({}), 20)
            .unwrap_err();
        assert!(error.contains("Unknown parent"));
        assert_eq!(graph.len(), 1);
    }

    #[test]
    fn checkout_returns_whole_adjustments_and_moves_head() {
        let mut graph = EditHistoryGraph::new(json!({"exposure": 0.0}), "Original", 10);
        let root = graph.head.clone().unwrap();
        let branch = graph
            .commit(Some(&root), "Branch", json!({"exposure": 2.0}), 20)
            .unwrap();
        assert_eq!(graph.head.as_deref(), Some(branch.as_str()));
        let applied = graph.checkout(&root).unwrap();
        assert_eq!(applied, json!({"exposure": 0.0}));
        assert_eq!(graph.head.as_deref(), Some(root.as_str()));
        assert!(graph.checkout("missing").is_err());
    }

    #[test]
    fn delete_subtree_protects_root_and_head() {
        let mut graph = EditHistoryGraph::new(json!({}), "Original", 10);
        let root = graph.head.clone().unwrap();
        assert!(graph.delete_subtree(&root).is_err());

        let branch = graph.commit(Some(&root), "Branch", json!({}), 20).unwrap();
        let leaf = graph.commit(Some(&branch), "Leaf", json!({}), 21).unwrap();
        // Head is the leaf, so its subtree (the leaf itself) is protected.
        assert!(graph.delete_subtree(&leaf).is_err());
        // The branch contains the head, so it is protected too.
        assert!(graph.delete_subtree(&branch).is_err());

        graph.checkout(&root).unwrap();
        let removed = graph.delete_subtree(&branch).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(graph.len(), 1);
    }

    #[test]
    fn prune_drops_oldest_leaves_and_never_the_head() {
        let mut graph = EditHistoryGraph::new(json!({"n": 0}), "Original", 0);
        for index in 1..=6 {
            graph
                .commit(None, format!("R{index}"), json!({"n": index}), index as u64)
                .unwrap();
        }
        let head = graph.head.clone().unwrap();
        let removed = graph.prune(3);
        assert_eq!(removed, 4);
        assert_eq!(graph.len(), 3);
        assert!(graph.get(&head).is_some());
        // Freed nodes are the oldest non-head revisions; the remaining chain
        // stays connected through re-parenting.
        let remaining_root = graph
            .revisions
            .values()
            .find(|revision| revision.parent_id.is_none())
            .unwrap();
        assert!(graph.get(&remaining_root.id).is_some());
        assert!(graph.revisions.values().all(|revision| {
            revision
                .parent_id
                .as_deref()
                .is_none_or(|parent| graph.get(parent).is_some())
        }));
    }

    #[test]
    fn summary_reports_depth_and_ordering() {
        let mut graph = EditHistoryGraph::new(json!({}), "Original", 100);
        let root = graph.head.clone().unwrap();
        let branch = graph.commit(Some(&root), "Branch", json!({}), 200).unwrap();
        let leaf = graph.commit(Some(&branch), "Leaf", json!({}), 300).unwrap();
        let summary = graph.summary();
        assert_eq!(summary.len(), 3);
        assert_eq!(summary[0].id, root);
        assert_eq!(summary[0].depth, 0);
        assert_eq!(summary[1].id, branch);
        assert_eq!(summary[1].depth, 1);
        assert_eq!(summary[2].id, leaf);
        assert_eq!(summary[2].depth, 2);
        assert!(summary[2].is_head);
        assert_eq!(graph.view().head.as_deref(), Some(leaf.as_str()));
    }

    #[test]
    fn labels_can_be_renamed() {
        let mut graph = EditHistoryGraph::new(json!({}), "Original", 10);
        let root = graph.head.clone().unwrap();
        graph.set_label(&root, "Base").unwrap();
        assert_eq!(graph.get(&root).unwrap().label, "Base");
        assert!(graph.set_label("missing", "Nope").is_err());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = temp_dir();
        let path = history_path(&dir, "/photos/a.dng");
        assert!(load(&path).unwrap().is_none());
        assert!(path.starts_with(storage_dir(&dir)));

        let mut graph = EditHistoryGraph::new(json!({"exposure": 1.5}), "Original", 10);
        graph
            .commit(None, "Warm", json!({"exposure": 2.0}), 20)
            .unwrap();
        save(&path, &graph).unwrap();
        save(&path, &graph).unwrap();

        let loaded = load(&path).unwrap().unwrap();
        assert_eq!(loaded, graph);
        // No temp file may survive a completed write.
        let leftovers: Vec<_> = fs::read_dir(storage_dir(&dir))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_reports_corrupt_history() {
        let dir = temp_dir();
        let path = history_path(&dir, "/photos/b.dng");
        save(&path, &EditHistoryGraph::new(json!({}), "Original", 0)).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_paths_are_stable_and_unique() {
        let dir = temp_dir();
        let a = history_path(&dir, "/photos/a.dng");
        let same = history_path(&dir, "/photos/a.dng");
        let b = history_path(&dir, "/photos/b.dng");
        assert_eq!(a, same);
        assert_ne!(a, b);
        std::fs::remove_dir_all(&dir).ok();
    }
}
