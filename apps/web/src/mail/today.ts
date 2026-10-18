import { accountColor } from '@zachhub/tokens'
import { clockTime, senderLabel, shortTime } from '../lib/format'
import type { TodayCard, TodayContext, TodayRow } from '../today/contributions'
import type { ThreadListItem } from '@zachhub/local-store'

const IMPORTANT_ROWS = 4
const COMING_BACK_ROWS = 6

function mailRow(ctx: TodayContext, t: ThreadListItem, meta: string, tone?: 'warning'): TodayRow {
  const account = ctx.accounts.get(t.accountId)
  return {
    id: `mail.${t.id}`,
    color: account ? accountColor(account.color) : undefined,
    primary: senderLabel(t.participants, ctx.ownEmails),
    secondary: t.subject || '(no subject)',
    meta,
    tone,
    bold: t.unread,
    open: () => ctx.openMailThread(t.id),
  }
}

/** Mail's Today cards (design H3): important mail, then snoozed mail coming back today. */
export const mailTodayCards: TodayCard[] = [
  {
    id: 'mail.important',
    module: 'mail',
    title: 'Important mail',
    empty: 'Nothing important waiting.',
    async load(ctx) {
      const rows = await ctx.client.api.listThreads({ split: 'important' }, 0, IMPORTANT_ROWS)
      return rows.map((t) => mailRow(ctx, t, shortTime(t.lastMessageAt, ctx.now)))
    },
    summary(rows) {
      const n = rows.filter((r) => r.bold).length
      return n ? `${n} important unread` : null
    },
  },
  {
    id: 'mail.comingBack',
    module: 'mail',
    title: 'Coming back today',
    empty: 'No snoozed mail due today.',
    async load(ctx) {
      const rows = await ctx.client.api.comingBack(ctx.now, ctx.endOfDay, COMING_BACK_ROWS)
      return rows.map((t) => mailRow(ctx, t, clockTime(t.snoozedUntil), 'warning'))
    },
    summary: (rows) => (rows.length ? `${rows.length} coming back` : null),
  },
]
