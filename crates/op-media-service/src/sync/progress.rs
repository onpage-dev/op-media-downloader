//! Counters, bytes, a speed smoothed over the last seconds and the time left.
//! Shared by the workers of a job: every method takes `&self`.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::models::{ListingProgress, Progress, now_iso};

const WINDOW: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy)]
pub enum Counter {
    Downloaded,
    Linked,
    Removed,
    AlreadyPresent,
    Failed,
}

struct Inner {
    progress: Progress,
    samples: VecDeque<(Instant, u64)>,
}

pub struct ProgressTracker {
    inner: Mutex<Inner>,
}

impl ProgressTracker {
    pub fn new(total: u64, bytes_total: u64, concurrency: u64) -> ProgressTracker {
        ProgressTracker {
            inner: Mutex::new(Inner {
                progress: Progress { started_at: now_iso(), total, bytes_total, concurrency, ..Progress::default() },
                samples: VecDeque::new(),
            }),
        }
    }

    pub fn add_bytes(&self, delta: i64) {
        let mut inner = self.inner.lock();
        let p = &mut inner.progress;
        p.bytes_done = (p.bytes_done as i64 + delta).max(0) as u64;
        if p.bytes_done > p.bytes_total {
            p.bytes_total = p.bytes_done;
        }
    }

    /// A size learned only from Content-Length
    pub fn add_bytes_total(&self, delta: u64) {
        self.inner.lock().progress.bytes_total += delta;
    }

    pub fn count(&self, counter: Counter, n: u64) {
        let mut inner = self.inner.lock();
        let p = &mut inner.progress;
        match counter {
            Counter::Downloaded => p.downloaded += n,
            Counter::Linked => p.linked += n,
            Counter::Removed => p.removed += n,
            Counter::AlreadyPresent => p.already_present += n,
            Counter::Failed => p.failed += n,
        }
    }

    pub fn in_flight(&self, delta: i64) {
        let mut inner = self.inner.lock();
        inner.progress.in_flight = (inner.progress.in_flight as i64 + delta).max(0) as u64;
    }

    pub fn set_listing(&self, listing: ListingProgress) {
        self.inner.lock().progress.listing = Some(listing);
    }

    /// The counters as they are, without touching the speed
    pub fn current(&self) -> Progress {
        self.inner.lock().progress.clone()
    }

    /// A copy with speed and time left updated
    pub fn snapshot(&self) -> Progress {
        let mut inner = self.inner.lock();
        let now = Instant::now();
        let done = inner.progress.bytes_done;
        inner.samples.push_back((now, done));
        while inner.samples.len() > 2 && inner.samples.front().is_some_and(|(t, _)| now - *t > WINDOW) {
            inner.samples.pop_front();
        }
        let (t0, b0) = inner.samples[0];
        let elapsed = (now - t0).as_secs_f64();
        if elapsed >= 0.5 {
            inner.progress.speed_bps = ((done as f64 - b0 as f64) / elapsed).max(0.0);
        }
        let left = inner.progress.bytes_total.saturating_sub(done);
        let speed = inner.progress.speed_bps;
        inner.progress.eta_seconds = (speed > 0.0 && left > 0).then(|| (left as f64 / speed).round() as u64);
        inner.progress.clone()
    }
}
