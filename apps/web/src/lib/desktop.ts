// The macOS shell (apps/desktop) injects `window.zachmailDesktop` before any page script; on
// the web it is undefined and every use below is a no-op. This is the subset the web app
// calls; the full contract is ZachMailDesktop in hub/core/src/desktop.ts (macOS PR).

export interface DesktopBridge {
  setUnreadCount(count: number): void
  notify(n: { title: string; body?: string; threadId?: string }): void
  secureStorage: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
  }
}

export const desktop = (window as { zachmailDesktop?: DesktopBridge }).zachmailDesktop

/** OAuth return address: the app's URL scheme on macOS, this origin on the web. */
export const authRedirect = desktop ? 'zachmail://auth/callback' : location.origin
