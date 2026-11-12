//! Retries for the network: exponential backoff with jitter, the server's
//! `Retry-After` honoured (within a limit), cancellation at every wait.

use std::future::Future;
use std::time::Duration;

use rand::Rng;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Total attempts, the first included
    pub attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    /// Longest wait accepted from a Retry-After header
    pub max_retry_after: Duration,
}

pub const API_RETRY: RetryPolicy = RetryPolicy {
    attempts: 6,
    base_delay: Duration::from_millis(1000),
    max_delay: Duration::from_secs(30),
    max_retry_after: Duration::from_secs(120),
};

pub const DOWNLOAD_RETRY: RetryPolicy = RetryPolicy {
    attempts: 4,
    base_delay: Duration::from_millis(1000),
    max_delay: Duration::from_secs(30),
    max_retry_after: Duration::from_secs(120),
};

/// Resolves after `delay`; `Error::Aborted` as soon as the token is cancelled
pub async fn sleep(delay: Duration, cancel: Option<&CancellationToken>) -> Result<()> {
    match cancel {
        None => {
            tokio::time::sleep(delay).await;
            Ok(())
        }
        Some(token) => {
            if token.is_cancelled() {
                return Err(Error::Aborted);
            }
            tokio::select! {
                _ = tokio::time::sleep(delay) => Ok(()),
                _ = token.cancelled() => Err(Error::Aborted),
            }
        }
    }
}

/// Exponential backoff with ±25% jitter
pub fn backoff_delay(attempt: u32, policy: &RetryPolicy) -> Duration {
    let exp = attempt.saturating_sub(1).min(30);
    let base = policy.base_delay.as_millis() as f64 * 2f64.powi(exp as i32);
    let base = base.min(policy.max_delay.as_millis() as f64);
    let jitter = 0.75 + rand::rng().random::<f64>() * 0.5;
    Duration::from_millis((base * jitter).round() as u64)
}

/// Retry-After as seconds or as an HTTP date
pub fn parse_retry_after(value: Option<&str>) -> Option<Duration> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        return seconds.is_finite().then(|| Duration::from_millis((seconds.max(0.0) * 1000.0) as u64));
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let ms = date.timestamp_millis() - chrono::Utc::now().timestamp_millis();
    Some(Duration::from_millis(ms.max(0) as u64))
}

/// Runs `task` until it succeeds, a final error, the last attempt or a
/// cancellation. `on_retry` is called before each wait with what failed.
pub async fn with_retry<T, F, Fut>(
    policy: &RetryPolicy,
    cancel: Option<&CancellationToken>,
    mut on_retry: impl FnMut(&Error, u32, Duration),
    mut task: F,
) -> Result<T>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut attempt = 1;
    loop {
        if cancel.is_some_and(|c| c.is_cancelled()) {
            return Err(Error::Aborted);
        }
        match task(attempt).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if cancel.is_some_and(|c| c.is_cancelled()) {
                    return Err(Error::Aborted);
                }
                if attempt >= policy.attempts || !error.is_retryable() {
                    return Err(error);
                }
                let mut delay = backoff_delay(attempt, policy);
                if let Error::Http { retry_after: Some(after), .. } = &error {
                    delay = delay.max((*after).min(policy.max_retry_after));
                }
                on_retry(&error, attempt, delay);
                sleep(delay, cancel).await?;
                attempt += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_seconds_and_dates() {
        assert_eq!(parse_retry_after(Some("3")), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after(Some("")), None);
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")), Some(Duration::ZERO));
        assert_eq!(parse_retry_after(Some("soon")), None);
    }

    #[test]
    fn backoff_grows_and_stays_within_the_limit() {
        let policy = API_RETRY;
        for attempt in 1..10 {
            let delay = backoff_delay(attempt, &policy).as_millis() as f64;
            let base = (1000.0 * 2f64.powi(attempt as i32 - 1)).min(30_000.0);
            assert!(delay >= base * 0.75 - 1.0 && delay <= base * 1.25 + 1.0, "{attempt}: {delay}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn retries_retryable_errors_only() {
        let mut calls = 0;
        let result: Result<()> = with_retry(
            &API_RETRY,
            None,
            |_, _, _| {},
            |_| {
                calls += 1;
                async { Err(Error::Http { status: 404, retry_after: None }) }
            },
        )
        .await;
        assert!(matches!(result, Err(Error::Http { status: 404, .. })));
        assert_eq!(calls, 1);

        let mut calls = 0;
        let result =
            with_retry(
                &API_RETRY,
                None,
                |_, _, _| {},
                |attempt| {
                    calls += 1;
                    async move {
                        if attempt < 3 { Err(Error::Http { status: 503, retry_after: None }) } else { Ok(attempt) }
                    }
                },
            )
            .await;
        assert_eq!(result.unwrap(), 3);
        assert_eq!(calls, 3);
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_wait_ends_with_aborted() {
        let token = CancellationToken::new();
        token.cancel();
        let result: Result<()> = with_retry(&API_RETRY, Some(&token), |_, _, _| {}, |_| async { Ok(()) }).await;
        assert!(matches!(result, Err(Error::Aborted)));
    }
}
