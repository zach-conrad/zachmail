/**
 * Contract between the web app and the macOS shell (apps/desktop). The shell injects
 * `window.zachmailDesktop` before any page script runs; on the web it is undefined, so every
 * call site is `window.zachmailDesktop?.…` and costs nothing outside the desktop app.
 */

import type { CommandId } from './keymap'

/** A new message requested from outside the app (a mailto: link). */
export interface ComposeDraft {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
}

export interface DesktopNotification {
  title: string
  body?: string
  /** Thread to open when Zach acts on the notification. */
  threadId?: string
}

/** Async Storage shape, accepted as-is by supabase-js `auth.storage`. */
export interface SecureStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface ZachMailDesktop {
  readonly version: 1
  /** Dock badge. Pass the Important split's unread count; 0 clears the badge. */
  setUnreadCount(count: number): void
  notify(notification: DesktopNotification): void
  /** macOS Keychain-backed storage for the Supabase session. */
  secureStorage: SecureStorage
  /** Opens a URL in the default browser. */
  openExternal(url: string): void
  /** Compose requests that arrived before the app listened for `zachmail:compose`. */
  takePendingCompose(): ComposeDraft[]
}

/**
 * DOM events the shell dispatches on `window`. They are cancelable: call `preventDefault()`
 * to mark one handled. An unhandled `zachmail:command` falls back to replaying the command's
 * key binding, so anything `useCommands` handles works from the menu bar with no extra code.
 */
export interface DesktopEventMap {
  'zachmail:command': CustomEvent<{ id: CommandId }>
  'zachmail:compose': CustomEvent<ComposeDraft>
}

declare global {
  interface Window {
    zachmailDesktop?: ZachMailDesktop
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface WindowEventMap extends DesktopEventMap {}
}
