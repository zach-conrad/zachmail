import { highlightTokens, parseQuery } from '@zachhub/core'
import type { SearchListQuery } from '@zachhub/local-store'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Kbd } from '../app/Kbd'
import { useData } from '../data/DataProvider'
import { Inbox } from '../inbox/Inbox'
import { beginInteraction } from '../lib/perf'
import { useCommands } from '../lib/useCommands'

/** Server search waits for a pause in typing; local results never wait. */
const REMOTE_DEBOUNCE_MS = 250

const OPERATORS = [
  'from:',
  'to:',
  'subject:',
  'has:attachment',
  'is:unread',
  'is:starred',
  'in:done',
  'label:',
  'account:',
  'before:',
  'after:',
]

type Remote =
  | { state: 'idle' }
  | { state: 'loading'; source: 'mirror' | 'provider' }
  | { state: 'more'; cursor: string; source: 'mirror' | 'provider' }
  | { state: 'done' }
  | { state: 'error' }

/**
 * Search (design §3.5): results replace the list, from the local index on every keystroke,
 * then from the server (and Gmail, for mail older than the server's copy) underneath.
 */
export function SearchView({
  initial,
  active,
  onExit,
}: {
  initial: string
  active: boolean
  onExit: () => void
}) {
  const { client } = useData()
  const [text, setText] = useState(initial)
  // Server progress, tagged with the query it is for; a new query starts out loading.
  const [tagged, setTagged] = useState<{ key: string; remote: Remote }>({
    key: '',
    remote: { state: 'idle' },
  })
  const input = useRef<HTMLInputElement>(null)
  const tzOffset = useMemo(() => new Date().getTimezoneOffset(), [])
  const view = useMemo<SearchListQuery>(() => ({ search: text.trim(), tzOffset }), [text, tzOffset])
  const parsed = useMemo(() => parseQuery(view.search, { tzOffset }), [view, tzOffset])
  const highlight = useMemo(() => highlightTokens(parsed), [parsed])
  const searchable = parsed.clauses.length > 0
  const key = JSON.stringify(view)
  const remote: Remote =
    tagged.key === key
      ? tagged.remote
      : searchable
        ? { state: 'loading', source: 'mirror' }
        : { state: 'idle' }

  useEffect(() => {
    void client.api.warmSearch()
  }, [client])

  // Latest request wins; older answers are dropped.
  const req = useRef(0)
  const fetchPage = (q: SearchListQuery, cursor: string | null, source: 'mirror' | 'provider') => {
    const id = ++req.current
    const k = JSON.stringify(q)
    const set = (remote: Remote) => setTagged({ key: k, remote })
    set({ state: 'loading', source })
    client.api.searchRemote(q, cursor).then(
      (r) => {
        if (id !== req.current) return
        if (!r.cursor) return set({ state: 'done' })
        // The server copy is exhausted and Gmail is next: go straight on, that's the point.
        if (r.found === 0) return fetchPage(q, r.cursor, 'provider')
        set({ state: 'more', cursor: r.cursor, source: r.source })
      },
      () => id === req.current && set({ state: 'error' }),
    )
  }

  useEffect(() => {
    req.current++
    if (!searchable) return
    const t = setTimeout(() => fetchPage(view, null, 'mirror'), REMOTE_DEBOUNCE_MS)
    return () => clearTimeout(t)
    // fetchPage only closes over stable refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, searchable])

  const more = () => {
    if (remote.state === 'more') fetchPage(view, remote.cursor, remote.source)
  }

  useCommands(
    active
      ? {
          'nav.search': () => {
            input.current?.focus()
            input.current?.select()
          },
        }
      : {},
  )

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter or ↓ hands the keyboard to the results (j/k, e, Enter to open).
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault()
      input.current?.blur()
    }
  }

  const status =
    remote.state === 'loading'
      ? remote.source === 'provider'
        ? 'Searching older mail in Gmail…'
        : 'Searching all mail…'
      : remote.state === 'error'
        ? 'Couldn’t reach the server; showing mail on this device'
        : null

  return (
    <div className="search-view">
      <div className="search-bar">
        <span className="search-icon" aria-hidden>
          ⌕
        </span>
        <input
          ref={input}
          autoFocus
          className="search-input"
          placeholder="Search mail"
          aria-label="Search mail"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            beginInteraction('search.type', e.timeStamp)
            setText(e.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        {status && <span className="search-status muted">{status}</span>}
        {remote.state === 'more' && (
          <button className="search-more" onClick={more}>
            {remote.source === 'provider' ? 'More from Gmail' : 'More results'}
          </button>
        )}
        <Kbd keys="escape" />
      </div>
      <div className="search-results">
        <Inbox
          view={view}
          active={active}
          onExit={onExit}
          highlight={highlight}
          empty={
            <div className="search-empty muted">
              {!searchable ? (
                <>
                  <p>Search every account. Operators:</p>
                  <p className="search-operators">
                    {OPERATORS.map((op) => (
                      <code key={op}>{op}</code>
                    ))}
                  </p>
                </>
              ) : remote.state === 'loading' ? (
                <p>Searching…</p>
              ) : remote.state === 'more' ? (
                <button className="search-more" onClick={more}>
                  Search older mail
                </button>
              ) : (
                <p>No results</p>
              )}
            </div>
          }
        />
      </div>
    </div>
  )
}
