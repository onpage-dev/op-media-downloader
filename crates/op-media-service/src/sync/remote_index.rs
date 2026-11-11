//! What the listing found on On Page, and its cache on the local disk
//! (`<cache_dir>/<project>.json.gz`) for incremental listings.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize, Serializer};

use crate::error::Result;
use crate::fsx::replace_file;

/// A file of a thing, in field, lang and value order
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(from = "FileTuple")]
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

/// Written as the tuple, without copying the strings (200k files make a cache)
impl Serialize for RemoteFile {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        (self.field_id, &self.lang, &self.name, &self.token, self.size, self.width, self.height).serialize(serializer)
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

#[derive(Deserialize)]
struct CacheResource {
    id: i64,
    things: Vec<(i64, Vec<RemoteFile>)>,
}

#[derive(Deserialize)]
struct CacheJson {
    version: u32,
    schema_id: i64,
    signature: String,
    checkpoint: String,
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

/// The things of a resource as `[[id, [files…]], …]`, straight from the index
struct ThingsOut<'a>(&'a BTreeMap<i64, Vec<RemoteFile>>);

impl Serialize for ThingsOut<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter())
    }
}

#[derive(Serialize)]
struct ResourceOut<'a> {
    id: i64,
    things: ThingsOut<'a>,
}

#[derive(Serialize)]
struct CacheOut<'a> {
    version: u32,
    schema_id: i64,
    signature: &'a str,
    checkpoint: &'a str,
    written_at: String,
    resources: Vec<ResourceOut<'a>>,
}

/// Written on a blocking thread, from the index as it is (no copy), quickly compressed
pub async fn write_index_cache(file: &Path, index: Arc<RemoteIndex>) -> Result<()> {
    let data = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let json = CacheOut {
            version: 1,
            schema_id: index.schema_id,
            signature: &index.signature,
            checkpoint: &index.checkpoint,
            written_at: crate::models::now_iso(),
            resources: index.resources.iter().map(|r| ResourceOut { id: r.id, things: ThingsOut(&r.things) }).collect(),
        };
        let mut encoder = GzEncoder::new(Vec::with_capacity(1 << 20), Compression::fast());
        serde_json::to_writer(&mut encoder, &json)?;
        encoder.finish()
    })
    .await
    .map_err(|e| crate::error::Error::Other(e.to_string()))??;
    replace_file(file, &data).await
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
        write_index_cache(&file, Arc::new(index.clone())).await.unwrap();
        let back = read_index_cache(&file).await.unwrap();
        assert_eq!(back.schema_id, 7);
        assert_eq!(back.resources[0].things[&3], index.resources[0].things[&3]);
        std::fs::write(&file, b"broken").unwrap();
        assert!(read_index_cache(&file).await.is_none());
    }
}
