//! data/.lock: one writer per folder, also across computers sharing a network folder
use std::time::Duration;

pub const LOCK_STALE: Duration = Duration::from_secs(120);
pub const LOCK_HEARTBEAT: Duration = Duration::from_secs(30);
