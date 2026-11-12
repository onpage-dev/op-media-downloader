//! `opmd` on the user's PATH, on Windows: the installer runs `opmd path add
//! DIR` once the files are copied, and `opmd path remove DIR` before it
//! removes them (src-tauri/windows/hooks.nsh). The PATH of the user
//! (HKCU\Environment) is edited here, with no limit on its length and its
//! other entries left as they are; the programs that are open hear of it, a
//! new terminal finds `opmd`. macOS and Linux need none of this: the .deb
//! installs it in /usr/bin, the app's settings show the link for macOS.

/// The PATH with `dir` at its end; None when it is there already
pub fn with_dir(path: &str, dir: &str) -> Option<String> {
    if path.split(';').any(|entry| same(entry, dir)) {
        return None;
    }
    let kept = path.trim_end_matches(';');
    Some(if kept.trim().is_empty() { dir.to_string() } else { format!("{kept};{dir}") })
}

/// The PATH without `dir` (every copy of it); None when it is not there
pub fn without_dir(path: &str, dir: &str) -> Option<String> {
    if !path.split(';').any(|entry| same(entry, dir)) {
        return None;
    }
    Some(path.split(';').filter(|entry| !same(entry, dir)).collect::<Vec<_>>().join(";"))
}

/// One folder, however it is written: any case, quoted, with or without the last separator
fn same(entry: &str, dir: &str) -> bool {
    let plain = |text: &str| text.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_lowercase();
    !entry.trim().is_empty() && plain(entry) == plain(dir)
}

#[cfg(windows)]
pub use registry::{add, remove};

