//! Looks for a newer release on GitHub. `releases/latest` is never a draft
//! nor a prerelease, so betas are never offered.

use std::time::Duration;

use parking_lot::Mutex;

use crate::models::VersionInfo;
use crate::warn;

const LATEST_RELEASE: &str = "https://api.github.com/repos/onpage-dev/op-media-downloader/releases/latest";

pub struct Updates {
    info: Mutex<VersionInfo>,
}

#[derive(serde::Deserialize)]
struct Release {
    tag_name: Option<String>,
    html_url: Option<String>,
}

impl Updates {
    pub fn new(current: &str) -> Updates {
        Updates { info: Mutex::new(VersionInfo { current: current.to_string(), ..Default::default() }) }
    }

    pub fn info(&self) -> VersionInfo {
        self.info.lock().clone()
    }

    pub async fn check(&self) -> VersionInfo {
        let current = self.info.lock().current.clone();
        let next = match latest().await {
            Ok(release) => {
                let latest = release.tag_name.map(|tag| tag.trim_start_matches(['v', 'V']).to_string());
                VersionInfo {
                    latest: latest.filter(|latest| is_newer(latest, &current)),
                    release_url: release.html_url,
                    checked_at: Some(op_media_service::now_iso()),
                    check_failed: None,
                    current,
                }
            }
            Err(error) => {
                warn!("Update check failed: {error}");
                VersionInfo { checked_at: Some(op_media_service::now_iso()), check_failed: Some(true), ..self.info() }
            }
        };
        *self.info.lock() = next.clone();
        next
    }
}

async fn latest() -> Result<Release, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("op-media-downloader/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(LATEST_RELEASE)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status().as_u16()));
    }
    response.json::<Release>().await.map_err(|e| e.to_string())
}

/// Semantic comparison of `x.y.z` versions; anything unparsable is not newer
pub fn is_newer(candidate: &str, current: &str) -> bool {
    fn parse(version: &str) -> Option<[u64; 3]> {
        let re = regex::Regex::new(r"^(\d+)\.(\d+)\.(\d+)").ok()?;
        let captures = re.captures(version)?;
        Some([captures[1].parse().ok()?, captures[2].parse().ok()?, captures[3].parse().ok()?])
    }
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn versions() {
        assert!(is_newer("3.0.1", "3.0.0"));
        assert!(is_newer("10.0.0", "9.9.9"));
        assert!(!is_newer("3.0.0", "3.0.0"));
        assert!(!is_newer("2.9.9", "3.0.0"));
        assert!(!is_newer("latest", "3.0.0"));
    }
}
