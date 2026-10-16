import {
  DEFAULT_ALERT_TIME,
  describeRRule,
  parseQuickAdd,
  type Clock,
  type QuickAddResult,
  type TaskList,
} from '@zachhub/tasks-core'
import { forwardRef, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { formatDue, formatTime, listColor } from './format'
import { beginInteraction } from './perf'

interface Props {
  lists: readonly TaskList[]
  clock: Clock
  placeholder: string
  onAdd: (parsed: QuickAddResult) => void
  onCancel: () => void
}

/**
 * One field for every new task (design H4). Parsed spans highlight inline as you type (date and
 * repeat in the accent, #list in its color, ! in danger) and resolve to chips underneath. The
 * highlight is a mirror layer under a transparent-text input, so the caret and IME stay native.
 */
export const QuickAdd = forwardRef<HTMLInputElement, Props>(function QuickAdd(
  { lists, clock, placeholder, onAdd, onCancel },
  ref,
) {
  const [text, setText] = useState('')
  // Parsing is client-only and well under a frame (tasks-core quickadd tests hold it to 16 ms).
  const parsed = useMemo(
    () => (text.trim() ? parseQuickAdd(text, { now: new Date(), lists }) : null),
    // clock ticks each minute so "at 5" re-resolves when the hour passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, lists, clock],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (parsed?.title) {
        beginInteraction('tasks.add', e.timeStamp)
        onAdd(parsed)
        setText('')
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setText('')
      onCancel()
    }
  }

  const listFor = (p: QuickAddResult) => lists.find((l) => l.id === p.listId)
  const mirror: ReactNode[] = []
  if (parsed) {
    let at = 0
    for (const t of parsed.tokens) {
      if (t.start > at) mirror.push(text.slice(at, t.start))
      const color = t.kind === 'list' ? listColor(listFor(parsed)?.color ?? 'gray') : undefined
      mirror.push(
        <mark
          key={t.start}
          className="qa-mark"
          data-kind={t.kind}
          style={color ? { color } : undefined}
        >
          {text.slice(t.start, t.end)}
        </mark>,
      )
      at = t.end
    }
    mirror.push(text.slice(at))
  }

  const chips: { key: string; kind: string; label: string; color?: string }[] = []
  if (parsed) {
    if (parsed.dueDate)
      chips.push({
        key: 'due',
        kind: 'date',
        label: formatDue(parsed.dueDate, parsed.dueTime, clock),
      })
    if (parsed.rrule)
      chips.push({ key: 'repeat', kind: 'repeat', label: describeRRule(parsed.rrule) })
    if (parsed.alertAt !== null && !parsed.dueTime)
      chips.push({ key: 'alert', kind: 'date', label: `Alert ${formatTime(DEFAULT_ALERT_TIME)}` })
    if (parsed.listName) {
      const list = listFor(parsed)
      chips.push({
        key: 'list',
        kind: 'list',
        label: list ? list.name : `New list “${parsed.listName}”`,
        color: listColor(list?.color ?? 'gray'),
      })
    }
    for (const tag of parsed.tags) chips.push({ key: `tag-${tag}`, kind: 'tag', label: `+${tag}` })
    if (parsed.priority)
      chips.push({
        key: 'p',
        kind: 'priority',
        label: ['', 'Low', 'Medium', 'High'][parsed.priority]!,
      })
  }

  return (
    <div className="qa">
      <div className="qa-field">
        <span className="qa-plus" aria-hidden>
          +
        </span>
        <div className="qa-stack">
          <div className="qa-mirror" aria-hidden>
            {mirror}
          </div>
          <input
            ref={ref}
            className="qa-input"
            data-parsed={parsed && parsed.tokens.length ? '' : undefined}
            value={text}
            placeholder={placeholder}
            aria-label="New task"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
      {chips.length > 0 && (
        <div className="qa-chips" aria-live="polite">
          {chips.map((c) => (
            <span key={c.key} className="qa-chip" data-kind={c.kind}>
              {c.color && <span className="list-dot" style={{ background: c.color }} />}
              {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
})
