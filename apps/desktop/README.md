# ZachMail for macOS

A Tauri 2 shell around `apps/web` (architecture §3, build plan phase 7). The web build is
bundled into the app, so launch never waits on the network. Rust is glue only.

| Feature                                                | Where                                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Menu bar generated from the core keymap                | `src/menu.ts` → `src-tauri/menu.json` → `src-tauri/src/menu.rs`                        |
| Dock badge, notifications, Keychain, external links    | `window.zachmailDesktop` (`src/bridge.ts`, contract in `packages/core/src/desktop.ts`) |
| Global compose shortcut (⌘⌃M, keymap `compose.global`) | `tauri-plugin-global-shortcut`                                                         |
| `mailto:` and `zachmail://` links                      | `tauri-plugin-deep-link`, parsed in `src/mailto.ts`                                    |
| Auto-update from GitHub Releases                       | `tauri-plugin-updater`, checked 30 s after launch and every 6 h                        |
| Signed, notarized DMG                                  | `.github/workflows/desktop.yml`                                                        |

## Develop

Needs Rust (stable) and Xcode command line tools.

```sh
pnpm --filter @zachmail/desktop dev     # web dev server + app window
pnpm --filter @zachmail/desktop app     # release .app and .dmg (needs the updater key, see below)
pnpm --filter @zachmail/desktop menu    # regenerate menu.json after editing the keymap
```

To make ZachMail the default mail app: Mail → Settings → General → Default email reader.

## How the web app talks to the shell

On the web `window.zachmailDesktop` is undefined, so all of this is a no-op there.

- **Menu commands** dispatch a cancelable `zachmail:command` event on `window`. If nothing
  cancels it, the shell replays the command's key binding, so everything `useCommands`
  handles already works from the menu bar.
- **mailto:** dispatches a cancelable `zachmail:compose` event with a `ComposeDraft`. If
  nothing cancels it, the draft is queued (`zachmailDesktop.takePendingCompose()`) and
  `compose.new` runs.
- **Dock badge:** call `zachmailDesktop.setUnreadCount(importantUnread)`.
- **Notifications:** `zachmailDesktop.notify({ title, body, threadId })`.
- **Keychain session:** pass `zachmailDesktop.secureStorage` as supabase-js `auth.storage`.
- **Sign-in:** the window only navigates within the app; Google sign-in opens in the default
  browser. Use `zachmail://auth/callback` as the OAuth `redirectTo` in the desktop app and
  allow it in Supabase Auth; the shell reloads the app with the returned code or tokens.
- `<html data-shell="macos">` is set so CSS can leave the header and sidebar transparent over
  the native window material (design §5.6).

## Releasing

Push a `desktop-v<version>` tag (or run the Desktop workflow by hand) after bumping
`version` in `package.json`. Until the Apple secrets listed in the workflow exist, the build
is ad-hoc signed and marked a prerelease; open it the first time with right-click → Open.

For updates, generate a key once with `pnpm --filter @zachmail/desktop tauri signer generate`,
put the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and the private
key and its password in the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.
