//! A small file logger for support: `<data>/logs/main.log`, rotated at 5 MB
//! (the previous file is `main.log.1`). Per-file details stay out of it: only
//! jobs, errors and their causes. A record is one line, whatever its message
//! holds. Lines go to a thread of their own, so a burst of logs never blocks
//! the app, and are flushed before the app quits.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use op_media_service::LogLevel;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

enum Message {
    Line(String),
    Flush(Sender<()>),
}

struct Logger {
    file: PathBuf,
    sender: Mutex<Sender<Message>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// Starts the logger on `<dir>/main.log`; before it, lines only reach the console
pub fn init(dir: &Path) {
    let file = dir.join("main.log");
    let (sender, receiver) = mpsc::channel();
    let target = file.clone();
    std::thread::Builder::new()
        .name("log".into())
        .spawn(move || write_loop(&target, receiver))
        .expect("cannot start the log thread");
    let _ = LOGGER.set(Logger {
        file,
        sender: Mutex::new(sender),
    });
}

pub fn log_file() -> Option<PathBuf> {
    LOGGER.get().map(|logger| logger.file.clone())
}

/// CR, LF and the Unicode line and paragraph separators would forge records: they are written escaped
pub fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            _ => out.push(c),
        }
    }
    out
}

pub fn log(level: LogLevel, message: impl AsRef<str>) {
    let line = format!(
        "{} {} {}\n",
        op_media_service::now_iso(),
        level.as_str(),
        one_line(message.as_ref())
    );
    let development = cfg!(debug_assertions);
    if development || level == LogLevel::Error {
        let _ = std::io::stdout().write_all(line.as_bytes());
    }
    if level == LogLevel::Debug && !development {
        return;
    }
    if let Some(logger) = LOGGER.get() {
        let _ = logger
            .sender
            .lock()
            .map(|sender| sender.send(Message::Line(line)));
    }
}

/// Waits (a little) for the lines queued to be written: the app is about to end
pub fn flush() {
    let Some(logger) = LOGGER.get() else { return };
    let (done, wait) = mpsc::channel();
    if logger
        .sender
        .lock()
        .map(|sender| sender.send(Message::Flush(done)))
        .is_ok()
    {
        let _ = wait.recv_timeout(std::time::Duration::from_secs(2));
    }
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => { $crate::log::log(op_media_service::LogLevel::Info, format!($($arg)*)) };
}
#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => { $crate::log::log(op_media_service::LogLevel::Warn, format!($($arg)*)) };
}
#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => { $crate::log::log(op_media_service::LogLevel::Error, format!($($arg)*)) };
}
#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => { $crate::log::log(op_media_service::LogLevel::Debug, format!($($arg)*)) };
}

fn write_loop(file: &Path, receiver: Receiver<Message>) {
    let mut size: Option<u64> = None;
    while let Ok(message) = receiver.recv() {
        let mut chunk = String::new();
        let mut flushes = Vec::new();
        let mut push = |message: Message| match message {
            Message::Line(line) => chunk.push_str(&line),
            Message::Flush(done) => flushes.push(done),
        };
        push(message);
        // Lines logged together go out together
        while let Ok(more) = receiver.try_recv() {
            push(more);
        }
        if !chunk.is_empty() {
            append(file, &chunk, &mut size);
        }
        for done in flushes {
            let _ = done.send(());
        }
    }
}

/// Logging must never break the app: a failure is forgotten, the size read again next time
fn append(file: &Path, chunk: &str, size: &mut Option<u64>) {
    let result = (|| -> std::io::Result<()> {
        if size.is_none() {
            if let Some(dir) = file.parent() {
                fs::create_dir_all(dir)?;
            }
            *size = Some(fs::metadata(file).map(|m| m.len()).unwrap_or(0));
        }
        let bytes = chunk.len() as u64;
        let current = size.unwrap_or(0);
        if current > 0 && current + bytes > MAX_BYTES {
            // A file that cannot be renamed now (open in a viewer) keeps growing until it can
            let mut rotated = file.as_os_str().to_owned();
            rotated.push(".1");
            if fs::rename(file, PathBuf::from(rotated)).is_ok() {
                *size = Some(0);
            }
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)?
            .write_all(chunk.as_bytes())?;
        *size = Some(size.unwrap_or(0) + bytes);
        Ok(())
    })();
    if result.is_err() {
        *size = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_stay_on_one_line() {
        assert_eq!(one_line("a\r\nb\u{2028}c"), "a\\r\\nb\\u2028c");
    }

    #[test]
    fn rotates_at_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("main.log");
        fs::write(&file, vec![b'x'; MAX_BYTES as usize - 2]).unwrap();
        let mut size = None;
        append(&file, "a line\n", &mut size);
        assert_eq!(fs::read_to_string(&file).unwrap(), "a line\n");
        assert_eq!(
            fs::metadata(dir.path().join("main.log.1")).unwrap().len(),
            MAX_BYTES - 2
        );
    }
}
