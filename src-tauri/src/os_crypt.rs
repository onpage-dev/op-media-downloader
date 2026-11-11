//! The tokens the Electron app (2.0) saved with `safeStorage`, read once to
//! move them into the system's credential store. They are Chromium's os_crypt
//! format `v10`:
//!
//! - Windows: AES-256-GCM, the key protected by DPAPI in the `Local State`
//!   file of the Electron app's folder (`os_crypt.encrypted_key`);
//! - macOS: AES-128-CBC, the key derived (PBKDF2-SHA1, `saltysalt`, 1003
//!   rounds) from the password of the Keychain item `<app> Safe Storage`;
//! - Linux: AES-128-CBC with the key of the password `peanuts` (no keyring at
//!   the time); `v11` tokens, under a keyring password, are not read.
//!
//! A token that cannot be read here (another user's or computer's) is left
//! out: the page asks for it again.

use std::path::{Path, PathBuf};

use base64::Engine;
use parking_lot::Mutex;

pub struct SafeStorage {
    /// The Electron app's folder (its `Local State` on Windows)
    #[allow(dead_code)]
    source_dir: PathBuf,
    /// The names the Electron app may have had (its Keychain item on macOS)
    #[allow(dead_code)]
    app_names: Vec<String>,
    /// Read once: None not tried, Some(None) not available
    key: Mutex<Option<Option<Vec<u8>>>>,
}

impl SafeStorage {
    pub fn new(source_dir: &Path, app_names: &[&str]) -> SafeStorage {
        SafeStorage {
            source_dir: source_dir.to_path_buf(),
            app_names: app_names.iter().map(|n| n.to_string()).collect(),
            key: Mutex::new(None),
        }
    }

    /// The token in clear, from `token_enc` (base64)
    pub fn decrypt(&self, token_enc: &str) -> Option<String> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(token_enc.trim())
            .ok()?;
        let body = data.strip_prefix(b"v10")?;
        let key = {
            let mut cached = self.key.lock();
            cached.get_or_insert_with(|| self.load_key()).clone()?
        };
        let plain = decrypt_v10(&key, body)?;
        String::from_utf8(plain)
            .ok()
            .filter(|token| !token.is_empty())
    }

    #[cfg(windows)]
    fn load_key(&self) -> Option<Vec<u8>> {
        let text = std::fs::read_to_string(self.source_dir.join("Local State")).ok()?;
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        let encoded = json.get("os_crypt")?.get("encrypted_key")?.as_str()?;
        let protected = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?;
        let protected = protected.strip_prefix(b"DPAPI")?;
        dpapi_unprotect(protected).filter(|key| key.len() == 32)
    }

    #[cfg(target_os = "macos")]
    fn load_key(&self) -> Option<Vec<u8>> {
        for name in &self.app_names {
            let service = format!("{name} Safe Storage");
            for account in [name.clone(), format!("{name} Key")] {
                if let Ok(password) =
                    security_framework::passwords::get_generic_password(&service, &account)
                {
                    return Some(derive_cbc_key(&password, 1003));
                }
            }
        }
        None
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn load_key(&self) -> Option<Vec<u8>> {
        Some(derive_cbc_key(b"peanuts", 1))
    }
}

#[cfg(windows)]
fn decrypt_v10(key: &[u8], body: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    if body.len() < 12 + 16 {
        return None;
    }
    let (nonce, sealed) = body.split_at(12);
    Aes256Gcm::new_from_slice(key)
        .ok()?
        .decrypt(Nonce::from_slice(nonce), sealed)
        .ok()
}

#[cfg(unix)]
fn decrypt_v10(key: &[u8], body: &[u8]) -> Option<Vec<u8>> {
    use cbc::cipher::block_padding::Pkcs7;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit};
    let iv = [b' '; 16];
    let mut buffer = body.to_vec();
    let decryptor = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &iv).ok()?;
    decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .ok()
        .map(|plain| plain.to_vec())
}

#[cfg(unix)]
fn derive_cbc_key(password: &[u8], rounds: u32) -> Vec<u8> {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", rounds, &mut key);
    key.to_vec()
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input points to `data`, alive for the call; output is allocated by the system and freed below
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return None;
    }
    // SAFETY: the system wrote cbData bytes at pbData
    let key = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: pbData was allocated by CryptUnprotectData with LocalAlloc
    unsafe { LocalFree(output.pbData as _) };
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_of_another_format_are_left_out() {
        let storage = SafeStorage::new(Path::new("/nowhere"), &["On Page Media Downloader"]);
        assert_eq!(storage.decrypt("not base64!"), None);
        assert_eq!(
            storage.decrypt(&base64::engine::general_purpose::STANDARD.encode(b"v11whatever")),
            None
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_v10_with_the_default_password() {
        use cbc::cipher::block_padding::Pkcs7;
        use cbc::cipher::{BlockEncryptMut, KeyIvInit};
        let key = derive_cbc_key(b"peanuts", 1);
        let plain = b"op-token-123";
        let mut buffer = [0u8; 32];
        buffer[..plain.len()].copy_from_slice(plain);
        let sealed = cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, &[b' '; 16])
            .unwrap()
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, plain.len())
            .unwrap()
            .to_vec();
        let mut data = b"v10".to_vec();
        data.extend(sealed);
        let storage = SafeStorage::new(Path::new("/nowhere"), &[]);
        assert_eq!(
            storage
                .decrypt(&base64::engine::general_purpose::STANDARD.encode(data))
                .as_deref(),
            Some("op-token-123")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_v10_with_a_dpapi_key() {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData};
        let key = [7u8; 32];
        let input = CRYPT_INTEGER_BLOB {
            cbData: 32,
            pbData: key.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut output,
            )
        };
        assert_ne!(ok, 0);
        let mut protected = b"DPAPI".to_vec();
        protected.extend_from_slice(unsafe {
            std::slice::from_raw_parts(output.pbData, output.cbData as usize)
        });
        unsafe { LocalFree(output.pbData as _) };
        let dir = tempfile::tempdir().unwrap();
        let state = serde_json::json!({ "os_crypt": { "encrypted_key": base64::engine::general_purpose::STANDARD.encode(protected) } });
        std::fs::write(dir.path().join("Local State"), state.to_string()).unwrap();
        let nonce = [3u8; 12];
        let sealed = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(Nonce::from_slice(&nonce), b"op-token-123".as_ref())
            .unwrap();
        let mut data = b"v10".to_vec();
        data.extend_from_slice(&nonce);
        data.extend(sealed);
        let storage = SafeStorage::new(dir.path(), &[]);
        assert_eq!(
            storage
                .decrypt(&base64::engine::general_purpose::STANDARD.encode(data))
                .as_deref(),
            Some("op-token-123")
        );
    }
}
