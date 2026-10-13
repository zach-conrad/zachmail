export const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Single-key shortcuts must not fire while typing. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return (
    t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT'
  )
}
