import { isOverdue, type Clock, type Task, type TaskList } from '@zachhub/tasks-core'
import { memo, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { formatDue, listColor } from './format'

export const ROW = 44
const OVERSCAN = 8

export interface RowItem {
  task: Task
  depth: 0 | 1
  /** Just completed: plays the exit, then leaves the list. */
  leaving: boolean
}

interface Props {
  items: readonly RowItem[]
  focus: number
  clock: Clock
  lists: ReadonlyMap<string, TaskList>
  /** Show each task's list (smart lists mix lists). */
  showList: boolean
  onFocus: (index: number) => void
  onOpen: (index: number) => void
  onToggle: (index: number) => void
}

/** Virtualized task rows: fixed 44 px rows, only what's on screen plus overscan. */
export function TaskRows({
  items,
  focus,
  clock,
  lists,
  showList,
  onFocus,
  onOpen,
  onToggle,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Stable callbacks so memoized rows skip re-rendering when only other rows changed.
  const latest = useRef({ onFocus, onOpen, onToggle })
  useLayoutEffect(() => {
    latest.current = { onFocus, onOpen, onToggle }
  })
  const actions = useMemo<RowActions>(
    () => ({
      focus: (i) => latest.current.onFocus(i),
      open: (i) => latest.current.onOpen(i),
      toggle: (i) => latest.current.onToggle(i),
    }),
    [],
  )
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(800)

  useLayoutEffect(() => {
    const el = ref.current!
    setHeight(el.clientHeight)
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep the focused row on screen; jump, never animate. Works from the tracked scroll state
  // so a keypress never forces a synchronous layout just to read scrollTop.
  useLayoutEffect(() => {
    const top = focus * ROW
    let next = scrollTop
    if (top < next) next = top
    else if (top + ROW > next + height) next = top + ROW - height
    // The scroll event that follows updates scrollTop and renders the rows now in view.
    if (next !== scrollTop) ref.current!.scrollTop = next
    // Only a focus change should scroll; scrolling by hand must not snap back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const end = Math.min(items.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN)
  const rows = []
  for (let i = start; i < end; i++) {
    const item = items[i]!
    rows.push(
      <Row
        key={item.task.id}
        index={i}
        task={item.task}
        depth={item.depth}
        leaving={item.leaving}
        focused={i === focus}
        overdue={isOverdue(item.task, clock)}
        due={formatDue(item.task.dueDate, item.task.dueTime, clock)}
        list={showList && item.task.listId ? lists.get(item.task.listId) : undefined}
        actions={actions}
      />,
    )
  }

  return (
    <div
      ref={ref}
      className="task-rows"
      role="listbox"
      aria-label="Tasks"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="task-rows-inner" style={{ height: items.length * ROW }}>
        {rows}
      </div>
    </div>
  )
}

interface RowActions {
  focus: (index: number) => void
  open: (index: number) => void
  toggle: (index: number) => void
}

interface RowProps {
  index: number
  task: Task
  depth: 0 | 1
  leaving: boolean
  focused: boolean
  overdue: boolean
  due: string
  list: TaskList | undefined
  actions: RowActions
}

const Row = memo(function Row({
  index,
  task,
  depth,
  leaving,
  focused,
  overdue,
  due,
  list,
  actions,
}: RowProps) {
  const ring = task.priority === 3 ? 'high' : overdue ? 'overdue' : undefined
  return (
    <div
      className="task-row"
      role="option"
      aria-selected={focused}
      data-focused={focused || undefined}
      data-leaving={leaving || undefined}
      data-depth={depth || undefined}
      style={{ transform: `translateY(${index * ROW}px)` }}
      onClick={(e: MouseEvent) => (e.detail === 2 ? actions.open(index) : actions.focus(index))}
    >
      <button
        className="task-check"
        data-ring={ring}
        data-done={task.completedAt !== null || leaving || undefined}
        aria-label={task.completedAt !== null ? 'Mark not done' : 'Complete'}
        onClick={(e) => {
          e.stopPropagation()
          actions.toggle(index)
        }}
      >
        <svg viewBox="0 0 20 20" aria-hidden>
          <circle cx="10" cy="10" r="8.25" />
          <path d="M6 10.5l2.6 2.5L14 7.5" />
        </svg>
      </button>
      <span className="task-title">{task.title}</span>
      <span className="task-icons">
        {task.notes && <Icon title="Notes" d="M4 5h12M4 10h12M4 15h8" />}
        {task.rrule && (
          <Icon
            title="Repeats"
            d="M15 7.5A5.5 5.5 0 0 0 5 6.5M5 12.5a5.5 5.5 0 0 0 10 1M4.5 3.5v3h3M15.5 16.5v-3h-3"
          />
        )}
        {task.alertAt !== null && (
          <Icon title="Alert" d="M6 13.5V9a4 4 0 0 1 8 0v4.5l1.5 1.5h-11zM8.5 17h3" />
        )}
      </span>
      {list && (
        <span className="task-list">
          <span className="list-dot" style={{ background: listColor(list.color) }} />
          {list.name}
        </span>
      )}
      <span className="task-due" data-overdue={overdue || undefined}>
        {due}
      </span>
    </div>
  )
})

function Icon({ title, d }: { title: string; d: string }) {
  return (
    <svg className="task-icon" viewBox="0 0 20 20" role="img" aria-label={title}>
      <title>{title}</title>
      <path d={d} />
    </svg>
  )
}
