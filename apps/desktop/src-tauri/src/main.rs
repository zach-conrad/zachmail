//! ZachMail for macOS: a Tauri 2 shell around the apps/web build. Rust here is glue only
//! (architecture §3): menus, dock badge, notifications, the global compose shortcut, URL
//! handling, Keychain and updates. Everything else is the web app.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keychain;
mod menu;

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const MAIN: &str = "main";
const BRIDGE: &str = include_str!("../../dist/bridge.js");
const FIRST_UPDATE_CHECK: Duration = Duration::from_secs(30);
const UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// URLs (mailto:, zachmail://) that arrive before the page's bridge is listening.
#[derive(Default)]
struct Inbox {
    ready: bool,
    pending: Vec<String>,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn focus(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Runs a keymap command in the web app (see bridge.ts `__zachmailShell`).
pub(crate) fn run_command(app: &AppHandle, id: &str) {
    if let (Some(w), Ok(id)) = (main_window(app), serde_json::to_string(id)) {
        let _ = w.eval(format!("window.__zachmailShell?.command({id})"));
    }
}

fn deliver_url(app: &AppHandle, url: String) {
    focus(app);
    let state = app.state::<Mutex<Inbox>>();
    let mut inbox = state.lock().unwrap();
    if !inbox.ready {
        inbox.pending.push(url);
    } else if let (Some(w), Ok(url)) = (main_window(app), serde_json::to_string(&url)) {
        let _ = w.eval(format!("window.__zachmailShell?.openUrl({url})"));
    }
}

#[tauri::command]
fn bridge_ready(inbox: tauri::State<'_, Mutex<Inbox>>) -> Vec<String> {
    let mut inbox = inbox.lock().unwrap();
    inbox.ready = true;
    std::mem::take(&mut inbox.pending)
}

#[tauri::command]
fn set_unread(window: WebviewWindow, count: i64) {
    let _ = window.set_badge_count((count > 0).then_some(count));
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn open_external(url: String) {
    if is_external(&url) {
        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    }
}

#[tauri::command]
fn secure_get(key: String) -> Result<Option<String>, String> {
    keychain::get(&key)
}

#[tauri::command]
fn secure_set(key: String, value: String) -> Result<(), String> {
    keychain::set(&key, &value)
}

#[tauri::command]
fn secure_delete(key: String) -> Result<(), String> {
    keychain::delete(&key)
}

/// Only web and mail links leave the app; anything else (file:, custom schemes) is dropped.
fn is_external(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")
}

/// The window stays on the bundled app (or the dev server); everything else, including the
/// Google sign-in page, opens in the default browser.
fn stays_in_app(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "blob" | "data" => true,
        "http" | "https" => matches!(url.host_str(), Some("localhost" | "tauri.localhost")),
        _ => false,
    }
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("ZachMail")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(BRIDGE)
        .on_navigation(|url| {
            let keep = stays_in_app(url);
            if !keep && is_external(url.as_str()) {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            keep
        });

    // Design §6.1: hidden title bar with the traffic lights inside the 48px glass header.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .transparent(true);

    let window = builder.build()?;

    // Design §5.6: native material behind the transparent web view. The web app paints solid
    // surfaces for the list and reader, so it only shows through the header and sidebar.
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        );
    }

    Ok(window)
}

async fn check_for_update(app: &AppHandle, manual: bool) -> tauri_plugin_updater::Result<()> {
    let say = |body: &str| {
        let _ = app
            .notification()
            .builder()
            .title("ZachMail")
            .body(body)
            .show();
    };
    match app.updater()?.check().await? {
        Some(update) => {
            update.download_and_install(|_, _| {}, || {}).await?;
            say(&format!(
                "Version {} is installed and opens next launch.",
                update.version
            ));
        }
        None if manual => say("ZachMail is up to date."),
        None => {}
    }
    Ok(())
}

pub(crate) fn check_for_update_now(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check_for_update(&app, true).await {
            let _ = app
                .notification()
                .builder()
                .title("ZachMail")
                .body(format!("Couldn't check for updates: {e}"))
                .show();
        }
    });
}

fn main() {
    let spec = menu::spec();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let spec = menu::spec();
                    let hit = spec.global.iter().find(|g| {
                        g.accelerator
                            .parse::<tauri_plugin_global_shortcut::Shortcut>()
                            .is_ok_and(|s| &s == shortcut)
                    });
                    if let Some(g) = hit {
                        focus(app);
                        run_command(app, &g.command);
                    }
                })
                .build(),
        )
        .manage(Mutex::new(Inbox::default()))
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            bridge_ready,
            set_unread,
            notify,
            open_external,
            secure_get,
            secure_set,
            secure_delete
        ])
        .on_window_event(|window, event| {
            // Closing the window keeps ZachMail running (badge, notifications); ⌘Q quits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            create_window(&handle)?;

            for g in &spec.global {
                if let Err(e) = app.global_shortcut().register(g.accelerator.as_str()) {
                    eprintln!("global shortcut {} unavailable: {e}", g.accelerator);
                }
            }

            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    deliver_url(&handle, url.to_string());
                }
            }
            let h = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    deliver_url(&h, url.to_string());
                }
            });

            // Off the launch path: the first check waits until the inbox is up.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FIRST_UPDATE_CHECK).await;
                loop {
                    let _ = check_for_update(&handle, false).await;
                    tokio::time::sleep(UPDATE_INTERVAL).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build ZachMail");

    app.run(|app, event| {
        // Dock icon click with the window hidden.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            focus(app);
        }
        let _ = (app, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_policy() {
        let ok = |u: &str| stays_in_app(&u.parse().unwrap());
        assert!(ok("tauri://localhost/inbox/important"));
        assert!(ok("http://localhost:5173/"));
        assert!(ok("about:srcdoc"));
        assert!(!ok("https://accounts.google.com/o/oauth2"));
        assert!(!ok("https://localhost.evil.com/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(is_external("mailto:a@b.c"));
        assert!(!is_external("file:///etc/passwd"));
        assert!(!is_external("javascript:alert(1)"));
    }
}
