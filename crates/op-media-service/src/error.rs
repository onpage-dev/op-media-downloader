//! Errors of the service and how they map to failure codes, issues and retry
//! decisions. File system errors are named by their POSIX code, as libuv
//! names them on every system (`ENOENT`, `EPERM`, `ENOSPC`…): the rules of
//! docs/ARCHITECTURE.md are written with those names.

use std::fmt;
use std::io;
use std::time::Duration;

use crate::models::{FailureCode, IssueCode};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutStage {
    /// Before the first byte of the answer
    Headers,
    /// Between two chunks of a body
    Idle,
    /// The whole request (API calls)
    Request,
}

/// An error that ends the whole job, with the issue to show
#[derive(Debug, Clone)]
pub struct JobError {
    pub issue: IssueCode,
    pub message: String,
    pub detail: Option<String>,
}

impl JobError {
    pub fn new(issue: IssueCode, message: impl Into<String>) -> JobError {
        JobError { issue, message: message.into(), detail: None }
    }

    pub fn with_detail(issue: IssueCode, message: impl Into<String>, detail: impl Into<String>) -> JobError {
        JobError { issue, message: message.into(), detail: Some(detail.into()) }
    }
}

impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug)]
pub enum Error {
    /// A non-2xx answer from On Page or from the storage
    Http { status: u16, retry_after: Option<Duration> },
    /// No answer in time
    Timeout(TimeoutStage),
    SizeMismatch { expected: u64, actual: u64 },
    /// The user (or the job) stopped the work
    Aborted,
    /// A name in the folder that the app did not create blocks a remote file
    Conflict(String),
    /// Windows: the file is open in another program, it cannot be replaced or removed now
    InUse { name: String, source: io::Error },
    /// A file system error of a download (the temporary file, a write, the
    /// flush, the rename): the folder's problem. A share that hiccups gives
    /// socket codes (ECONNRESET, ETIMEDOUT, EPIPE) that must not pass for
    /// network errors and start the download again
    Disk(io::Error),
    /// Any other file system error
    Io(io::Error),
    /// The connection to On Page or to the storage failed
    Network(String),
    /// Ends the whole job with an issue
    Job(JobError),
    /// An answer that cannot be read, a bug
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Http { status, .. } => write!(f, "HTTP {status}"),
            Error::Timeout(stage) => write!(
                f,
                "Timeout ({})",
                match stage {
                    TimeoutStage::Headers => "headers",
                    TimeoutStage::Idle => "idle",
                    TimeoutStage::Request => "request",
                }
            ),
            Error::SizeMismatch { expected, actual } => write!(f, "Expected {expected} bytes, got {actual}"),
            Error::Aborted => f.write_str("Aborted"),
            Error::Conflict(name) => write!(f, "\"{name}\" already exists and was not created by the app"),
            Error::InUse { name, .. } => write!(f, "\"{name}\" is open in another program"),
            Error::Disk(error) | Error::Io(error) => fmt::Display::fmt(error, f),
            Error::Network(message) | Error::Other(message) => f.write_str(message),
            Error::Job(error) => f.write_str(&error.message),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error::Io(error)
    }
}

impl From<JobError> for Error {
    fn from(error: JobError) -> Self {
        Error::Job(error)
    }
}

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            return Error::Timeout(TimeoutStage::Request);
        }
        if error.is_connect() || error.is_request() || error.is_body() {
            return Error::Network(describe_chain(&error));
        }
        Error::Other(describe_chain(&error))
    }
}

/// An error with its causes: reqwest's own message says little ("error sending request")
fn describe_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let part = cause.to_string();
        if !text.contains(&part) {
            text.push_str(": ");
            text.push_str(&part);
        }
        source = cause.source();
    }
    text
}

/* ------------------------------------------------------------------ codes */

