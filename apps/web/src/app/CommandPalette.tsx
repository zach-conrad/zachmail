import { keymap, type CommandGroup, type CommandId } from '@zachhub/core'
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import {
  GROUP_LABEL,
  GROUP_ORDER,
  paletteExtras,
  scopeQuery,
  type PaletteGroup,
  type PaletteItem,
  type PaletteSource,
} from '../hub/palette'
import { fuzzyScore } from '../lib/fuzzy'
import { runCommand } from '../lib/useCommands'
import { Kbd } from './Kbd'

export type { PaletteItem }

const RECENTS_KEY = 'zm.recentCommands'
const MAX_RECENTS = 5
const OPERATORS = ['in:tasks', 'type:pdf', 'due:today']

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

type Found = { key: string; groups: Partial<Record<PaletteGroup, PaletteItem[]>> }

/**
 * Universal ⌘K (ZachHub design H6): one palette over every module. As you type, each
 * module's source adds its matches from the local replica, grouped Tasks · Docs · Mail, then
 * the commands something on screen can run right now, each showing its shortcut.
 */
export function CommandPalette({
  available,
  sources,
  only,
  onClose,
}: {
  /** Commands the views under the palette handle. */
  available: readonly CommandId[]
  sources: readonly PaletteSource[]
  /** Show only this group of commands, with no search (the rail's Settings button). */
  only?: CommandGroup
  onClose: () => void
}) {
  const [commands] = useState<PaletteItem[]>(() => [
    ...keymap
      .filter(
        (b) =>
          b.id !== 'app.palette' &&
          b.id !== 'nav.back' &&
          available.includes(b.id) &&
          (!only || b.group === only),
      )
      .map((b) => ({
        id: b.id,
        label: b.label,
        keys: b.keys[0],
        run: () => runCommand(b.id),
      })),
    ...(only ? [] : paletteExtras()),
  ])
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const scoped = useMemo(() => scopeQuery(query), [query])
  const key = `${scoped.group ?? ''}|${scoped.text}`
  const [found, setFound] = useState<Found>({ key: '', groups: {} })

  // Each source answers on its own; a stale answer (an older keystroke's) is dropped.
  useEffect(() => {
    if (only || !scoped.text) return
    let live = true
    for (const s of sources) {
      if (scoped.group && scoped.group !== s.module) continue
      void s.search(scoped.text).then(
        (items) => {
          if (!live) return
          setFound((f) => ({
            key,
            groups: { ...(f.key === key ? f.groups : {}), [s.module]: items },
          }))
        },
        () => {},
      )
    }
    return () => {
      live = false
    }
  }, [sources, scoped, key, only])

  const sections = useMemo(() => {
    const out: { group: PaletteGroup; items: PaletteItem[] }[] = []
    const text = scoped.text
    if (!text) {
      const recents = readRecents()
      const rank = (id: string) => {
        const i = recents.indexOf(id)
        return i < 0 ? MAX_RECENTS : i
      }
      if (!scoped.group || scoped.group === 'commands')
        out.push({
          group: 'commands',
          items: [...commands].sort((a, b) => rank(a.id) - rank(b.id)),
        })
      return out
    }
    const groups = found.key === key ? found.groups : {}
    for (const g of GROUP_ORDER) {
      if (scoped.group && scoped.group !== g) continue
      let items: PaletteItem[]
      if (g === 'commands') {
        items = commands
          .map((item) => ({ item, score: fuzzyScore(text, item.label) }))
          .filter((r) => r.score >= 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.item)
        // Free text always has somewhere to go: the sources' fallbacks come last.
        for (const s of sources)
          if (s.fallback && (!scoped.group || scoped.group === s.module))
            items.push(s.fallback(text))
      } else items = groups[g] ?? []
      if (items.length) out.push({ group: g, items })
    }
    return out
  }, [commands, sources, found, key, scoped])

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const activeIndex = Math.max(
    0,
    flat.findIndex((i) => i.id === activeId),
  )
  const active = flat[activeIndex]

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
      if (flat.length) setActiveId(flat[(activeIndex + d + flat.length) % flat.length]!.id)
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1)
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) move(-1)
    else if (e.key === 'Enter') {
      e.preventDefault()
      run(active)
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
          placeholder={only ? 'Settings' : 'Search everything or run a command…'}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={active ? `cmd-${active.id}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveId(null)
          }}
          onKeyDown={onKeyDown}
        />
        <ul id="palette-results" className="palette-results" role="listbox">
          {flat.length === 0 && <li className="palette-empty">No matches</li>}
          {sections.map((s) => (
            <Fragment key={s.group}>
              {(sections.length > 1 || s.group !== 'commands') && (
                <li className="palette-group" role="presentation">
                  {GROUP_LABEL[s.group]}
                </li>
              )}
              {s.items.map((item) => (
                <li
                  key={item.id}
                  id={`cmd-${item.id}`}
                  role="option"
                  aria-selected={item === active}
                  className="palette-item"
                  onMouseMove={() => setActiveId(item.id)}
                  onClick={() => run(item)}
                >
                  <span className="palette-label">
                    {item.label}
                    {item.detail && <span className="palette-detail">{item.detail}</span>}
                  </span>
                  {item.keys && <Kbd keys={item.keys} />}
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
        {!only && (
          <div className="palette-footer" aria-hidden>
            {OPERATORS.map((op) => (
              <code key={op}>{op}</code>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
