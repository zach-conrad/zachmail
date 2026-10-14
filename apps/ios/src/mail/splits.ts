import { SPLIT_IDS, type SplitId } from '@zachmail/core'

export type { SplitId }

const LABELS: Record<SplitId, string> = {
  important: 'Important',
  other: 'Other',
  newsletters: 'Newsletters',
  notifications: 'Notifications',
}

/** Built-in splits (design §2); classification is shared with web in `@zachmail/core` (`classifySplit`). */
export const splits = SPLIT_IDS.map((id) => ({ id, label: LABELS[id] }))