/// The POSIX name of a file system or socket error, as libuv gives it
pub fn io_code(error: &io::Error) -> Option<&'static str> {
    if let Some(raw) = error.raw_os_error() {
        if let Some(code) = os_code(raw) {
            return Some(code);
        }
    }
    use io::ErrorKind::*;
    Some(match error.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EACCES",
        AlreadyExists => "EEXIST",
        ConnectionReset => "ECONNRESET",
        ConnectionAborted => "ECONNABORTED",
        ConnectionRefused => "ECONNREFUSED",
        BrokenPipe => "EPIPE",
        TimedOut => "ETIMEDOUT",
        InvalidInput => "EINVAL",
        Unsupported => "ENOTSUP",
        StorageFull => "ENOSPC",
        ReadOnlyFilesystem => "EROFS",
        FileTooLarge => "EFBIG",
        ResourceBusy => "EBUSY",
        StaleNetworkFileHandle => "ESTALE",
        IsADirectory => "EISDIR",
        CrossesDevices => "EXDEV",
        TooManyLinks => "EMLINK",
        NotConnected => "ENOTCONN",
        HostUnreachable => "EHOSTUNREACH",
        NetworkUnreachable => "ENETUNREACH",
        NetworkDown => "ENETDOWN",
        QuotaExceeded => "EDQUOT",
        WriteZero => "EIO",
        UnexpectedEof => "EIO",
        _ => return None,
    })
}

#[cfg(unix)]
fn os_code(raw: i32) -> Option<&'static str> {
    #[allow(unreachable_patterns)]
    Some(match raw {
        libc::ENOENT => "ENOENT",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EROFS => "EROFS",
        libc::ENOSPC => "ENOSPC",
        libc::EDQUOT => "EDQUOT",
        libc::EFBIG => "EFBIG",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::EMLINK => "EMLINK",
        libc::ENOTSUP => "ENOTSUP",
        libc::EOPNOTSUPP => "EOPNOTSUPP",
        libc::ENOSYS => "ENOSYS",
        libc::EINVAL => "EINVAL",
        libc::EISDIR => "EISDIR",
        libc::ENOTDIR => "ENOTDIR",
        libc::EIO => "EIO",
        libc::ENXIO => "ENXIO",
        libc::ENODEV => "ENODEV",
        libc::ESTALE => "ESTALE",
        libc::ENOTCONN => "ENOTCONN",
        libc::ENETUNREACH => "ENETUNREACH",
        libc::ENETDOWN => "ENETDOWN",
        libc::EHOSTUNREACH => "EHOSTUNREACH",
        libc::EHOSTDOWN => "EHOSTDOWN",
        libc::ECONNRESET => "ECONNRESET",
        libc::ECONNABORTED => "ECONNABORTED",
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::EPIPE => "EPIPE",
        libc::EBADF => "EBADF",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::EAGAIN => "EAGAIN",
        #[cfg(target_os = "linux")]
        libc::ENOMEDIUM => "ENOMEDIUM",
        _ => return None,
    })
}

