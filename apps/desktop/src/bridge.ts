/**
 * Runs in the main web view before any page script (Tauri initialization script). It defines
 * `window.zachmailDesktop` (contract in packages/core/src/desktop.ts) and the hooks the Rust
 * shell calls with `eval` for menu commands and opened URLs.
 */
import { invoke } from '@tauri-apps/api/core'
import {
  chordFromEvent,
  keymap,
  type CommandId,
  type ComposeDraft,
  type SecureStorage,
  type ZachMailDesktop,
} from '@zachmail/core'
import { parseMailto } from './mailto'
import { toAccelerator } from './menu'
import { keyEventsFor } from './replay'

const ignore = () => {}

// A native accelerator can arrive after the web view already saw and handled the same chord
// as a keydown; that menu event is an echo and must not run the command twice.
const nativeChords = new Map<string, string>()
for (const b of keymap) {
  const chord = b.keys.find((k) => toAccelerator(k))
  if (chord) nativeChords.set(b.id, chord)
}
let lastKey: { chord: string; event: KeyboardEvent } | null = null
window.addEventListener(
  'keydown',
  (e) => (lastKey = { chord: chordFromEvent(e, true), event: e }),
  true,
)
const ECHO_MS = 150

function runCommand(id: CommandId, fromMenu = false) {
  if (
    fromMenu &&
    lastKey?.event.defaultPrevented &&
    lastKey.chord === nativeChords.get(id) &&
    performance.now() - lastKey.event.timeStamp < ECHO_MS
  ) {
    return
  }
  const event = new CustomEvent('zachmail:command', { detail: { id }, cancelable: true })
  if (!window.dispatchEvent(event)) return
  for (const init of keyEventsFor(id)) window.dispatchEvent(new KeyboardEvent('keydown', init))
}

const pendingCompose: ComposeDraft[] = []

function compose(draft: ComposeDraft) {
  const event = new CustomEvent('zachmail:compose', { detail: draft, cancelable: true })
  if (!window.dispatchEvent(event)) return
  // Nobody listened yet: keep it for takePendingCompose() and open a blank composer.
  pendingCompose.push(draft)
  runCommand('compose.new')
}

function openUrl(url: string) {
  const draft = parseMailto(url)
  if (draft) return compose(draft)
  // zachmail://auth/callback?code=…#… : the browser sign-in hands the session back. Loading
  // the app with the same query and fragment lets supabase-js pick it up as it does on web.
  const m = /^zachmail:\/\/auth\/callback\/?([?#].*)?$/.exec(url)
  if (m) location.replace(location.origin + '/' + (m[1] ?? ''))
}

// Keychain access costs an IPC round trip; supabase-js reads the session often.
const cache = new Map<string, string | null>()
const secureStorage: SecureStorage = {
  async getItem(key) {
    if (!cache.has(key)) cache.set(key, await invoke<string | null>('secure_get', { key }))
    return cache.get(key) ?? null
  },
  async setItem(key, value) {
    cache.set(key, value)
    await invoke('secure_set', { key, value })
  },
  async removeItem(key) {
    cache.set(key, null)
    await invoke('secure_delete', { key })
  },
}

let unread = -1
const desktop: ZachMailDesktop = {
  version: 1,
  setUnreadCount(count) {
    const n = Math.max(0, Math.floor(count))
    if (n === unread) return
    unread = n
    invoke('set_unread', { count: n }).catch(ignore)
  },
  notify({ title, body }) {
    invoke('notify', { title, body: body ?? '' }).catch(ignore)
  },
  secureStorage,
  openExternal(url) {
    invoke('open_external', { url }).catch(ignore)
  },
  takePendingCompose: () => pendingCompose.splice(0),
}

Object.defineProperty(window, 'zachmailDesktop', { value: Object.freeze(desktop) })
Object.defineProperty(window, '__zachmailShell', {
  value: Object.freeze({
    command: (id: CommandId) => runCommand(id, true),
    openUrl,
  }),
})

// Links that would leave the app open in the default browser instead of the app window.
document.addEventListener(
  'click',
  (e) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || !/^https?:$/.test(a.protocol) || a.origin === location.origin) return
    e.preventDefault()
    desktop.openExternal(a.href)
  },
  true,
)

// Runs once the document exists (initialization scripts start before <html> is parsed).
// URLs that launched the app (a mailto: click while it was closed) wait for the page.
function ready() {
  document.documentElement.dataset.shell = 'macos'
  invoke<string[]>('bridge_ready')
    .then((urls) => urls.forEach(openUrl))
    .catch(ignore)
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ready, { once: true })
} else ready()
