//! The last events of a project for the «Attività» tab, and the complete
//! list of what failed in the last run for «Falliti» and «Riprova i falliti».

use std::collections::{BTreeMap, HashMap, VecDeque};

use crate::models::{ActivityEntry, ActivityOutcome, FailedEntry, FailureCode, FileToken, now_iso};

const MAX_ENTRIES: usize = 1000;
/// In-flight progress is sent again only after this much change
const PROGRESS_STEP: f64 = 0.05;

/// What a new event says; the log gives it an id and a time
#[derive(Debug, Clone)]
pub struct NewActivity {
    pub name: String,
    pub token: Option<FileToken>,
    pub size: Option<u64>,
    pub outcome: ActivityOutcome,
    pub progress: Option<f64>,
    pub reason: Option<FailureCode>,
    pub same_as: Option<String>,
}

impl NewActivity {
    pub fn new(name: &str, token: &str, size: Option<u64>, outcome: ActivityOutcome) -> NewActivity {
        NewActivity {
            name: name.to_string(),
            token: Some(token.to_string()),
            size,
            outcome,
            progress: None,
            reason: None,
            same_as: None,
        }
    }

    pub fn reason(mut self, reason: FailureCode) -> NewActivity {
        self.reason = Some(reason);
        self
    }

    pub fn same_as(mut self, name: &str) -> NewActivity {
        self.same_as = Some(name.to_string());
        self
    }

    pub fn progress(mut self, progress: f64) -> NewActivity {
        self.progress = Some(progress);
        self
    }
}

/// A change of an entry; `None` leaves a field as it is
#[derive(Debug, Clone, Default)]
pub struct ActivityPatch {
    pub outcome: Option<ActivityOutcome>,
    /// `Some(None)` removes the progress
    pub progress: Option<Option<f64>>,
    pub reason: Option<FailureCode>,
    pub name: Option<String>,
}

#[derive(Default)]
pub struct ActivityLog {
    /// The last MAX_ENTRIES events, oldest first
    ring: VecDeque<ActivityEntry>,
    /// Ids still in the ring → position offset (id - first id in ring)
    first_id: u64,
    /// Added or changed since the last batch: only entries still in the ring
    changed: BTreeMap<u64, ()>,
    next_id: u64,
}

impl ActivityLog {
    pub fn new() -> ActivityLog {
        ActivityLog { ring: VecDeque::new(), first_id: 1, changed: BTreeMap::new(), next_id: 1 }
    }

    fn position(&self, id: u64) -> Option<usize> {
        let offset = id.checked_sub(self.first_id)? as usize;
        (offset < self.ring.len()).then_some(offset)
    }

    pub fn add(&mut self, entry: NewActivity) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        if self.ring.len() >= MAX_ENTRIES {
            // The oldest leaves, from the next batch too
            if let Some(old) = self.ring.pop_front() {
                self.changed.remove(&old.id);
                self.first_id = old.id + 1;
            }
        }
        if self.ring.is_empty() {
            self.first_id = id;
        }
        self.ring.push_back(ActivityEntry {
            id,
            at: now_iso(),
            name: entry.name,
            token: entry.token,
            size: entry.size,
            outcome: entry.outcome,
            progress: entry.progress,
            reason: entry.reason,
            same_as: entry.same_as,
        });
        self.changed.insert(id, ());
        id
    }

    /// Updates an entry in place (in-flight progress, final outcome)
    pub fn update(&mut self, id: u64, patch: ActivityPatch) {
        let Some(position) = self.position(id) else { return };
        let entry = &mut self.ring[position];
        let progress_only = patch.outcome.is_none() && patch.reason.is_none() && patch.name.is_none();
        if progress_only {
            if let Some(Some(progress)) = patch.progress {
                let step = (progress - entry.progress.unwrap_or(0.0)).abs();
                entry.progress = Some(progress);
                if step < PROGRESS_STEP {
                    return;
                }
                self.changed.insert(id, ());
                return;
            }
        }
        if let Some(outcome) = patch.outcome {
            entry.outcome = outcome;
        }
        if let Some(progress) = patch.progress {
            entry.progress = progress;
        }
        if let Some(reason) = patch.reason {
            entry.reason = Some(reason);
        }
        if let Some(name) = patch.name {
            entry.name = name;
        }
        self.changed.insert(id, ());
    }

    /// The newest `limit` entries, oldest first
    pub fn recent(&self, limit: usize) -> Vec<ActivityEntry> {
        let count = limit.min(self.ring.len());
        self.ring.iter().skip(self.ring.len() - count).cloned().collect()
    }

    /// Entries added or changed since the last call, oldest first
    pub fn take_changed(&mut self) -> Vec<ActivityEntry> {
        let ids: Vec<u64> = std::mem::take(&mut self.changed).into_keys().collect();
        ids.into_iter().filter_map(|id| self.position(id).map(|p| self.ring[p].clone())).collect()
    }
}

#[derive(Default)]
pub struct FailedList {
    /// name → (order of first failure, entry): a name failing again keeps its place
    items: HashMap<String, (u64, FailedEntry)>,
    next: u64,
}

fn retryable(entry: &FailedEntry) -> bool {
    entry.reason != FailureCode::NameConflict && entry.reason != FailureCode::InvalidName
}

impl FailedList {
    pub fn set(&mut self, entry: FailedEntry) {
        let order = match self.items.get(&entry.name) {
            Some((order, _)) => *order,
            None => {
                self.next += 1;
                self.next
            }
        };
        self.items.insert(entry.name.clone(), (order, entry));
    }

    pub fn delete(&mut self, name: &str) {
        self.items.remove(name);
    }

    /// In the order they first failed
    pub fn list(&self) -> Vec<FailedEntry> {
        let mut entries: Vec<&(u64, FailedEntry)> = self.items.values().collect();
        entries.sort_by_key(|(order, _)| *order);
        entries.into_iter().map(|(_, e)| e.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Real failures, the ones «Riprova i falliti» can fix (not conflicts)
    pub fn retryable(&self) -> Vec<FailedEntry> {
        self.list().into_iter().filter(retryable).collect()
    }

    pub fn retryable_count(&self) -> usize {
        self.items.values().filter(|(_, e)| retryable(e)).count()
    }

    pub fn retain(&mut self, keep: impl Fn(&FailedEntry) -> bool) {
        self.items.retain(|_, (_, e)| keep(e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(name: &str) -> NewActivity {
        NewActivity::new(name, "t", None, ActivityOutcome::Downloaded)
    }

    #[test]
    fn keeps_the_last_thousand_and_batches_changes() {
        let mut log = ActivityLog::new();
        for i in 0..1005 {
            log.add(event(&format!("{i}")));
        }
        let recent = log.recent(2000);
        assert_eq!(recent.len(), 1000);
        assert_eq!(recent[0].name, "5");
        let batch = log.take_changed();
        assert_eq!(batch.len(), 1000, "the ones that left the log leave the batch too");
        assert!(log.take_changed().is_empty());
        let id = recent[999].id;
        log.update(id, ActivityPatch { progress: Some(Some(0.01)), ..Default::default() });
        assert!(log.take_changed().is_empty(), "small progress steps wait");
        log.update(id, ActivityPatch { progress: Some(Some(0.5)), ..Default::default() });
        assert_eq!(log.take_changed().len(), 1);
        log.update(id, ActivityPatch { outcome: Some(ActivityOutcome::Failed), progress: Some(None), ..Default::default() });
        let changed = log.take_changed();
        assert_eq!(changed[0].outcome, ActivityOutcome::Failed);
        assert_eq!(changed[0].progress, None);
    }
}