/// Windows error codes as libuv maps them (uv_translate_sys_error)
#[cfg(windows)]
fn os_code(raw: i32) -> Option<&'static str> {
    Some(match raw as u32 {
        2 | 3 | 15 | 53 | 67 | 161 | 1392 => "ENOENT", // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, BAD_NETPATH, BAD_NET_NAME, BAD_PATHNAME, FILE_CORRUPT
        5 => "EPERM",                                 // ACCESS_DENIED
        6 => "EBADF",                                 // INVALID_HANDLE
        19 => "EROFS",                                // WRITE_PROTECT
        21 => "EAGAIN",                               // NOT_READY
        23 | 1117 => "EIO",                           // CRC, IO_DEVICE
        32 | 33 => "EBUSY",                           // SHARING_VIOLATION, LOCK_VIOLATION
        39 | 112 => "ENOSPC",                         // HANDLE_DISK_FULL, DISK_FULL
        50 => "ENOTSUP",                              // NOT_SUPPORTED
        51 | 1231 => "ENETUNREACH",                   // REM_NOT_LIST, NETWORK_UNREACHABLE
        55 => "ENODEV",                               // DEV_NOT_EXIST
        59 | 64 => "ECONNRESET",                      // UNEXP_NET_ERR, NETNAME_DELETED
        1 => "EISDIR",                                // INVALID_FUNCTION (FAT/exFAT links)
        17 => "EXDEV",                                // NOT_SAME_DEVICE
        80 | 183 => "EEXIST",                         // FILE_EXISTS, ALREADY_EXISTS
        87 => "EINVAL",                               // INVALID_PARAMETER
        111 | 206 => "ENAMETOOLONG",                  // BUFFER_OVERFLOW, FILENAME_EXCED_RANGE
        121 => "ETIMEDOUT",                           // SEM_TIMEOUT
        123 => "EINVAL",                              // INVALID_NAME
        142 | 170 => "EBUSY",                         // BUSY_DRIVE, BUSY
        145 => "ENOTEMPTY",                           // DIR_NOT_EMPTY
        267 => "ENOTDIR",                             // DIRECTORY
        1142 => "EMLINK",                             // TOO_MANY_LINKS
        1224 => "EBUSY",                              // USER_MAPPED_FILE
        1236 => "ECONNABORTED",                       // CONNECTION_ABORTED
        1450 | 1453 => "ENOSPC",                      // NO_SYSTEM_RESOURCES, WORKING_SET_QUOTA
        4390 => "EINVAL",                             // NOT_A_REPARSE_POINT
        10054 => "ECONNRESET",
        10053 => "ECONNABORTED",
        10060 => "ETIMEDOUT",
        10061 => "ECONNREFUSED",
        10065 => "EHOSTUNREACH",
        10051 => "ENETUNREACH",
        10050 => "ENETDOWN",
        _ => return None,
    })
}

#[cfg(not(any(unix, windows)))]
fn os_code(_raw: i32) -> Option<&'static str> {
    None
}

const NETWORK_CODES: &[&str] = &[
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENETDOWN",
];

/// The folder went away (a share, a disk unplugged), not a problem of one
/// file. Windows reports a dropped share as ECONNRESET (NETNAME_DELETED),
/// ETIMEDOUT (SEM_TIMEOUT) or UNKNOWN; a removed disk as EIO, ENXIO or ENODEV.
pub const FOLDER_GONE_CODES: &[&str] = &[
    "ENOENT",
    "EIO",
    "ENXIO",
    "ENODEV",
    "ENOMEDIUM",
    "ESTALE",
    "ENOTCONN",
    "ENETUNREACH",
    "ENETDOWN",
    "EHOSTUNREACH",
    "EHOSTDOWN",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EBADF",
    "EAGAIN",
    "UNKNOWN",
];

pub const NOT_WRITABLE_CODES: &[&str] = &["EACCES", "EPERM", "EROFS"];

