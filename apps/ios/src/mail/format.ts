import type { Address } from '@zachhub/core'

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const fmtDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const fmtFull = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** Row timestamp: "9m", "3h" today; weekday this week; "Oct 3" after that. */
export function rowTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 12 * 3_600_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 6 * 86_400_000) return fmtWeekday.format(ts)
  return fmtDay.format(ts)
}

export const messageTime = (ts: number): string => fmtTime.format(ts)
export const fullTime = (ts: number): string => fmtFull.format(ts)

export const displayName = (a: Address | null | undefined): string =>
  a?.name || a?.email.split('@')[0] || 'Unknown'

/** Plain text for the demo reader. Real bodies arrive pre-sanitized from the server (architecture §8). */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
