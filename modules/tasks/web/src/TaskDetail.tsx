import {
  describeRRule,
  type Clock,
  type Priority,
  type Task,
  type TaskList,
  type TaskPatch,
} from '@zachhub/tasks-core'
import { useState } from 'react'
import { formatAlert, formatDue, listColor } from './format'

const PRIORITIES = ['None', 'Low', 'Medium', 'High'] as const

const REPEATS: { label: string; rrule: string | null }[] = [
  { label: 'Never', rrule: null },
  { label: 'Daily', rrule: 'FREQ=DAILY' },
  { label: 'Weekdays', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Weekly', rrule: 'FREQ=WEEKLY' },
  { label: 'Every 2 weeks', rrule: 'FREQ=WEEKLY;INTERVAL=2' },
  { label: 'Monthly', rrule: 'FREQ=MONTHLY' },
  { label: 'Yearly', rrule: 'FREQ=YEARLY' },
]

/**
 * The task's fields as a definition list (design H4): list, due, alert, repeat, priority, then
 * notes. Edits commit on change (selects) or blur (text), each as one undoable update op.
 */
export function TaskDetail({
  task,
  subtasks,
  lists,
  clock,
  onPatch,
  onPickDue,
  onPickAlert,
  onAddSubtask,
  onToggleSubtask,
  onClose,
}: {
  task: Task
  subtasks: readonly Task[]
  lists: readonly TaskList[]
  clock: Clock
  onPatch: (patch: TaskPatch) => void
  onPickDue: () => void
  onPickAlert: () => void
  onAddSubtask: (title: string) => void
  onToggleSubtask: (task: Task) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [sub, setSub] = useState('')
  const repeat = REPEATS.find((r) => r.rrule === task.rrule)

  return (
    <aside className="task-detail" aria-label="Task details">
      <div className="task-detail-head">
        <input
          className="task-detail-title"
          value={title}
          aria-label="Title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && onPatch({ title: title.trim() })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button className="icon-btn" aria-label="Close details" onClick={onClose}>
          ✕
        </button>
      </div>
      <dl className="task-fields">
        <dt>List</dt>
        <dd>
          <span
            className="list-dot"
            style={{
              background: listColor(lists.find((l) => l.id === task.listId)?.color ?? 'gray'),
            }}
          />
          <select
            value={task.listId ?? ''}
            onChange={(e) => onPatch({ listId: e.target.value || null })}
            aria-label="List"
          >
            <option value="">Inbox</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </dd>
        <dt>Due</dt>
        <dd>
          <button className="field-btn" onClick={onPickDue}>
            {task.dueDate ? formatDue(task.dueDate, task.dueTime, clock) : 'None'}
          </button>
          <kbd className="kbd">D</kbd>
        </dd>
        <dt>Alert</dt>
        <dd>
          <button className="field-btn" onClick={onPickAlert}>
            {task.alertAt !== null ? formatAlert(task.alertAt, clock) : 'None'}
          </button>
          <kbd className="kbd">H</kbd>
        </dd>
        <dt>Repeat</dt>
        <dd>
          <select
            value={repeat ? REPEATS.indexOf(repeat) : 'custom'}
            aria-label="Repeat"
            onChange={(e) => {
              const r = REPEATS[Number(e.target.value)]
              if (r)
                onPatch(
                  r.rrule && !task.dueDate
                    ? { rrule: r.rrule, dueDate: clock.today }
                    : { rrule: r.rrule },
                )
            }}
          >
            {REPEATS.map((r, i) => (
              <option key={r.label} value={i}>
                {r.label}
              </option>
            ))}
            {!repeat && task.rrule && <option value="custom">{describeRRule(task.rrule)}</option>}
          </select>
        </dd>
        <dt>Priority</dt>
        <dd>
          <select
            value={task.priority}
            aria-label="Priority"
            onChange={(e) => onPatch({ priority: Number(e.target.value) as Priority })}
          >
            {PRIORITIES.map((p, i) => (
              <option key={p} value={i}>
                {p}
              </option>
            ))}
          </select>
        </dd>
      </dl>
      {task.parentId === null && (
        <section className="task-subtasks">
          <h3 className="section-label">Subtasks</h3>
          {subtasks.map((s) => (
            <label key={s.id} className="subtask">
              <input
                type="checkbox"
                checked={s.completedAt !== null}
                onChange={() => onToggleSubtask(s)}
              />
              {s.title}
            </label>
          ))}
          <input
            className="subtask-add"
            placeholder="Add subtask"
            value={sub}
            onChange={(e) => setSub(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && sub.trim()) {
                onAddSubtask(sub.trim())
                setSub('')
              }
            }}
          />
        </section>
      )}
      <h3 className="section-label">Notes</h3>
      <textarea
        className="task-notes"
        value={notes}
        placeholder="Add notes"
        aria-label="Notes"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== task.notes && onPatch({ notes })}
      />
    </aside>
  )
}
