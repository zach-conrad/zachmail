import type { FollowUpItem } from '@zachmail/local-store'
import { useEffect, useLayoutEffect, useState } from 'react'
import { Kbd } from '../app/Kbd'
import { replyDraft } from '../compose/draft'
import { useData } from '../data/DataProvider'
import { displayName, shortTime } from '../lib/format'
import { useCommands } from '../lib/useCommands'

const DAY = 86_400_000

/**
 * Follow-ups (g f): sends where Zach wrote last and nobody has answered for a few days, read
 * from the local replica. Enter writes a follow-up, E dismisses until the thread moves.
 */
export function FollowUps({ onClose }: { onClose: () => void }) {
  const { client, compose, ownEmails } = useData()
  const [items, setItems] = useState<FollowUpItem[] | null>(null)
  const [now, setNow] = useState(0)
  const [focus, setFocus] = useState(0)

  useEffect(() => {
    let live = true
    const load = () => {
      const at = Date.now()
      void client.api.followUps(at).then((rows) => {
        if (!live) return
        setNow(at)
        setItems(rows)
      })
    }
    load()
    const off = client.subscribe((e) => e.type === 'changed' && load())
    return () => {
      live = false
      off()
    }
  }, [client])

  const list = items ?? []
  const current = list[Math.min(focus, list.length - 1)]

  useLayoutEffect(() => {
    document
      .querySelector('.followup-row[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const followUp = (item = current) => {
    if (!item) return
    void client.api.getThread(item.threadId).then((detail) => {
      if (!detail) return
      const resumed = compose.resume(item.threadId)
      compose.open(resumed ?? { ...replyDraft(detail, 'replyAll', ownEmails), sheet: true })
      onClose()
    })
  }

  const dismiss = (item = current) => {
    if (!item) return
    setItems(list.filter((i) => i.threadId !== item.threadId))
    client.dismissNudges([item.threadId], true)
  }

  useCommands({
    'nav.next': () => setFocus((f) => Math.min(f + 1, list.length - 1)),
    'nav.prev': () => setFocus((f) => Math.max(f - 1, 0)),
    'nav.open': () => followUp(),
    'thread.done': () => dismiss(),
    'nudge.dismiss': () => dismiss(),
    'nav.back': onClose,
  })

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="followups"
        role="dialog"
        aria-label="Follow-ups"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="followups-head">
          <h2 className="section-label">Follow-ups</h2>
          <span className="muted">
            <Kbd keys="enter" /> follow up · <Kbd keys="e" /> dismiss
          </span>
        </header>
        {items && !list.length && <p className="palette-empty">Nobody owes you a reply. Nice.</p>}
        <ul className="palette-results" role="listbox">
          {list.map((item, i) => (
            <li
              key={item.threadId}
              className="followup-row"
              role="option"
              aria-selected={item === current}
              onMouseEnter={() => setFocus(i)}
              onClick={() => followUp(item)}
            >
              <span className="followup-who">{item.waitingOn.map(displayName).join(', ')}</span>
              <span className="followup-subject">{item.thread.subject || '(no subject)'}</span>
              <span className="muted">
                {Math.floor((now - item.sentAt) / DAY)}d · {shortTime(item.sentAt, now)}
              </span>
              <button
                type="button"
                className="compose-link"
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(item)
                }}
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
