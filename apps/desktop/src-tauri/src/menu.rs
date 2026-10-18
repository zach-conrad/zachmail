//! The native menu bar. Its commands come from src-tauri/menu.json, which src/menu.ts
//! generates from the core keymap, so the menu bar never drifts from the key handler.

use std::sync::OnceLock;

use serde::Deserialize;
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

const CHECK_UPDATES: &str = "app:check-updates";
const COMMAND_PREFIX: &str = "cmd:";

#[derive(Deserialize)]
pub struct Spec {
    app: Vec<Item>,
    menus: Vec<Group>,
    help: Vec<Item>,
    pub global: Vec<Global>,
}

#[derive(Deserialize)]
struct Group {
    title: String,
    items: Vec<Item>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Item {
    Command {
        id: String,
        label: String,
        accelerator: Option<String>,
    },
    Separator {
        #[allow(dead_code)]
        separator: bool,
    },
}

#[derive(Deserialize)]
pub struct Global {
    pub accelerator: String,
    pub command: String,
}

pub fn spec() -> &'static Spec {
    static SPEC: OnceLock<Spec> = OnceLock::new();
    SPEC.get_or_init(|| {
        serde_json::from_str(include_str!("../menu.json")).expect("menu.json is generated")
    })
}

fn submenu(app: &AppHandle, title: &str, items: &[Item]) -> tauri::Result<Submenu<Wry>> {
    let menu = Submenu::new(app, title, true)?;
    append(app, &menu, items)?;
    Ok(menu)
}

fn append(app: &AppHandle, menu: &Submenu<Wry>, items: &[Item]) -> tauri::Result<()> {
    for item in items {
        match item {
            Item::Command {
                id,
                label,
                accelerator,
            } => menu.append(&MenuItem::with_id(
                app,
                format!("{COMMAND_PREFIX}{id}"),
                label,
                true,
                accelerator.as_deref(),
            )?)?,
            Item::Separator { .. } => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(())
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let spec = spec();
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::new(app, "ZachMail", true)?;
    app_menu.append(&PredefinedMenuItem::about(
        app,
        None,
        Some(AboutMetadata::default()),
    )?)?;
    app_menu.append(&MenuItem::with_id(
        app,
        CHECK_UPDATES,
        "Check for Updates…",
        true,
        None::<&str>,
    )?)?;
    app_menu.append(&sep()?)?;
    append(app, &app_menu, &spec.app)?;
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::services(app, None)?)?;
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::hide(app, None)?)?;
    app_menu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
    app_menu.append(&PredefinedMenuItem::show_all(app, None)?)?;
    app_menu.append(&sep()?)?;
    app_menu.append(&PredefinedMenuItem::quit(app, None)?)?;

    let file = Submenu::new(app, "File", true)?;
    file.append(&PredefinedMenuItem::close_window(app, None)?)?;

    // Native items so text fields in compose and search keep the system behaviour.
    let edit = Submenu::new(app, "Edit", true)?;
    edit.append(&PredefinedMenuItem::undo(app, None)?)?;
    edit.append(&PredefinedMenuItem::redo(app, None)?)?;
    edit.append(&sep()?)?;
    edit.append(&PredefinedMenuItem::cut(app, None)?)?;
    edit.append(&PredefinedMenuItem::copy(app, None)?)?;
    edit.append(&PredefinedMenuItem::paste(app, None)?)?;
    edit.append(&PredefinedMenuItem::select_all(app, None)?)?;

    let window = Submenu::new(app, "Window", true)?;
    window.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window.append(&PredefinedMenuItem::maximize(app, None)?)?;
    window.append(&PredefinedMenuItem::fullscreen(app, None)?)?;

    let menu = Menu::new(app)?;
    menu.append(&app_menu)?;
    menu.append(&file)?;
    menu.append(&edit)?;
    for group in &spec.menus {
        menu.append(&submenu(app, &group.title, &group.items)?)?;
    }
    menu.append(&window)?;
    menu.append(&submenu(app, "Help", &spec.help)?)?;
    Ok(menu)
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if let Some(command) = id.strip_prefix(COMMAND_PREFIX) {
        crate::focus(app);
        crate::run_command(app, command);
    } else if id == CHECK_UPDATES {
        crate::check_for_update_now(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_parses_and_accelerators_are_valid() {
        let spec = spec();
        let items = spec
            .menus
            .iter()
            .flat_map(|g| &g.items)
            .chain(&spec.app)
            .chain(&spec.help);
        for item in items {
            if let Item::Command {
                accelerator: Some(a),
                ..
            } = item
            {
                a.parse::<tauri_plugin_global_shortcut::Shortcut>()
                    .unwrap_or_else(|e| panic!("{a}: {e}"));
            }
        }
        for g in &spec.global {
            g.accelerator
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .unwrap();
        }
    }
}
