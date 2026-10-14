import type { SnippetRow } from '@zachmail/core'
import type { KeyboardEvent } from 'react'

export interface MenuState {
  /** Typed after `;` (trigger) or into the picker's search box (⌘;). */
  query: string
  /** Text range the snippet replaces: the `;query`, or the caret for the picker. */
  start: number
  end: number
  active: number
  source: 'trigger' | 'picker'
}

/**
 * Arrow keys / Enter / Tab / Esc for the snippet menu. Returns true when it consumed the key;
 * preventDefault keeps Esc from also closing the composer.
 */
export function menuKey(
  e: KeyboardEvent,
  menu: MenuState,
  count: number,
  set: (m: MenuState | null) => void,
  pick: (i: number) => void,
): boolean {
  const go = (active: number) => set({ ...menu, active: (active + count) % count })
  if (e.key === 'Escape') set(null)
  else if (!count) return false
  else if (e.key === 'ArrowDown') go(menu.active + 1)
  else if (e.key === 'ArrowUp') go(menu.active - 1)
  else if (e.key === 'Enter' || e.key === 'Tab') pick(menu.active)
  else return false
  e.preventDefault()
  return true
}

/** The snippet list under the body (design §3.4). */
export function SnippetMenu({
  menu,
  matches,
  onQuery,
  onKey,
  onPick,
}: {
  menu: MenuState
  matches: readonly SnippetRow[]
  onQuery: (q: string) => void
  onKey: (e: KeyboardEvent) => void
  onPick: (i: number) => void
}) {
  return (
    <div className="snippet-menu" role="dialog" aria-label="Snippets">
      {menu.source === 'picker' && (
        <input
          className="snippet-search"
          autoFocus
          placeholder="Search snippets"
          value={menu.query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKey}
        />
      )}
      {matches.length ? (
        <ul role="listbox">
          {matches.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === menu.active}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(i)
              }}
            >
              <span>{s.name}</span>
              {s.shortcut && <span className="muted">;{s.shortcut}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="snippet-empty muted">
          {menu.query
            ? 'No matching snippets'
            : 'No snippets yet. Add some from ⌘K → Edit snippets.'}
        </p>
      )}
    </div>
  )
}
