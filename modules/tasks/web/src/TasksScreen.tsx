import {
  clockAt,
  completeOp,
  countViews,
  inView,
  LIST_COLORS,
  positionAtEnd,
  positionForStep,
  selectSubtasks,
  selectTasks,
  SMART_LISTS,
  sortedLists,
  subtasksByParent,
  tasksFixture,
  tasksKeymap,
  warmQuickAdd,
  type Clock,
  type QuickAddResult,
  type SmartListKey,
  type Task,
  type TaskList,
  type TaskPatch,
  type TasksState,
  type TaskView,
} from '@zachhub/tasks-core'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { formatDue, formatNext, listColor } from './format'
import { useTaskKeys, type TaskHandlers } from './keys'
import { endInteraction } from './perf'
import { displayKeys, fuzzy, Picker, type PickerOption } from './Picker'
import { dueOptions, listOptions, remindOptions } from './pickers'
import { QuickAdd } from './QuickAdd'
import { newId, TasksStore } from './store'
import { TaskDetail } from './TaskDetail'
import { TaskRows, type RowItem } from './TaskRows'
import './tasks.css'

export interface TasksScreenProps {
  /** Route segment: a smart list key, "inbox", or a list id. */
  view: string
  /** Seed a generated fixture of this many tasks and keep everything in memory (demo, perf CI). */
  demo: number | false
  onNavigate: (view: string) => void
  onGoMail: () => void
}

type Overlay = 'due' | 'remind' | 'move' | 'palette' | 'shortcuts' | null

const LEAVE_MS = 180

let shared: TasksStore | null = null
function getStore(demo: number | false): TasksStore {
  shared ??= demo
    ? new TasksStore(tasksFixture({ now: new Date(), tasks: demo }), false)
    : new TasksStore()
  return shared
}

const SMART_KEYS = new Set<string>(SMART_LISTS.map((s) => s.key))

function toView(view: string, state: TasksState): TaskView {
  if (SMART_KEYS.has(view)) return { kind: 'smart', key: view as SmartListKey }
  if (view === 'inbox') return { kind: 'inbox' }
  if (state.lists.has(view)) return { kind: 'list', id: view }
  return { kind: 'smart', key: 'today' }
}

const viewKey = (v: TaskView) => (v.kind === 'smart' ? v.key : v.kind === 'inbox' ? 'inbox' : v.id)

function useClock(): Clock {
  const [clock, setClock] = useState(() => clockAt(new Date()))
  useEffect(() => {
    const id = setInterval(() => {
      const next = clockAt(new Date())
      setClock((c) => (c.today === next.today && c.time === next.time ? c : next))
    }, 15_000)
    return () => clearInterval(id)
  }, [])
  return clock
}

