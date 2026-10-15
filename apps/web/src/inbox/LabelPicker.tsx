import { useMemo, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { fuzzyScore } from '../lib/fuzzy'
import { useCommands } from '../lib/useCommands'

export interface LabelChoice {
  name: string
  /** Every target thread already has it (picking it again removes it in label mode). */
  on: boolean
}

/** `l` and `v` (design §3.1): fuzzy-pick a label to toggle, or a label to move to. */
export function LabelPicker({
  mode,
  choices,
  onPick,
  onClose,
}: {
  mode: 'label' | 'move'
  choices: LabelChoice[]
  onPick: (name: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useCommands({ 'nav.back': onClose })

  const results = useMemo(
    () =>
      query.trim()
        ? choices
            .map((c) => ({ c, score: fuzzyScore(query, c.name) }))
            .filter((r) => r.score >= 0)
            .sort((a, b) => b.score - a.score)
            .map((r) => r.c)
        : choices,
    [choices, query],
  )

  const pick = (c: LabelChoice | undefined) => {
    if (!c) return
    flushSync(onClose)
    onPick(c.name)
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

  const title = mode === 'move' ? 'Move to' : 'Label'
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
          placeholder={mode === 'move' ? 'Move to label…' : 'Add or remove label…'}
          role="combobox"
          aria-expanded="true"
          aria-controls="label-results"
          aria-activedescendant={results[active] ? `label-${active}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <ul id="label-results" className="palette-results" role="listbox">
          {results.length === 0 && <li className="palette-empty">No matching labels</li>}
          {results.map((c, i) => (
            <li
              key={c.name}
              id={`label-${i}`}
              role="option"
              aria-selected={i === active}
              aria-checked={mode === 'label' ? c.on : undefined}
              className="palette-item"
              onMouseMove={() => setActive(i)}
              onClick={() => pick(c)}
            >
              <span>{c.name}</span>
              {mode === 'label' && c.on && <span aria-hidden>✓</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
