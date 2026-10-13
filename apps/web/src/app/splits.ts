export const SPLITS = [
  { id: 'important', label: 'Important' },
  { id: 'other', label: 'Other' },
  { id: 'newsletters', label: 'Newsletters' },
  { id: 'notifications', label: 'Notifications' },
] as const

export type SplitId = (typeof SPLITS)[number]['id']

export const isSplit = (s: string): s is SplitId => SPLITS.some((x) => x.id === s)
