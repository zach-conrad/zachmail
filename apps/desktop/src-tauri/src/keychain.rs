//! Supabase session storage in the macOS login Keychain (architecture §7).

#[cfg(target_os = "macos")]
mod imp {
    use security_framework::passwords;

    const SERVICE: &str = "dev.zachconrad.mail";
    const NOT_FOUND: i32 = -25300; // errSecItemNotFound

    pub fn get(key: &str) -> Result<Option<String>, String> {
        match passwords::get_generic_password(SERVICE, key) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|e| e.to_string()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(key: &str, value: &str) -> Result<(), String> {
        passwords::set_generic_password(SERVICE, key, value.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn delete(key: &str) -> Result<(), String> {
        match passwords::delete_generic_password(SERVICE, key) {
            Err(e) if e.code() != NOT_FOUND => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Err("Keychain is only available on macOS".into())
    }
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("Keychain is only available on macOS".into())
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Err("Keychain is only available on macOS".into())
    }
}

pub use imp::{delete, get, set};
