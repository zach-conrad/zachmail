import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Kbd } from '../app/Kbd'
import { useHub } from '../app/HubShell'
import { useData } from '../data/DataProvider'
import { lastMailSplit } from '../hub/modules'
import { mailTodayCards } from '../mail/today'
import { endInteraction, markOnce } from '../lib/perf'
import { useCommands } from '../lib/useCommands'
import type { TodayCard, TodayContext, TodayRow } from './contributions'

// Card order on Today (design H3). Tasks goes first and Docs last once they contribute.
const todayCards: readonly TodayCard[] = [...mailTodayCards]

const GO_KEYS = { mail: 'g m', tasks: 'g t', docs: 'g d' } as const

const dateHeader = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

const endOfDay = (now: number) => new Date(now).setHours(24, 0, 0, 0)

/**
 * Today (ZachHub design H3): the date, one summary line, then each module's card, all from
 * the local replica. J/K move through every row across cards, Enter opens it.
 */
export function TodayModule() {
  const { client, accounts, ownEmails } = useData()
  const hub = useHub()
  const navigate = useNavigate()
  const [rows, setRows] = useState<Record<string, TodayRow[]> | null>(null)
  const [focus, setFocus] = useState(-1)
  const [now, setNow] = useState(() => Date.now())

  useLayoutEffect(() => endInteraction('go.today'), [])

  // Load every card together so they appear in one paint, then again after sync changes.
  // A burst of changes (an op queue draining) coalesces into one re-read after the one in
  // flight, and nothing cancels a read in flight: the first paint must not wait for a busy
  // sync to finish.
  const people = useRef({ accounts, ownEmails })
  const reread = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    people.current = { accounts, ownEmails }
  })
  // Accounts arriving re-colors the dots; a re-read is cheap (a handful of rows).
  useEffect(() => reread.current(), [accounts, ownEmails])
  useEffect(() => {
    let live = true
    let running = false
    let again = false
    const read = async () => {
      if (running) return void (again = true)
      running = true
      try {
        do {
          again = false
          const at = Date.now()
          const ctx: TodayContext = {
            client,
            ...people.current,
            now: at,
            endOfDay: endOfDay(at),
            openMailThread: (id) =>
              void navigate({
                to: '/inbox/$split',
                params: { split: lastMailSplit() },
                search: { thread: id },
              }),
          }
          const loaded = await Promise.all(
            todayCards.map((c) => c.load(ctx).catch(() => [] as TodayRow[])),
          )
          if (!live) return
          setNow(at)
          setRows(Object.fromEntries(todayCards.map((c, i) => [c.id, loaded[i]!])))
        } while (again)
      } finally {
        running = false
      }
    }
    reread.current = () => void read()
    void read()
    const off = client.subscribe((e) => void (e.type === 'changed' && read()))
    return () => {
      live = false
      reread.current = () => {}
      off()
    }
  }, [client, navigate])

  useEffect(() => {
    if (rows) markOnce('today-ready')
  }, [rows])

  const flat = useMemo(() => todayCards.flatMap((c) => rows?.[c.id] ?? []), [rows])
  const focusedId = flat[focus]?.id
  const move = (d: number) =>
    setFocus((i) => (flat.length ? Math.max(0, Math.min(flat.length - 1, i + d)) : -1))

  useCommands(
    hub.overlayOpen
      ? {}
      : {
          'nav.next': () => move(1),
          'nav.prev': () => move(-1),
          ...(flat[focus] ? { 'nav.open': () => flat[focus]!.open() } : {}),
        },
  )

  const summary = todayCards
    .map((c) => (rows && c.summary ? c.summary(rows[c.id] ?? []) : null))
    .filter(Boolean)
    .join(' · ')

  return (
    <main className="today" aria-label="Today">
      <header className="today-header">
        <h1 className="display">{dateHeader.format(now)}</h1>
        <p className="muted today-summary">{rows ? summary || 'All clear.' : ' '}</p>
      </header>
      <div className="today-cards">
        {todayCards.map((card) => {
          const cardRows = rows?.[card.id]
          return (
            <section key={card.id} className="today-card" aria-label={card.title}>
              <header className="today-card-head">
                <h2 className="section-label">{card.title}</h2>
                <ModuleLink module={card.module} />
              </header>
              {cardRows && cardRows.length === 0 && <p className="today-empty">{card.empty}</p>}
              {cardRows && cardRows.length > 0 && (
                <ul className="today-rows">
                  {cardRows.map((r) => (
                    <li key={r.id}>
                      <button
                        className="today-row"
                        data-focused={r.id === focusedId || undefined}
                        data-unread={r.bold || undefined}
                        data-tone={r.tone}
                        onClick={r.open}
                      >
                        <span className="dot" style={{ background: r.color ?? 'transparent' }} />
                        <span className="row-sender">{r.primary}</span>
                        <span className="row-subject">{r.secondary}</span>
                        <span className="today-meta">
                          {r.tone === 'warning' && <ClockGlyph />}
                          {r.meta}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </main>
  )
}

function ModuleLink({ module }: { module: TodayCard['module'] }) {
  const label = { mail: 'Mail', tasks: 'Tasks', docs: 'Docs' }[module]
  const body = (
    <>
      Open {label} <Kbd keys={GO_KEYS[module]} />
    </>
  )
  return module === 'mail' ? (
    <Link className="today-card-link" to="/inbox/$split" params={{ split: lastMailSplit() }}>
      {body}
    </Link>
  ) : (
    <Link className="today-card-link" to={`/${module}`}>
      {body}
    </Link>
  )
}

function ClockGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.6V8l2.2 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
