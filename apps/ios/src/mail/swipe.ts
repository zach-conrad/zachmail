/**
 * Swipe triage (design §3.1): right short = Done, right long = Trash, left short = Remind,
 * left long = toggle read. Thresholds are fractions of row width so they feel the same on every phone.
 * Marked as worklets so the gesture can call them on the UI thread.
 */
export type SwipeAction = 'done' | 'trash' | 'snooze' | 'toggleRead'

export const SHORT = 0.22
export const LONG = 0.6

export function swipeAction(dx: number, width: number): SwipeAction | null {
  'worklet'
  const f = dx / width
  if (f >= LONG) return 'trash'
  if (f >= SHORT) return 'done'
  if (f <= -LONG) return 'toggleRead'
  if (f <= -SHORT) return 'snooze'
  return null
}

/** Whether the swipe has crossed the long threshold (for the haptic tick). */
export function isLong(dx: number, width: number): boolean {
  'worklet'
  return Math.abs(dx / width) >= LONG
}