#[cfg(windows)]
mod registry {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE, RegCloseKey,
        RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };

    use super::{with_dir, without_dir};

    /// The user's environment, where their PATH is
    const ENVIRONMENT: &str = "Environment";

    /// Adds `dir` to the user's PATH; false when it was there already
    pub fn add(dir: &str) -> Result<bool, String> {
        change(ENVIRONMENT, true, |path| with_dir(path, dir))
    }

    /// Takes `dir` off the user's PATH; false when it was not there
    pub fn remove(dir: &str) -> Result<bool, String> {
        change(ENVIRONMENT, true, |path| without_dir(path, dir))
    }

    /// The PATH value of `subkey` (of the current user) changed by `edit`;
    /// `announce`: the open programs are told the environment changed
    pub fn change(subkey: &str, announce: bool, edit: impl Fn(&str) -> Option<String>) -> Result<bool, String> {
        let key = Key::open(subkey)?;
        let (current, kind) = key.read("Path")?.unwrap_or((String::new(), REG_EXPAND_SZ));
        let Some(next) = edit(&current) else { return Ok(false) };
        if next.trim().is_empty() {
            key.delete("Path")?
        } else {
            key.write("Path", &next, kind)?
        }
        if announce {
            let environment = wide("Environment");
            let mut result = 0usize;
            // SAFETY: a broadcast with a NUL-terminated string that outlives the call, 5 s at most per window
            unsafe {
                SendMessageTimeoutW(
                    HWND_BROADCAST,
                    WM_SETTINGCHANGE,
                    0,
                    environment.as_ptr() as isize,
                    SMTO_ABORTIFHUNG,
                    5000,
                    &mut result,
                );
            }
        }
        Ok(true)
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// An open key of the current user, closed when dropped
    pub struct Key(HKEY);

    impl Key {
        pub fn open(subkey: &str) -> Result<Key, String> {
            let mut key: HKEY = null_mut();
            // SAFETY: a NUL-terminated name, and a place for the handle
            let status =
                unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(subkey).as_ptr(), 0, KEY_READ | KEY_WRITE, &mut key) };
            if status != ERROR_SUCCESS {
                return Err(format!("cannot open HKCU\\{subkey} ({status})"));
            }
            Ok(Key(key))
        }

        /// A text value and its type; None when there is none
        pub fn read(&self, name: &str) -> Result<Option<(String, REG_VALUE_TYPE)>, String> {
            let name = wide(name);
            let mut kind: REG_VALUE_TYPE = 0;
            let mut size: u32 = 0;
            // SAFETY: asks for the size only
            let status = unsafe { RegQueryValueExW(self.0, name.as_ptr(), null(), &mut kind, null_mut(), &mut size) };
            if status == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            if status != ERROR_SUCCESS {
                return Err(format!("cannot read the PATH ({status})"));
            }
            if kind != REG_SZ && kind != REG_EXPAND_SZ {
                return Err(format!("the PATH is not text (type {kind})"));
            }
            let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
            let mut bytes = (buffer.len() * 2) as u32;
            // SAFETY: a buffer of `bytes` bytes
            let status = unsafe {
                RegQueryValueExW(self.0, name.as_ptr(), null(), &mut kind, buffer.as_mut_ptr().cast(), &mut bytes)
            };
            if status != ERROR_SUCCESS {
                return Err(format!("cannot read the PATH ({status})"));
            }
            buffer.truncate(bytes as usize / 2);
            while buffer.last() == Some(&0) {
                buffer.pop();
            }
            Ok(Some((String::from_utf16_lossy(&buffer), kind)))
        }

        pub fn write(&self, name: &str, value: &str, kind: REG_VALUE_TYPE) -> Result<(), String> {
            let data = wide(value);
            // SAFETY: a NUL-terminated UTF-16 string of `data.len() * 2` bytes
            let status = unsafe {
                RegSetValueExW(self.0, wide(name).as_ptr(), 0, kind, data.as_ptr().cast(), (data.len() * 2) as u32)
            };
            if status != ERROR_SUCCESS { Err(format!("cannot write the PATH ({status})")) } else { Ok(()) }
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            // SAFETY: a NUL-terminated name
            let status = unsafe { RegDeleteValueW(self.0, wide(name).as_ptr()) };
            if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
                return Err(format!("cannot write the PATH ({status})"));
            }
            Ok(())
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: a key this value opened
            unsafe { RegCloseKey(self.0) };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::System::Registry::{REG_OPTION_NON_VOLATILE, RegCreateKeyExW, RegDeleteTreeW};

        /// A key of its own under HKCU\Software, removed at the end: the user's PATH is never touched
        #[test]
        fn the_path_value_changes_and_keeps_its_type() {
            let root = format!("Software\\OnPageMediaDownloaderTest{}", std::process::id());
            let subkey = format!("{root}\\Environment");
            let mut key: HKEY = null_mut();
            // SAFETY: creates the test key
            let status = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    wide(&subkey).as_ptr(),
                    0,
                    null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_READ | KEY_WRITE,
                    null(),
                    &mut key,
                    null_mut(),
                )
            };
            assert_eq!(status, ERROR_SUCCESS);
            drop(Key(key));

            let long = format!("%USERPROFILE%\\bin;{}", "C:\\a-long-folder".repeat(120));
            Key::open(&subkey).unwrap().write("Path", &long, REG_EXPAND_SZ).unwrap();
            let dir = "C:\\Users\\Me\\AppData\\Local\\On Page Media Downloader";
            assert!(change(&subkey, false, |path| with_dir(path, dir)).unwrap());
            assert!(!change(&subkey, false, |path| with_dir(path, &format!("{dir}\\"))).unwrap());
            let (path, kind) = Key::open(&subkey).unwrap().read("Path").unwrap().unwrap();
            assert_eq!((path, kind), (format!("{long};{dir}"), REG_EXPAND_SZ));

            assert!(change(&subkey, false, |path| without_dir(path, dir)).unwrap());
            assert_eq!(Key::open(&subkey).unwrap().read("Path").unwrap().unwrap().0, long);
            // Only our folder: the value goes with it
            Key::open(&subkey).unwrap().write("Path", dir, REG_SZ).unwrap();
            assert!(change(&subkey, false, |path| without_dir(path, dir)).unwrap());
            assert!(Key::open(&subkey).unwrap().read("Path").unwrap().is_none());

            // SAFETY: removes the test key
            unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(&root).as_ptr()) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_goes_on_once_and_comes_off_alone() {
        let dir = r"C:\Users\Me\AppData\Local\On Page Media Downloader";
        assert_eq!(with_dir("", dir).unwrap(), dir);
        assert_eq!(with_dir(r"C:\bin;", dir).unwrap(), format!(r"C:\bin;{dir}"));
        assert!(with_dir(&format!(r"C:\bin;{}\", dir.to_uppercase()), dir).is_none());
        assert!(with_dir(&format!("\"{dir}\";C:\\bin"), dir).is_none());

        let path = format!(r"C:\bin;{dir};%USERPROFILE%\tools;;{dir}\");
        assert_eq!(without_dir(&path, dir).unwrap(), r"C:\bin;%USERPROFILE%\tools;");
        assert!(without_dir(r"C:\bin", dir).is_none());
        // A folder that only begins like ours stays
        assert!(without_dir(&format!("{dir} 2"), dir).is_none());
    }
}
