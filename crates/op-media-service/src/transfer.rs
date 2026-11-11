//! One file from a URL to the disk, atomically: stream to a temporary
//! `<target>.<random>.download` (a leftover another program still holds
//! never blocks a new attempt) with a timeout before the first byte and
//! between chunks, check the size, flush it to the disk, then rename
//! (retrying transient Windows locks). Nothing is left behind on error, the
//! connection neither: a disk that refuses a write closes it at once. Errors
//! of the disk work are `Error::Disk`, never retried as network ones.

use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result, TimeoutStage};
use crate::fsx::{flush_to_disk, random_hex, rename_with_retry, unlink_quiet, with_suffix};
use crate::http::parse_retry_after;

pub const HEADERS_TIMEOUT: Duration = Duration::from_secs(30);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Bytes gathered before each write: a write is a round trip on a share
const WRITE_BUFFER: usize = 256 * 1024;

pub struct Download<'a> {
    pub http: &'a reqwest::Client,
    pub url: &'a str,
    /// The final path
    pub target: &'a Path,
    /// The size announced by On Page, when known
    pub expected_size: Option<u64>,
    pub cancel: Option<&'a CancellationToken>,
    pub headers_timeout: Duration,
    pub idle_timeout: Duration,
    /// Bytes written so far (delta), for progress and speed
    pub on_bytes: &'a (dyn Fn(u64) + Send + Sync),
    /// Content-Length once known
    pub on_length: &'a (dyn Fn(u64) + Send + Sync),
}

fn disk(error: Error) -> Error {
    match error {
        Error::Io(io) => Error::Disk(io),
        other => other,
    }
}

/// Waits for `work` unless `cancel` fires first (`Aborted`)
async fn or_cancel<T>(cancel: Option<&CancellationToken>, work: impl Future<Output = Result<T>>) -> Result<T> {
    match cancel {
        Some(token) => tokio::select! {
            result = work => result,
            _ = token.cancelled() => Err(Error::Aborted),
        },
        None => work.await,
    }
}

/// The bytes written, once the file is in place under its name
pub async fn download_to_file(options: Download<'_>) -> Result<u64> {
    let temp = with_suffix(options.target, &format!(".{}.download", random_hex(4)));
    let result = transfer(&options, &temp).await;
    if result.is_err() {
        let _ = unlink_quiet(&temp).await;
        if options.cancel.is_some_and(|c| c.is_cancelled()) {
            return Err(Error::Aborted);
        }
    }
    result
}

async fn transfer(options: &Download<'_>, temp: &Path) -> Result<u64> {
    let cancel = options.cancel;
    let mut response = or_cancel(cancel, async {
        match tokio::time::timeout(options.headers_timeout, options.http.get(options.url).send()).await {
            Ok(response) => Ok(response?),
            Err(_) => Err(Error::Timeout(TimeoutStage::Headers)),
        }
    })
    .await?;
    let status = response.status();
    if !status.is_success() {
        let retry_after = parse_retry_after(response.headers().get("retry-after").and_then(|v| v.to_str().ok()));
        // Dropping the answer closes the connection
        return Err(Error::Http { status: status.as_u16(), retry_after });
    }
    let length = response.content_length().filter(|&l| l > 0);
    let expected = options.expected_size.or(length);
    if let Some(length) = length {
        (options.on_length)(length);
    }

    // Opening the file is disk work: no network timer meanwhile
    let file = tokio::fs::File::create(temp).await.map_err(Error::Disk)?;
    let mut writer = BufWriter::with_capacity(WRITE_BUFFER, file);
    let mut written: u64 = 0;
    loop {
        // The idle timer measures the network only: a slow disk (a busy
        // share, an antivirus) must not look like a silent server
        let chunk = or_cancel(cancel, async {
            match tokio::time::timeout(options.idle_timeout, response.chunk()).await {
                Ok(chunk) => Ok(chunk?),
                Err(_) => Err(Error::Timeout(TimeoutStage::Idle)),
            }
        })
        .await?;
        let Some(chunk) = chunk else { break };
        or_cancel(cancel, async { writer.write_all(&chunk).await.map_err(Error::Disk) }).await?;
        written += chunk.len() as u64;
        (options.on_bytes)(chunk.len() as u64);
    }
    drop(response);

    // The network part is over: checking, flushing and renaming are disk work
    if let Some(expected) = expected {
        if written != expected {
            return Err(Error::SizeMismatch { expected, actual: written });
        }
    }
    writer.flush().await.map_err(Error::Disk)?;
    let file = writer.into_inner();
    flush_to_disk(&file).await.map_err(Error::Disk)?;
    drop(file);
    rename_with_retry(temp, options.target, 10, cancel).await.map_err(disk)?;
    Ok(written)
}
