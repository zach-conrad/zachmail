import { parseSnoozeTime, snoozeOptions } from '@zachmail/core'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { dueTime } from '../lib/format'
import { useCommands } from '../lib/useCommands'

interface Choice {
  key: string
  label: string
  at: number
}

/**
 * `H` (design §3.6): presets with their resolved times, or a typed time ("in 3 days",
 * "fri 2pm"). Times come from core so every client agrees; nothing here touches the network.
 */
export function SnoozePicker({
  title,
  onPick,
  onClose,
}: {
  title: string
  onPick: (at: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useCommands({ 'nav.back': onClose })

  const presets = useMemo(() => snoozeOptions(new Date()), [])
  const results = useMemo<Choice[]>(() => {
    const q = query.trim().toLowerCase()
    const matching = presets
      .filter((o) => !q || o.label.toLowerCase().includes(q))
      .map((o) => ({ key: o.id, label: o.label, at: o.at }))
    const typed = q ? parseSnoozeTime(q) : null
    if (typed === null || matching.some((m) => m.at === typed)) return matching
    return [{ key: 'typed', label: query.trim(), at: typed }, ...matching]
  }, [presets, query])

  const pick = (c: Choice | undefined) => {
    if (!c) return
    flushSync(onClose)
    onPick(c.at)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const move = (d: number) => {
      e.preventDefault()
      setActive((i) => (results.length ? (i + d + results.length) % results.length : 0))
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1)
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) move(-1)
    else if (e.key === 'Enter') {
      e.preventDefault()
      pick(results[active])
    }
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          placeholder={`${title}… try “in 3 days” or “fri 2pm”`}
          role="combobox"
          aria-expanded="true"
          aria-controls="snooze-results"
          aria-activedescendant={results[active] ? `snooze-${active}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <ul id="snooze-results" className="palette-results" role="listbox">
          {results.length === 0 && (
            <li className="palette-empty">Type a time, like “tomorrow 9am”</li>
          )}
          {results.map((c, i) => (
            <li
              key={c.key}
              id={`snooze-${i}`}
              role="option"
              aria-selected={i === active}
              className="palette-item"
              onMouseMove={() => setActive(i)}
              onClick={() => pick(c)}
            >
              <span>{c.label}</span>
              <span className="palette-meta">{dueTime(c.at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
