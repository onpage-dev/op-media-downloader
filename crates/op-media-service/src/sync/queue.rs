//! Runs a worker over items, `concurrency` at a time, in the caller's task
//! (workers may borrow). When `cancel` fires no new item starts; the ones
//! running finish or abort on their own. The first error a worker returns
//! stops the queue (no new item starts) and, once the running ones have
//! finished, is returned to the caller.

use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

pub async fn run_queue<'a, T, F, Fut>(
    items: &'a [T],
    concurrency: usize,
    cancel: Option<&CancellationToken>,
    worker: F,
) -> Result<()>
where
    F: Fn(&'a T, usize) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let next = AtomicUsize::new(0);
    let fatal: Mutex<Option<Error>> = Mutex::new(None);
    let lanes = concurrency.clamp(1, items.len().max(1));
    let lane = || async {
        loop {
            if cancel.is_some_and(|c| c.is_cancelled()) || fatal.lock().is_some() {
                return;
            }
            let index = next.fetch_add(1, Ordering::SeqCst);
            let Some(item) = items.get(index) else { return };
            if let Err(error) = worker(item, index).await {
                let mut slot = fatal.lock();
                if slot.is_none() {
                    *slot = Some(error);
                }
            }
        }
    };
    futures::future::join_all((0..lanes).map(|_| lane())).await;
    match fatal.into_inner() {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn runs_every_item_with_bounded_concurrency() {
        let items: Vec<u32> = (0..50).collect();
        let running = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        run_queue(&items, 4, None, |_, _| async {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            tokio::task::yield_now().await;
            running.fetch_sub(1, Ordering::SeqCst);
            done.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(done.load(Ordering::SeqCst), 50);
        assert!(peak.load(Ordering::SeqCst) <= 4);
    }

    #[tokio::test]
    async fn the_first_error_stops_new_items() {
        let items: Vec<u32> = (0..50).collect();
        let done = AtomicUsize::new(0);
        let result = run_queue(&items, 1, None, |item, _| {
            let done = &done;
            async move {
                done.fetch_add(1, Ordering::SeqCst);
                if *item == 3 { Err(Error::Aborted) } else { Ok(()) }
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(done.load(Ordering::SeqCst), 4);
    }
}
