import { isBuiltInSplit, isUuid } from '@zachmail/core'
import { REMINDERS } from '@zachmail/local-store'

/** Route guard: a built-in split, or something shaped like a custom split's rule id. */
export const isSplitKey = (s: string): boolean => isBuiltInSplit(s) || isUuid(s)

/** Route guard for the inbox: a split, or Reminders (snoozed and reminded threads). */
export const isView = (s: string): boolean => s === REMINDERS || isSplitKey(s)
