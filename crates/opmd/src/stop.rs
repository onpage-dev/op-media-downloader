//! The stop asked by the user or by the system: Ctrl+C, SIGTERM (systemd,
//! `docker stop`, a shutdown), and on Windows the console closing or the
//! system shutting down. Heard from the first call of `listen` on (only while
//! jobs run: before, Ctrl+C ends `opmd` at once as usual), by every waiter.

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

static LISTENING: AtomicBool = AtomicBool::new(false);
static STOPPED: AtomicBool = AtomicBool::new(false);
static STOP: Notify = Notify::const_new();

/// Starts listening for the stop (once)
pub fn listen() {
    if LISTENING.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async {
        signal().await;
        STOPPED.store(true, Ordering::SeqCst);
        STOP.notify_waiters();
    });
}

pub fn is_stopped() -> bool {
    STOPPED.load(Ordering::SeqCst)
}

/// Ends when the stop comes; at once when it already came
pub async fn stopped() {
    loop {
        let notified = STOP.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if is_stopped() {
            return;
        }
        notified.await;
    }
}

#[cfg(unix)]
async fn signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let terminate = async {
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                terminate.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate => {}
    }
}

#[cfg(windows)]
async fn signal() {
    use tokio::signal::windows::{ctrl_break, ctrl_close, ctrl_shutdown};
    let close = async {
        match ctrl_close() {
            Ok(mut close) => {
                close.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    let shutdown = async {
        match ctrl_shutdown() {
            Ok(mut shutdown) => {
                shutdown.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    let brk = async {
        match ctrl_break() {
            Ok(mut brk) => {
                brk.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = close => {}
        _ = shutdown => {}
        _ = brk => {}
    }
}

#[cfg(not(any(unix, windows)))]
async fn signal() {
    let _ = tokio::signal::ctrl_c().await;
}