impl Error {
    /// The POSIX code of a file system or socket error under it
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Error::Io(error) | Error::Disk(error) | Error::InUse { source: error, .. } => {
                Some(io_code(error).unwrap_or("UNKNOWN"))
            }
            _ => None,
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.code() == Some("ENOENT")
    }

    /// Connection problems with On Page or the storage
    pub fn is_network(&self) -> bool {
        match self {
            Error::Network(_) => true,
            Error::Io(error) => io_code(error).is_some_and(|code| NETWORK_CODES.contains(&code)),
            _ => false,
        }
    }

    /// Worth another attempt
    pub fn is_retryable(&self) -> bool {
        match self {
            Error::Aborted | Error::Conflict(_) => false,
            Error::Timeout(_) | Error::SizeMismatch { .. } => true,
            Error::Http { status, .. } => *status == 408 || *status == 429 || *status >= 500,
            _ => self.is_network(),
        }
    }

    /// Disk full: there is no point in going on
    pub fn is_disk_full(&self) -> bool {
        matches!(self.code(), Some("ENOSPC" | "EDQUOT"))
    }

    pub fn is_aborted(&self) -> bool {
        matches!(self, Error::Aborted)
    }

    /// Short technical detail for logs and the failed list
    pub fn detail(&self) -> String {
        match self {
            Error::Http { status, .. } => format!("HTTP {status}"),
            Error::Job(error) => error.detail.clone().unwrap_or_else(|| error.message.clone()),
            _ => {
                let message = self.to_string();
                match self.code() {
                    Some(code) if !message.contains(code) => format!("{code}: {message}"),
                    _ => message,
                }
            }
        }
    }

    /// What the failed list and the activity say about a file
    pub fn failure_code(&self) -> FailureCode {
        match self {
            Error::Aborted => FailureCode::Aborted,
            Error::Conflict(_) => FailureCode::NameConflict,
            Error::InUse { .. } => FailureCode::InUse,
            _ if self.code() == Some("EFBIG") => FailureCode::FileTooLarge,
            Error::Timeout(_) => FailureCode::Timeout,
            Error::SizeMismatch { .. } => FailureCode::SizeMismatch,
            Error::Http { status, .. } => match status {
                404 | 410 => FailureCode::NotFound,
                429 => FailureCode::RateLimited,
                _ => FailureCode::HttpError,
            },
            _ if self.is_disk_full() => FailureCode::DiskFull,
            _ if self.is_network() => FailureCode::Network,
            _ => FailureCode::WriteError,
        }
    }

    /// A file system error as the end of a job: disk full, read-only, gone
    pub fn folder_job_error(&self) -> Option<JobError> {
        if let Error::Job(error) = self {
            return Some(error.clone());
        }
        let detail = self.detail();
        if self.is_disk_full() {
            return Some(JobError::with_detail(IssueCode::DiskFull, "The disk is full", detail));
        }
        let code = self.code()?;
        if NOT_WRITABLE_CODES.contains(&code) {
            return Some(JobError::with_detail(IssueCode::FolderNotWritable, "The folder cannot be written", detail));
        }
        if FOLDER_GONE_CODES.contains(&code) {
            return Some(JobError::with_detail(IssueCode::FolderUnreachable, "The folder cannot be reached", detail));
        }
        None
    }

    /// Ends the job with this error if it is a folder's, as it is otherwise
    pub fn into_job_error(self) -> Error {
        match self.folder_job_error() {
            Some(error) => Error::Job(error),
            None => self,
        }
    }
}

/// A file system error of a download's disk work
pub fn on_disk(error: io::Error) -> Error {
    Error::Disk(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_of_common_errors() {
        let gone = Error::Io(io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(gone.code(), Some("ENOENT"));
        assert!(gone.is_not_found());
        assert_eq!(gone.folder_job_error().unwrap().issue, IssueCode::FolderUnreachable);
        let full = Error::Disk(io::Error::from(io::ErrorKind::StorageFull));
        assert!(full.is_disk_full());
        assert_eq!(full.failure_code(), FailureCode::DiskFull);
        assert!(!full.is_network());
    }

    #[test]
    fn retry_decisions() {
        assert!(Error::Http { status: 429, retry_after: None }.is_retryable());
        assert!(Error::Http { status: 502, retry_after: None }.is_retryable());
        assert!(!Error::Http { status: 404, retry_after: None }.is_retryable());
        assert!(Error::Timeout(TimeoutStage::Idle).is_retryable());
        assert!(Error::Network("reset".into()).is_retryable());
        assert!(!Error::Aborted.is_retryable());
        // A share's socket error on a write is the folder's, never retried as the network's
        assert!(!Error::Disk(io::Error::from(io::ErrorKind::ConnectionReset)).is_retryable());
    }

    #[test]
    fn failure_codes() {
        assert_eq!(Error::Http { status: 410, retry_after: None }.failure_code(), FailureCode::NotFound);
        assert_eq!(Error::Http { status: 429, retry_after: None }.failure_code(), FailureCode::RateLimited);
        assert_eq!(Error::Conflict("a".into()).failure_code(), FailureCode::NameConflict);
        assert_eq!(Error::Disk(io::Error::from(io::ErrorKind::FileTooLarge)).failure_code(), FailureCode::FileTooLarge);
    }
}
