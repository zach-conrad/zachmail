import type { AccountRow, ModuleId } from '@zachhub/core'
import type { DataClient } from '../data/client'

/** One 44 px row on a Today card; the same shape as a mail row. */
export interface TodayRow {
  id: string
  /** Account dot color (mail), list color (tasks), or none. */
  color?: string
  primary: string
  secondary?: string
  /** Trailing time or due label. */
  meta?: string
  /** Amber: overdue tasks, snoozed mail coming back (design H3). */
  tone?: 'warning'
  bold?: boolean
  open(): void
}

export interface TodayContext {
  client: DataClient
  accounts: ReadonlyMap<string, AccountRow>
  ownEmails: ReadonlySet<string>
  now: number
  /** Local midnight tonight. */
  endOfDay: number
  openMailThread(id: string): void
}

/**
 * What a module puts on Today (ZACHHUB_PLAN.md §4): a card read from the local replica only.
 * Mail contributes here now; Tasks (overdue first, then due today) and Docs (recent) add
 * theirs to `todayCards` when those modules land.
 */
export interface TodayCard {
  id: string
  module: Exclude<ModuleId, 'today'>
  title: string
  /** Shown empty rather than hidden, so the layout stays put. */
  empty: string
  load(ctx: TodayContext): Promise<TodayRow[]>
  /** This card's part of the summary line under the date ("2 important"), if any. */
  summary?(rows: readonly TodayRow[]): string | null
}
