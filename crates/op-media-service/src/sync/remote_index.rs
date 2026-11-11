//! What the listing found on On Page, and its cache on the local disk
//! (`<cache_dir>/<project>.json.gz`) for incremental listings.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::fsx::atomic_write;

/// A file of a thing, in field, lang and value order
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "FileTuple", into = "FileTuple")]
pub struct RemoteFile {
    pub field_id: i64,
    pub lang: Option<String>,
    /// The name on On Page
    pub name: String,
    pub token: String,
    pub size: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

/// `[field_id, lang | null, remote name, token, size | null, width | null, height | null]`: the
/// compact form of the cache, as 2.0 wrote it
type FileTuple = (i64, Option<String>, String, String, Option<u64>, Option<u64>, Option<u64>);

impl From<FileTuple> for RemoteFile {
    fn from((field_id, lang, name, token, size, width, height): FileTuple) -> Self {
        RemoteFile { field_id, lang, name, token, size, width, height }
    }
}

impl From<RemoteFile> for FileTuple {
    fn from(f: RemoteFile) -> Self {
        (f.field_id, f.lang, f.name, f.token, f.size, f.width, f.height)
    }
}

#[derive(Debug, Clone, Default)]
pub struct RemoteResource {
    pub id: i64,
    /// Thing id → its files, things in id order
    pub things: BTreeMap<i64, Vec<RemoteFile>>,
}

#[derive(Debug, Clone, Default)]
pub struct RemoteIndex {
    pub schema_id: i64,
    pub signature: String,
    /// Server time when the last complete listing started (ISO)
    pub checkpoint: String,
    /// Resources with media fields, in schema order
    pub resources: Vec<RemoteResource>,
}

impl RemoteIndex {
    pub fn file_count(&self) -> usize {
        self.resources.iter().flat_map(|r| r.things.values()).map(Vec::len).sum()
    }
}

#[derive(Serialize, Deserialize)]
struct CacheResource {
    id: i64,
    things: Vec<(i64, Vec<RemoteFile>)>,
}

#[derive(Serialize, Deserialize)]
struct CacheJson {
    version: u32,
    schema_id: i64,
    signature: String,
    checkpoint: String,
    #[serde(default)]
    written_at: String,
    resources: Vec<CacheResource>,
}

/// The cache, when there is a readable one: a broken cache only costs a full listing
pub async fn read_index_cache(file: &Path) -> Option<RemoteIndex> {
    let raw = tokio::fs::read(file).await.ok()?;
    tokio::task::spawn_blocking(move || {
        let mut text = Vec::new();
        GzDecoder::new(&raw[..]).read_to_end(&mut text).ok()?;
        let json: CacheJson = serde_json::from_slice(&text).ok()?;
        if json.version != 1 {
            return None;
        }
        Some(RemoteIndex {
            schema_id: json.schema_id,
            signature: json.signature,
            checkpoint: json.checkpoint,
            resources: json
                .resources
                .into_iter()
                .map(|r| RemoteResource { id: r.id, things: r.things.into_iter().collect() })
                .collect(),
        })
    })
    .await
    .ok()
    .flatten()
}

pub async fn write_index_cache(file: &Path, index: &RemoteIndex) -> Result<()> {
    let json = CacheJson {
        version: 1,
        schema_id: index.schema_id,
        signature: index.signature.clone(),
        checkpoint: index.checkpoint.clone(),
        written_at: crate::models::now_iso(),
        resources: index
            .resources
            .iter()
            .map(|r| CacheResource { id: r.id, things: r.things.iter().map(|(id, f)| (*id, f.clone())).collect() })
            .collect(),
    };
    let data = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let text = serde_json::to_vec(&json)?;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&text)?;
        encoder.finish()
    })
    .await
    .map_err(|e| crate::error::Error::Other(e.to_string()))??;
    atomic_write(file, &data, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_cache_reads_back_what_was_written() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("p.json.gz");
        let index = RemoteIndex {
            schema_id: 7,
            signature: "sig".into(),
            checkpoint: "2026-01-01T00:00:00.000Z".into(),
            resources: vec![RemoteResource {
                id: 1,
                things: BTreeMap::from([(
                    3,
                    vec![RemoteFile {
                        field_id: 9,
                        lang: Some("it".into()),
                        name: "a.jpg".into(),
                        token: "t".into(),
                        size: Some(5),
                        width: None,
                        height: Some(2),
                    }],
                )]),
            }],
        };
        write_index_cache(&file, &index).await.unwrap();
        let back = read_index_cache(&file).await.unwrap();
        assert_eq!(back.schema_id, 7);
        assert_eq!(back.resources[0].things[&3], index.resources[0].things[&3]);
        std::fs::write(&file, b"broken").unwrap();
        assert!(read_index_cache(&file).await.is_none());
    }
}
