import { formatKeys } from '@zachhub/core'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { isApple } from './keys'

export interface PickerOption {
  id: string
  label: string
  hint?: string
  keys?: string
  color?: string
  run: () => void
}

export const displayKeys = (keys: string) =>
  formatKeys(keys.replace(/arrowup/g, '↑').replace(/arrowdown/g, '↓'), isApple)

/**
 * The one popover behind the due-date (D), remind (H), move (L) and ⌘K pickers: a text field
 * over a list of options computed from what's typed. Arrows move, Enter picks, Esc closes.
 */
export function Picker({
  label,
  placeholder,
  options,
  onClose,
}: {
  label: string
  placeholder: string
  options: (query: string) => PickerOption[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => options(query), [options, query])

  const pick = (o: PickerOption | undefined) => {
    if (!o) return
    onClose()
    o.run()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const move = (d: number) => {
      e.preventDefault()
      setActive((i) => (results.length ? (i + d + results.length) % results.length : 0))
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1)
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) move(-1)
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      pick(results[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          placeholder={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls="picker-results"
          aria-activedescendant={results[active] ? `pick-${results[active].id}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <ul id="picker-results" className="palette-results" role="listbox">
          {results.length === 0 && <li className="palette-empty">Nothing matches</li>}
          {results.map((o, i) => (
            <li
              key={o.id}
              id={`pick-${o.id}`}
              role="option"
              aria-selected={i === active}
              className="palette-item"
              onMouseMove={() => setActive(i)}
              onClick={() => pick(o)}
            >
              <span>
                {o.color && <span className="list-dot" style={{ background: o.color }} />}
                {o.label}
              </span>
              {o.hint && <span className="muted picker-hint">{o.hint}</span>}
              {o.keys && <kbd className="kbd">{displayKeys(o.keys)}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Case-insensitive subsequence match, best (earliest, tightest) first; -1 when no match. */
export function fuzzy(query: string, label: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const l = label.toLowerCase()
  const at = l.indexOf(q)
  if (at >= 0) return 1000 - at
  let i = 0
  let score = 0
  for (let j = 0; j < l.length && i < q.length; j++) {
    if (l[j] !== q[i]) continue
    i++
    score += 10 - Math.min(9, j)
  }
  return i === q.length ? score : -1
}
