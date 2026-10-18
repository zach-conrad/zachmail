/**
 * Task commands (design H2). Tasks reuse mail's verbs so muscle memory carries over: E completes
 * like Done, H sets an alert like Remind, # deletes like Trash, L moves like Label, Z undoes.
 * Bindings are module-scoped: they are active only while the Tasks screen is mounted, so they
 * may share keys with mail commands but never with each other.
 */
import type { KeyBinding } from '@zachhub/core'

export const tasksKeymap = [
  { id: 'tasks.next', label: 'Next task', group: 'navigation', keys: ['j', 'arrowdown'] },
  { id: 'tasks.prev', label: 'Previous task', group: 'navigation', keys: ['k', 'arrowup'] },
  { id: 'tasks.open', label: 'Open task', group: 'navigation', keys: ['enter', 'o'] },
  { id: 'tasks.back', label: 'Close', group: 'navigation', keys: ['escape'] },
  { id: 'tasks.nextView', label: 'Next list', group: 'navigation', keys: ['tab'] },
  { id: 'tasks.prevView', label: 'Previous list', group: 'navigation', keys: ['shift+tab'] },
  { id: 'tasks.goMail', label: 'Go to Mail', group: 'navigation', keys: ['g m', 'g i'] },
  { id: 'tasks.new', label: 'New task', group: 'compose', keys: ['c'] },
  { id: 'tasks.complete', label: 'Complete', group: 'triage', keys: ['e'] },
  { id: 'tasks.remind', label: 'Remind me', group: 'triage', keys: ['h'] },
  { id: 'tasks.due', label: 'Due date', group: 'triage', keys: ['d'] },
  { id: 'tasks.move', label: 'Move to list', group: 'triage', keys: ['l'] },
  { id: 'tasks.flag', label: 'Flag', group: 'triage', keys: ['s'] },
  { id: 'tasks.delete', label: 'Delete', group: 'triage', keys: ['#'] },
  { id: 'tasks.moveUp', label: 'Move up', group: 'triage', keys: ['mod+arrowup'] },
  { id: 'tasks.moveDown', label: 'Move down', group: 'triage', keys: ['mod+arrowdown'] },
  { id: 'tasks.undo', label: 'Undo', group: 'selection', keys: ['z'] },
  { id: 'tasks.palette', label: 'Command palette', group: 'app', keys: ['mod+k'] },
  { id: 'tasks.shortcuts', label: 'Keyboard shortcuts', group: 'app', keys: ['?'] },
] as const satisfies readonly KeyBinding[]

export type TaskCommandId = (typeof tasksKeymap)[number]['id']
