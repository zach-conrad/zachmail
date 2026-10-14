import { keymap, type CommandId } from '@zachmail/core'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { fuzzyScore } from '../lib/fuzzy'
import { runCommand } from '../lib/useCommands'
import { Kbd } from './Kbd'

export interface PaletteItem {
  id: string
  label: string
  keys?: string
  run: () => void
}

const RECENTS_KEY = 'zm.recentCommands'
const MAX_RECENTS = 5

function readRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function remember(id: string) {
  try {
    const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, MAX_RECENTS)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    // Storage blocked: recents just don't persist.
  }
}

/**
 * ⌘K (design §3.3): fuzzy search over every command something on screen can run right now,
 * plus `extra` items from the caller, each showing its shortcut so the palette teaches keys.
 */
export function CommandPalette({
  available,
  extra,
  onSearch,
  onClose,
}: {
  /** Commands the views under the palette handle. */
  available: readonly CommandId[]
  extra: PaletteItem[]
  /** Free text falls through to a mail search (design §3.3). */
  onSearch?: (query: string) => void
  onClose: () => void
}) {
  const [items] = useState<PaletteItem[]>(() => [
    ...keymap
      .filter((b) => b.id !== 'app.palette' && b.id !== 'nav.back' && available.includes(b.id))
      .map((b) => ({
        id: b.id,
        label: b.label,
        keys: b.keys[0],
        run: () => runCommand(b.id),
      })),
    ...extra,
  ])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const results = useMemo(() => {
    if (!query.trim()) {
      const recents = readRecents()
      const rank = (id: string) => {
        const i = recents.indexOf(id)
        return i < 0 ? MAX_RECENTS : i
      }
      return [...items].sort((a, b) => rank(a.id) - rank(b.id))
    }
    const matched = items
      .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item)
    if (!onSearch) return matched
    const searchItem: PaletteItem = {
      id: 'search',
      label: `Search mail for “${query.trim()}”`,
      keys: '/',
      run: () => onSearch(query.trim()),
    }
    // No command matches: Enter searches. Otherwise searching is the last choice.
    return matched.length ? [...matched, searchItem] : [searchItem]
  }, [items, query, onSearch])

  const run = (item: PaletteItem | undefined) => {
    if (!item) return
    remember(item.id)
    // Close first so the views under the palette are active again when the command runs.
    flushSync(onClose)
    item.run()
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
      run(results[active])
    }
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          placeholder="Type a command…"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        <ul id="palette-results" className="palette-results" role="listbox">
          {results.length === 0 && <li className="palette-empty">No matching commands</li>}
          {results.map((item, i) => (
            <li
              key={item.id}
              id={`cmd-${item.id}`}
              role="option"
              aria-selected={i === active}
              className="palette-item"
              onMouseMove={() => setActive(i)}
              onClick={() => run(item)}
            >
              <span>{item.label}</span>
              {item.keys && <Kbd keys={item.keys} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