/** Tasks (design H4): lists column, quick add, the task rows, and the detail pane. */
export function TasksScreen({ view: viewParam, demo, onNavigate, onGoMail }: TasksScreenProps) {
  const store = getStore(demo)
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const toast = useSyncExternalStore(store.subscribe, store.getToast)
  const clock = useClock()
  const view = toView(viewParam, state)
  const lists = useMemo(() => sortedLists(state), [state])
  const counts = useMemo(() => countViews(state, clock), [state, clock])

  // Just-completed tasks stay put for the exit animation, then leave.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const items = useMemo<RowItem[]>(() => {
    const subs = view.kind !== 'smart' ? subtasksByParent(state, leaving) : null
    const out: RowItem[] = []
    for (const task of selectTasks(state, view, clock, leaving)) {
      out.push({ task, depth: 0, leaving: leaving.has(task.id) })
      for (const sub of subs?.get(task.id) ?? [])
        out.push({ task: sub, depth: 1, leaving: leaving.has(sub.id) })
    }
    return out
  }, [state, view.kind, viewParam, clock, leaving]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus follows a task by id; when that task leaves the view, the row that took its place.
  const [focusAt, setFocusAt] = useState<{ id: string | null; index: number }>({
    id: null,
    index: 0,
  })
  let focus = focusAt.id ? items.findIndex((i) => i.task.id === focusAt.id) : -1
  if (focus < 0) focus = Math.min(focusAt.index, items.length - 1)
  const setFocusId = (id: string) => {
    const index = items.findIndex((i) => i.task.id === id)
    setFocusAt({ id, index: index < 0 ? focus : index })
  }
  const focused = focus >= 0 ? items[focus]?.task : undefined

  const [detailId, setDetailId] = useState<string | null>(null)
  const detail = detailId ? state.tasks.get(detailId) : undefined
  const [overlay, setOverlay] = useState<Overlay>(null)
  const quickAdd = useRef<HTMLInputElement>(null)

  // Pay chrono's one-time setup before the first keystroke, off the critical path.
  useEffect(() => {
    const id = setTimeout(warmQuickAdd, 0)
    return () => clearTimeout(id)
  }, [])

  // Each view opens at its top.
  const [shownView, setShownView] = useState(viewParam)
  if (shownView !== viewParam) {
    setShownView(viewParam)
    setFocusAt({ id: null, index: 0 })
  }

  const order: string[] = [...SMART_LISTS.map((s) => s.key), 'inbox', ...lists.map((l) => l.id)]
  const cycle = (dir: 1 | -1) => {
    const i = order.indexOf(viewKey(view))
    onNavigate(order[(i + dir + order.length) % order.length]!)
  }
  const moveFocus = (dir: 1 | -1) => {
    const next = items[Math.max(0, Math.min(items.length - 1, focus + dir))]
    if (next) setFocusId(next.task.id)
  }

  const patch = (task: Task, p: TaskPatch, toastText?: string) =>
    store.run({ kind: 'tasks.update', id: task.id, patch: p }, toastText)

  const toggle = (task: Task) => {
    if (task.completedAt !== null) {
      store.run({ kind: 'tasks.uncomplete', id: task.id }, 'Marked not done')
      return
    }
    const { op, nextDue } = completeOp(task, new Date(), newId)
    if (!store.run(op, nextDue ? `Completed · ${formatNext(nextDue, clock)}` : 'Completed')) return
    setLeaving((s) => new Set(s).add(task.id))
    // Focus moves on at once, like mail's Done, so E can be pressed again while the row exits.
    if (task.id === focused?.id) {
      const live = (i: RowItem) => !i.leaving && i.task.id !== task.id
      const next = items.slice(focus + 1).find(live) ?? items.slice(0, focus).reverse().find(live)
      if (next) setFocusId(next.task.id)
    }
    // One timer for all exiting rows: while E is being pressed in a run, finished rows hold
    // their place (faded) so nothing jumps under the cursor, then all collapse together.
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      setLeaving(new Set())
    }, LEAVE_MS)
  }

  const createList = (typed: string): TaskList => {
    const now = Date.now()
    const name = typed.charAt(0).toUpperCase() + typed.slice(1)
    const list: TaskList = {
      id: newId(),
      name,
      color: LIST_COLORS[lists.length % LIST_COLORS.length]!,
      position: positionAtEnd(lists),
      createdAt: now,
      updatedAt: now,
    }
    store.run({ kind: 'tasks.list.create', list })
    return list
  }

  const add = (p: QuickAddResult) => {
    let listId = p.listId ?? (view.kind === 'list' ? view.id : null)
    if (p.listName && !p.listId) listId = createList(p.listName).id
    const now = Date.now()
    const siblings = [...state.tasks.values()].filter(
      (t) => t.listId === listId && t.parentId === null,
    )
    const task: Task = {
      id: newId(),
      listId,
      parentId: null,
      title: p.title,
      notes: '',
      dueDate: p.dueDate ?? (view.kind === 'smart' && view.key === 'today' ? clock.today : null),
      dueTime: p.dueTime,
      alertAt: p.alertAt,
      rrule: p.rrule,
      priority: p.priority || (view.kind === 'smart' && view.key === 'flagged' ? 3 : 0),
      tags: p.tags,
      position: positionAtEnd(siblings),
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    // A task that lands outside this view would vanish silently; say where it went.
    const where = listId ? (state.lists.get(listId)?.name ?? p.listName) : 'Inbox'
    const due = formatDue(task.dueDate, task.dueTime, clock)
    store.run(
      { kind: 'tasks.create', task },
      inView(task, view, clock) ? undefined : `Added to ${where}${due ? ` · ${due}` : ''}`,
    )
    setFocusId(task.id)
  }

  const addSubtask = (parent: Task, title: string) => {
    const now = Date.now()
    store.run({
      kind: 'tasks.create',
      task: {
        id: newId(),
        listId: parent.listId,
        parentId: parent.id,
        title,
        notes: '',
        dueDate: null,
        dueTime: null,
        alertAt: null,
        rrule: null,
        priority: 0,
        tags: [],
        position: positionAtEnd(selectSubtasks(state, parent.id)),
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    })
  }

  const reorder = (dir: -1 | 1) => {
    if (!focused || view.kind === 'smart') return
    const siblings = focused.parentId
      ? selectSubtasks(state, focused.parentId)
      : selectTasks(state, view, clock)
    const position = positionForStep(
      siblings,
      siblings.findIndex((t) => t.id === focused.id),
      dir,
    )
    if (position) patch(focused, { position })
  }

  const target = detail ?? focused
  const handlers: TaskHandlers = overlay
    ? { 'tasks.back': () => setOverlay(null) }
    : {
        'tasks.next': () => moveFocus(1),
        'tasks.prev': () => moveFocus(-1),
        'tasks.open': () => focused && setDetailId(focused.id),
        'tasks.back': () => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          setDetailId(null)
        },
        'tasks.nextView': () => cycle(1),
        'tasks.prevView': () => cycle(-1),
        'tasks.goMail': onGoMail,
        'tasks.new': () => quickAdd.current?.focus(),
        'tasks.complete': () => target && toggle(target),
        'tasks.remind': () => target && setOverlay('remind'),
        'tasks.due': () => target && setOverlay('due'),
        'tasks.move': () => target && setOverlay('move'),
        'tasks.flag': () =>
          target &&
          patch(
            target,
            { priority: target.priority === 3 ? 0 : 3 },
            target.priority === 3 ? 'Unflagged' : 'Flagged',
          ),
        'tasks.delete': () => {
          if (!target) return
          if (detailId === target.id) setDetailId(null)
          store.run({ kind: 'tasks.delete', id: target.id }, 'Deleted')
        },
        'tasks.moveUp': () => reorder(-1),
        'tasks.moveDown': () => reorder(1),
        'tasks.undo': () => store.undo(),
        'tasks.palette': () => setOverlay('palette'),
        'tasks.shortcuts': () => setOverlay('shortcuts'),
      }
  useTaskKeys(handlers)
  useLayoutEffect(endInteraction)

  const title =
    view.kind === 'smart'
      ? SMART_LISTS.find((s) => s.key === view.key)!.label
      : view.kind === 'inbox'
        ? 'Inbox'
        : (state.lists.get(view.id)?.name ?? '')

  const paletteOptions = (q: string): PickerOption[] => {
    const commands: PickerOption[] = tasksKeymap
      .filter((b) => b.id !== 'tasks.palette' && b.id !== 'tasks.back' && handlers[b.id])
      .map((b) => ({ id: b.id, label: b.label, keys: b.keys[0], run: () => handlers[b.id]!() }))
    const views: PickerOption[] = order.map((key) => ({
      id: `view.${key}`,
      label: `Go to ${key === 'inbox' ? 'Inbox' : (SMART_LISTS.find((s) => s.key === key)?.label ?? state.lists.get(key)?.name)}`,
      run: () => onNavigate(key),
    }))
    return [...commands, ...views]
      .map((o) => ({ o, s: fuzzy(q, o.label) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.o)
  }

  return (
    <div className="tasks" data-detail={detail ? '' : undefined}>
      <nav className="tasks-nav" aria-label="Lists">
        <button className="tasks-nav-mail" onClick={onGoMail}>
          ← Mail <kbd className="kbd">{displayKeys('g m')}</kbd>
        </button>
        <ul>
          {SMART_LISTS.map((s) => (
            <NavItem
              key={s.key}
              label={s.label}
              count={counts[s.key]}
              warn={s.key === 'overdue' && counts.overdue > 0}
              current={viewKey(view) === s.key}
              onClick={() => onNavigate(s.key)}
            />
          ))}
        </ul>
        <h2 className="section-label">Lists</h2>
        <ul>
          <NavItem
            label="Inbox"
            count={counts.inbox}
            current={view.kind === 'inbox'}
            onClick={() => onNavigate('inbox')}
          />
          {lists.map((l) => (
            <NavItem
              key={l.id}
              label={l.name}
              color={listColor(l.color)}
              count={counts.lists.get(l.id) ?? 0}
              current={view.kind === 'list' && view.id === l.id}
              onClick={() => onNavigate(l.id)}
            />
          ))}
        </ul>
      </nav>
      <main className="tasks-main">
        <header className="tasks-head">
          <h1 className="display tasks-title">{title}</h1>
          <QuickAdd
            ref={quickAdd}
            lists={lists}
            clock={clock}
            placeholder={
              view.kind === 'list'
                ? `Add to ${title}`
                : 'Add a task: “pay rent every 1st at 9am #home !”'
            }
            onAdd={add}
            onCancel={() => quickAdd.current?.blur()}
          />
        </header>
        {items.length ? (
          <TaskRows
            items={items}
            focus={focus}
            clock={clock}
            lists={state.lists}
            showList={view.kind === 'smart'}
            onFocus={(i) => setFocusId(items[i]!.task.id)}
            onOpen={(i) => setDetailId(items[i]!.task.id)}
            onToggle={(i) => toggle(items[i]!.task)}
          />
        ) : (
          <div className="tasks-empty muted">
            {view.kind === 'smart' && view.key === 'today'
              ? 'Nothing due today.'
              : 'No tasks here.'}{' '}
            Press <kbd className="kbd">C</kbd> to add one.
          </div>
        )}
      </main>
      {detail && (
        <TaskDetail
          key={detail.id}
          task={detail}
          subtasks={[...state.tasks.values()].filter((t) => t.parentId === detail.id)}
          lists={lists}
          clock={clock}
          onPatch={(p) => patch(detail, p)}
          onPickDue={() => setOverlay('due')}
          onPickAlert={() => setOverlay('remind')}
          onAddSubtask={(t) => addSubtask(detail, t)}
          onToggleSubtask={toggle}
          onClose={() => setDetailId(null)}
        />
      )}
      {overlay === 'due' && target && (
        <Picker
          label="Due date"
          placeholder="Due… try “fri 3pm” or “every monday”"
          options={(q) => dueOptions(q, clock, new Date(), (p) => patch(target, p, 'Due date set'))}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'remind' && target && (
        <Picker
          label="Remind me"
          placeholder="Remind me… try “tomorrow 8am”"
          options={(q) =>
            remindOptions(q, clock, new Date(), target.dueDate !== null, (p) =>
              patch(target, p, p.alertAt === null ? 'Alert removed' : 'Alert set'),
            )
          }
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'move' && target && (
        <Picker
          label="Move to list"
          placeholder="Move to…"
          options={(q) =>
            listOptions(
              q,
              lists,
              target.listId,
              (listId) =>
                patch(
                  target,
                  { listId },
                  `Moved to ${listId ? state.lists.get(listId)?.name : 'Inbox'}`,
                ),
              (name) => {
                const list = createList(name)
                patch(target, { listId: list.id }, `Moved to ${name}`)
              },
            )
          }
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'palette' && (
        <Picker
          label="Command palette"
          placeholder="Type a command…"
          options={paletteOptions}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === 'shortcuts' && <Shortcuts onClose={() => setOverlay(null)} />}
      {toast && (
        <div key={toast.key} className="toast" role="status">
          <span className="toast-check" aria-hidden>
            ✓
          </span>
          <span className="toast-text">{toast.text}</span>
          {toast.undo && (
            <button className="toast-undo" onClick={() => store.undo()}>
              Undo <kbd className="kbd">Z</kbd>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function NavItem({
  label,
  count,
  color,
  warn,
  current,
  onClick,
}: {
  label: string
  count: number
  color?: string
  warn?: boolean
  current: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        className="tasks-nav-item"
        aria-current={current ? 'page' : undefined}
        onClick={onClick}
      >
        {color && <span className="list-dot" style={{ background: color }} />}
        <span className="tasks-nav-label">{label}</span>
        {count > 0 && (
          <span className="tasks-nav-count" data-warn={warn || undefined}>
            {count}
          </span>
        )}
      </button>
    </li>
  )
}

const GROUPS = [
  ['navigation', 'Navigation'],
  ['triage', 'Tasks'],
  ['compose', 'Create'],
  ['selection', 'Undo'],
  ['app', 'App'],
] as const

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="cheatsheet"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        {GROUPS.map(([id, label]) => (
          <section key={id}>
            <h2 className="section-label">{label}</h2>
            <dl>
              {tasksKeymap
                .filter((b) => b.group === id)
                .map((b) => (
                  <div key={b.id} className="cheatsheet-row">
                    <dt>{b.label}</dt>
                    <dd>
                      <kbd className="kbd">{displayKeys(b.keys[0]!)}</kbd>
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  )
}
