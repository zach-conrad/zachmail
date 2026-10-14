import type { MessageRow } from '@zachmail/core'
import { accountColor } from '@zachmail/tokens'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useData } from '../data/DataProvider'
import { displayName, longTime, shortTime } from '../lib/format'
import { endInteraction } from '../lib/perf'
import { useCommands } from '../lib/useCommands'
import { Composer } from '../compose/Composer'
import { BodyFrame } from './BodyFrame'

/** The reading pane for one thread. Renders from the main-thread cache when warm. */
export function ThreadView({ threadId, active }: { threadId: string; active: boolean }) {
  const { threads, client, accounts, ownEmails, compose } = useData()
  useSyncExternalStore(threads.subscribe, threads.getVersion)
  useSyncExternalStore(compose.subscribe, compose.getVersion)
  const draft = compose.inline?.threadId === threadId ? compose.inline : null
  const detail = threads.get(threadId)

  useEffect(() => {
    if (!detail) void threads.load(threadId)
  }, [threads, threadId, detail])

  // Latest and unread messages start expanded (design §3.2).
  const [expanded, setExpanded] = useState<Set<string> | null>(null)
  const open =
    expanded ??
    new Set(
      detail?.messages.filter((m, i, all) => m.unread || i === all.length - 1).map((m) => m.id) ??
        [],
    )
  const [images, setImages] = useState<Set<string>>(new Set())

  const missing = detail ? [...open].filter((id) => !detail.bodies[id]) : []
  const hasMissing = missing.length > 0
  useEffect(() => {
    if (hasMissing) void client.api.ensureBodies([threadId])
  }, [client, threadId, hasMissing])

  // "Open thread" ends when every expanded body has laid out.
  const pendingFrames = useRef(0)
  const frames = detail ? [...open].filter((id) => detail.bodies[id]).length : 0
  useLayoutEffect(() => {
    pendingFrames.current = frames
    if (detail && frames === 0 && !hasMissing) endInteraction('nav.open')
  }, [detail, frames, hasMissing])
  const onFrameReady = () => {
    if (--pendingFrames.current <= 0) endInteraction('nav.open')
  }

  useCommands(
    active && detail
      ? { 'nav.expandAll': () => setExpanded(new Set(detail.messages.map((m) => m.id))) }
      : {},
  )

  if (!detail) return <div className="reader" aria-busy="true" />
  const { thread, messages } = detail
  const account = accounts.get(thread.accountId)
  const people = new Set(messages.flatMap((m) => [m.from, ...m.to, ...m.cc]).map((a) => a?.email))

  return (
    <article className="reader" aria-label={thread.subject}>
      <header className="reader-header">
        <h1 className="reader-subject">{thread.subject || '(no subject)'}</h1>
        <p className="reader-meta">
          {account && (
            <span className="account-pill">
              <span className="dot" style={{ background: accountColor(account.color) }} />
              {account.shortName ?? account.email}
            </span>
          )}
          <span>{people.size} participants</span>
        </p>
      </header>
      {messages.map((m) =>
        open.has(m.id) ? (
          <section key={m.id} className="message">
            <MessageHeader m={m} own={ownEmails} />
            {detail.bodies[m.id] ? (
              <>
                {detail.bodies[m.id]!.hasRemoteImages && !images.has(m.id) && (
                  <button
                    className="load-images"
                    onClick={() => setImages((s) => new Set(s).add(m.id))}
                  >
                    Load images
                  </button>
                )}
                <BodyFrame
                  body={detail.bodies[m.id]!}
                  images={images.has(m.id)}
                  onReady={onFrameReady}
                />
              </>
            ) : (
              <p className="message-loading">{m.snippet}</p>
            )}
          </section>
        ) : (
          <button
            key={m.id}
            className="message-collapsed"
            onClick={() => setExpanded(new Set(open).add(m.id))}
          >
            <span className="message-from">{m.from ? displayName(m.from) : 'Unknown'}</span>
            <span className="message-snippet">{m.snippet}</span>
            <time>{shortTime(m.date)}</time>
          </button>
        ),
      )}
      {draft && <Composer key={draft.id} initial={draft} />}
    </article>
  )
}

function MessageHeader({ m, own }: { m: MessageRow; own: ReadonlySet<string> }) {
  const to = [...m.to, ...m.cc].map((a) => (own.has(a.email.toLowerCase()) ? 'me' : displayName(a)))
  return (
    <header className="message-header">
      <span className="message-from" title={m.from?.email}>
        {m.from ? displayName(m.from) : 'Unknown sender'}
      </span>
      <span className="message-to">{to.length ? `to ${to.join(', ')}` : ''}</span>
      <time className="message-date" dateTime={new Date(m.date).toISOString()}>
        {longTime(m.date)}
      </time>
    </header>
  )
}
