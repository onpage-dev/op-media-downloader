//! From the remote index to the names the folder must contain: safe names,
//! case-insensitive uniqueness with a deterministic winner, duplicate groups.

use std::collections::{HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;

use super::remote_index::RemoteIndex;

const MAX_NAME_BYTES: usize = 200;
const MAX_EXT_CHARS: usize = 16;

fn forbidden(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 || c == '\u{7f}'
}

fn reserved(stem: &str) -> bool {
    let lower = stem.to_lowercase();
    if matches!(lower.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    let mut chars = lower.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: Vec<char> = chars.collect();
    (prefix == "com" || prefix == "lpt")
        && rest.len() == 1
        && (rest[0].is_ascii_digit() || matches!(rest[0], '¹' | '²' | '³'))
}

fn trim_dots_and_spaces(name: &str) -> &str {
    name.trim_end_matches(['.', ' '])
}

/// A name that is valid on Windows, macOS and Linux and cannot leave the
/// folder: no separators or `..`, no forbidden or control characters, no
/// reserved device names, no trailing dots or spaces, at most 200 UTF-8 bytes
/// keeping the extension. Network shares are often Windows-backed, so the
/// Windows rules apply everywhere.
pub fn sanitize_name(raw: &str) -> String {
    let replaced: String = raw.nfc().map(|c| if forbidden(c) { '_' } else { c }).collect();
    let mut name = trim_dots_and_spaces(&replaced).to_string();
    if name.is_empty() || name == "." || name == ".." {
        name = "_".into();
    }
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name.as_str(),
    };
    if reserved(stem.split('.').next().unwrap_or("").trim()) {
        name = format!("_{name}");
    }
    // The folder of the app's own files
    if name.to_lowercase() == "data" {
        name = format!("_{name}");
    }
    truncate(name)
}

fn truncate(name: String) -> String {
    if name.len() <= MAX_NAME_BYTES {
        return name;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 && name[dot + 1..].chars().count() <= MAX_EXT_CHARS => (&name[..dot], &name[dot..]),
        _ => (name.as_str(), ""),
    };
    let mut stem: Vec<char> = stem.chars().collect();
    while !stem.is_empty() && stem.iter().map(|c| c.len_utf8()).sum::<usize>() + ext.len() > MAX_NAME_BYTES {
        stem.pop();
    }
    let stem: String = stem.into_iter().collect();
    let stem = trim_dots_and_spaces(&stem);
    format!("{}{ext}", if stem.is_empty() { "_" } else { stem })
}

/// Case-insensitive identity of a name (Windows and macOS folders ignore case)
pub fn name_key(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

pub fn nfc(name: &str) -> String {
    name.nfc().collect()
}

/// The same name as on disk: macOS disks in HFS+ give names back decomposed (NFD)
pub fn same_name(on_disk: &str, name: &str) -> bool {
    on_disk == name || nfc(on_disk) == nfc(name)
}

/// Tokens become file names in data/: they must be plain
pub fn is_safe_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.is_empty() || bytes.len() > 201 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !token.contains("..")
        && !token.ends_with(".download")
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct FileUse {
    pub resource_id: i64,
    pub thing_id: i64,
    pub field_id: i64,
    pub lang: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DesiredFile {
    pub key: String,
    /// Name in the folder (safe)
    pub local_name: String,
    /// Name on On Page
    pub remote_name: String,
    pub token: String,
    pub size: Option<u64>,
    pub use_: FileUse,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DuplicateVariantRaw {
    pub token: String,
    pub remote_name: String,
    pub size: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub chosen: bool,
    pub uses: Vec<FileUse>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DuplicateRaw {
    pub key: String,
    /// The name of the chosen variant
    pub name: String,
    pub variants: Vec<DuplicateVariantRaw>,
}

#[derive(Debug, Clone)]
pub struct InvalidFile {
    pub remote_name: String,
    pub token: String,
    pub use_: FileUse,
}

#[derive(Debug, Clone, Default)]
pub struct ResolvedNames {
    pub desired: Vec<DesiredFile>,
    /// Shared with the duplicates tab, which keeps them longer than the names
    pub duplicates: std::sync::Arc<Vec<DuplicateRaw>>,
    /// Files whose token cannot be stored safely
    pub invalid: Vec<InvalidFile>,
    /// Of the duplicates: names whose files are one field of one item in
    /// different languages (a datasheet translated under the same name)
    pub language_variants: u64,
}

/// A duplicate group while names are resolved
struct GroupWork {
    group: DuplicateRaw,
    variants: HashMap<String, usize>,
    /// The uses of the chosen variant
    chosen_uses: HashSet<FileUse>,
}

/// Walks the index in a fixed order (resources and fields as in the schema,
/// things by id, langs as in the schema, files as in the value) so the same
/// remote content always gives the same winner for a name.
pub fn resolve_names(index: &RemoteIndex) -> ResolvedNames {
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<GroupWork> = Vec::new();
    let mut group_of: HashMap<String, usize> = HashMap::new();
    let mut desired: Vec<DesiredFile> = Vec::new();
    let mut invalid = Vec::new();

    for resource in &index.resources {
        // BTreeMap: things by id
        for (&thing_id, files) in &resource.things {
            for file in files {
                let use_ =
                    FileUse { resource_id: resource.id, thing_id, field_id: file.field_id, lang: file.lang.clone() };
                if !is_safe_token(&file.token) {
                    invalid.push(InvalidFile { remote_name: file.name.clone(), token: file.token.clone(), use_ });
                    continue;
                }
                let local_name = sanitize_name(&file.name);
                let key = name_key(&local_name);
                let Some(&winner_index) = by_key.get(&key) else {
                    by_key.insert(key.clone(), desired.len());
                    desired.push(DesiredFile {
                        key,
                        local_name,
                        remote_name: file.name.clone(),
                        token: file.token.clone(),
                        size: file.size,
                        use_,
                    });
                    continue;
                };
                let winner = &desired[winner_index];
                if winner.token == file.token {
                    continue;
                }
                let work_index = *group_of.entry(key.clone()).or_insert_with(|| {
                    let chosen = DuplicateVariantRaw {
                        token: winner.token.clone(),
                        remote_name: winner.remote_name.clone(),
                        size: winner.size,
                        width: None,
                        height: None,
                        chosen: true,
                        uses: vec![winner.use_.clone()],
                    };
                    groups.push(GroupWork {
                        group: DuplicateRaw {
                            key: key.clone(),
                            name: winner.local_name.clone(),
                            variants: vec![chosen],
                        },
                        variants: HashMap::from([(winner.token.clone(), 0)]),
                        chosen_uses: HashSet::from([winner.use_.clone()]),
                    });
                    groups.len() - 1
                });
                let work = &mut groups[work_index];
                let variant_index = match work.variants.get(&file.token) {
                    Some(&i) => i,
                    None => {
                        work.group.variants.push(DuplicateVariantRaw {
                            token: file.token.clone(),
                            remote_name: file.name.clone(),
                            size: file.size,
                            width: file.width,
                            height: file.height,
                            chosen: false,
                            uses: Vec::new(),
                        });
                        let i = work.group.variants.len() - 1;
                        work.variants.insert(file.token.clone(), i);
                        i
                    }
                };
                work.group.variants[variant_index].uses.push(use_);
            }
        }
    }

    // Every use of the winning token, for the duplicates view
    if !groups.is_empty() {
        let chosen_tokens: HashSet<String> = groups.iter().map(|w| w.group.variants[0].token.clone()).collect();
        for resource in &index.resources {
            for (&thing_id, files) in &resource.things {
                for file in files {
                    if !chosen_tokens.contains(&file.token) {
                        continue;
                    }
                    let Some(&work_index) = group_of.get(&name_key(&sanitize_name(&file.name))) else {
                        continue;
                    };
                    let work = &mut groups[work_index];
                    let chosen = &mut work.group.variants[0];
                    if chosen.token != file.token {
                        continue;
                    }
                    if file.width.is_some() {
                        chosen.width = file.width;
                    }
                    if file.height.is_some() {
                        chosen.height = file.height;
                    }
                    let use_ = FileUse {
                        resource_id: resource.id,
                        thing_id,
                        field_id: file.field_id,
                        lang: file.lang.clone(),
                    };
                    if work.chosen_uses.insert(use_.clone()) {
                        chosen.uses.push(use_);
                    }
                }
            }
        }
    }

    let duplicates: Vec<DuplicateRaw> = groups.into_iter().map(|w| w.group).collect();
    let language_variants = duplicates.iter().filter(|g| language_variant(g)).count() as u64;
    ResolvedNames { desired, duplicates: std::sync::Arc::new(duplicates), invalid, language_variants }
}

/// resource, thing, field
type FieldOfThing = (i64, i64, i64);

/// The files of the group are one field of one item in different languages
fn language_variant(group: &DuplicateRaw) -> bool {
    let mut at: HashMap<FieldOfThing, Vec<(usize, Option<&str>)>> = HashMap::new();
    for (index, variant) in group.variants.iter().enumerate() {
        for use_ in &variant.uses {
            let others = at.entry((use_.resource_id, use_.thing_id, use_.field_id)).or_default();
            if others.iter().any(|(v, lang)| *v != index && *lang != use_.lang.as_deref()) {
                return true;
            }
            others.push((index, use_.lang.as_deref()));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::remote_index::{RemoteFile, RemoteResource};
    use std::collections::BTreeMap;

    fn file(field_id: i64, lang: Option<&str>, name: &str, token: &str) -> RemoteFile {
        RemoteFile {
            field_id,
            lang: lang.map(str::to_string),
            name: name.into(),
            token: token.into(),
            size: Some(10),
            width: None,
            height: None,
        }
    }

    type Things = Vec<(i64, Vec<RemoteFile>)>;

    fn index(resources: Vec<(i64, Things)>) -> RemoteIndex {
        RemoteIndex {
            schema_id: 1,
            signature: "s".into(),
            checkpoint: crate::models::now_iso(),
            resources: resources
                .into_iter()
                .map(|(id, things)| RemoteResource { id, things: things.into_iter().collect::<BTreeMap<_, _>>() })
                .collect(),
        }
    }

    #[test]
    fn keeps_ordinary_names() {
        assert_eq!(sanitize_name("Prodotto 12 - vista frontale.jpg"), "Prodotto 12 - vista frontale.jpg");
        assert_eq!(sanitize_name("àèìòù ñ 漢字.png"), "àèìòù ñ 漢字.png");
    }

    #[test]
    fn never_lets_a_name_leave_the_folder() {
        assert_eq!(sanitize_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_name("..\\..\\Windows\\win.ini"), ".._.._Windows_win.ini");
        assert_eq!(sanitize_name(".."), "_");
        assert_eq!(sanitize_name("."), "_");
        assert_eq!(sanitize_name(""), "_");
    }

    #[test]
    fn replaces_characters_windows_refuses() {
        assert_eq!(sanitize_name("a<b>c:d\"e|f?g*h.jpg"), "a_b_c_d_e_f_g_h.jpg");
        assert_eq!(sanitize_name("tab\there\u{1}.txt"), "tab_here_.txt");
    }

    #[test]
    fn drops_trailing_dots_and_spaces() {
        assert_eq!(sanitize_name("foto.jpg. . "), "foto.jpg");
        assert_eq!(sanitize_name("cartella..."), "cartella");
    }

    #[test]
    fn avoids_reserved_device_names() {
        assert_eq!(sanitize_name("CON"), "_CON");
        assert_eq!(sanitize_name("con.txt"), "_con.txt");
        assert_eq!(sanitize_name("LPT1.tar.gz"), "_LPT1.tar.gz");
        assert_eq!(sanitize_name("COM10.txt"), "COM10.txt");
        assert_eq!(sanitize_name("console.txt"), "console.txt");
    }

    #[test]
    fn never_takes_the_name_of_the_data_folder() {
        assert_eq!(sanitize_name("data"), "_data");
        assert_eq!(sanitize_name("DATA"), "_DATA");
        assert_eq!(sanitize_name("data.jpg"), "data.jpg");
    }

    #[test]
    fn shortens_long_names_keeping_the_extension() {
        let short = sanitize_name(&format!("{}.jpeg", "x".repeat(400)));
        assert!(short.len() <= 200);
        assert!(short.ends_with(".jpeg"));
        assert!(sanitize_name(&format!("{}.pdf", "è".repeat(300))).len() <= 200);
    }

    #[test]
    fn a_safe_name_stays_the_same() {
        for name in ["a.jpg", "_CON", ".._x", "foto (1).png"] {
            assert_eq!(sanitize_name(&sanitize_name(name)), sanitize_name(name));
        }
    }

    #[test]
    fn accepts_plain_tokens_only() {
        assert!(is_safe_token("3f2a9c"));
        assert!(is_safe_token("3f2a9c.png"));
        assert!(!is_safe_token("../x"));
        assert!(!is_safe_token("a/b"));
        assert!(!is_safe_token(".lock"));
        assert!(!is_safe_token("abc.download"));
        assert!(!is_safe_token(""));
    }

    #[test]
    fn the_first_file_of_a_name_wins_ignoring_case() {
        let resolved = resolve_names(&index(vec![
            (1, vec![(2, vec![file(10, None, "Foto.JPG", "b")]), (1, vec![file(10, None, "foto.jpg", "a")])]),
            (2, vec![(1, vec![file(20, None, "FOTO.jpg", "c"), file(20, None, "foto.jpg", "a")])]),
        ]));
        assert_eq!(resolved.desired.len(), 1);
        assert_eq!(resolved.desired[0].token, "a");
        assert_eq!(resolved.desired[0].local_name, "foto.jpg");
        assert_eq!(resolved.duplicates.len(), 1);
        let group = &resolved.duplicates[0];
        assert_eq!(group.variants.iter().map(|v| v.token.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        // Every use of the chosen file, once each
        assert_eq!(group.variants[0].uses.len(), 2);
    }

    #[test]
    fn one_content_under_two_names_is_no_duplicate() {
        let resolved =
            resolve_names(&index(vec![(1, vec![(1, vec![file(1, None, "a.jpg", "t"), file(2, None, "b.jpg", "t")])])]));
        assert_eq!(resolved.desired.len(), 2);
        assert!(resolved.duplicates.is_empty());
    }

    #[test]
    fn unsafe_tokens_are_set_apart() {
        let resolved = resolve_names(&index(vec![(1, vec![(1, vec![file(1, None, "a.jpg", "../evil")])])]));
        assert!(resolved.desired.is_empty());
        assert_eq!(resolved.invalid.len(), 1);
    }
}
