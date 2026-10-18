import { DEFAULT_UNDO_MS, type Address, type ContactRow } from '@zachhub/core'
import { accountColor } from '@zachhub/tokens'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Kbd } from '../app/Kbd'
import { useData } from '../data/DataProvider'
import { endInteraction } from '../lib/perf'
import { SnoozePicker } from '../inbox/SnoozePicker'
import { dueTime } from '../lib/format'
import { useCommands } from '../lib/useCommands'
import { isEmpty, recipientCount, toDraftRequest, toSendRequest, type Draft } from './draft'
import { RecipientField } from './RecipientField'

const SAVE_DELAY_MS = 1500

const OPEN_COMMAND = {
  new: 'compose.new',
  reply: 'compose.reply',
  replyAll: 'compose.replyAll',
  forward: 'compose.forward',
} as const

/**
 * One draft being written: a centered sheet for new mail, an inline panel under the thread for
 * replies and forwards (design §3.4). Saves to the provider a moment after typing stops; Esc
 * closes and keeps the draft, ⌘Enter sends with an undo window.
 */
export function Composer({ initial }: { initial: Draft }) {
  const { client, triage, compose, accounts } = useData()
  const [d, setD] = useState(initial)
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0)
  const [error, setError] = useState<string | null>(null)
  const [contacts, setContacts] = useState<readonly ContactRow[]>([])
  const [reminding, setReminding] = useState(false)
  const saved = useRef(false)
  const dirty = useRef(false)
  const latest = useRef(d)
  const sheet = d.kind === 'new'

  useLayoutEffect(() => {
    latest.current = d
  })
  useLayoutEffect(() => endInteraction(OPEN_COMMAND[initial.kind]), [initial.kind])

  useEffect(() => {
    let live = true
    void compose.loadContacts().then((c) => live && setContacts(c))
    return () => {
      live = false
    }
  }, [compose])

  const save = () => {
    const cur = latest.current
    if (!dirty.current || isEmpty(cur)) return
    dirty.current = false
    client.api.saveDraft(cur.id, toDraftRequest(cur)).then(
      () => (saved.current = true),
      () => (dirty.current = true),
    )
  }

  // Autosave after a pause in typing.
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(save, SAVE_DELAY_MS)
    return () => clearTimeout(t)
    // `save` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d])

  const update = (patch: Partial<Draft>) => {
    dirty.current = true
    setError(null)
    setD((cur) => ({ ...cur, ...patch }))
  }

  const close = () => {
    save()
    compose.close(latest.current, true)
  }

  const discard = () => {
    if (saved.current) void client.api.deleteDraft(d.id).catch(() => {})
    compose.close(d, false)
  }

  const send = () => {
    if (!recipientCount(d)) return setError('Add at least one recipient')
    if (!d.text.trim() && !d.quoted && !d.subject.trim()) return setError('Write something first')
    const req = toSendRequest(d, DEFAULT_UNDO_MS, saved.current)
    const what = d.subject.trim() || '(no subject)'
    compose.close(d, false)
    triage.sendMail(req, `Sending “${what}”`, () => compose.open(d))
  }

  useCommands(
    reminding
      ? {}
      : {
          'compose.send': send,
          'compose.remind': () =>
            d.remindAt ? update({ remindAt: undefined }) : setReminding(true),
          'nav.back': close,
        },
  )

  const account = accounts.get(d.accountId)
  const fromChoices = [...accounts.values()]

  return (
    <div
      className={sheet ? 'compose-backdrop' : undefined}
      onMouseDown={sheet ? (e) => e.target === e.currentTarget && close() : undefined}
    >
      <section
        className={sheet ? 'compose compose-sheet' : 'compose compose-inline'}
        role="dialog"
        aria-label={sheet ? 'New message' : d.kind === 'forward' ? 'Forward' : 'Reply'}
      >
        {sheet && fromChoices.length > 1 && (
          <label className="compose-field">
            <span className="compose-label">From</span>
            <span
              className="dot"
              style={{ background: account ? accountColor(account.color) : 'transparent' }}
            />
            <select value={d.accountId} onChange={(e) => update({ accountId: e.target.value })}>
              {fromChoices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <RecipientField
          label="To"
          value={d.to}
          onChange={(v: Address[]) => update({ to: v })}
          contacts={contacts}
          autoFocus={d.kind === 'new' || d.kind === 'forward'}
        />
        {showCc ? (
          <>
            <RecipientField
              label="Cc"
              value={d.cc}
              onChange={(v: Address[]) => update({ cc: v })}
              contacts={contacts}
            />
            <RecipientField
              label="Bcc"
              value={d.bcc}
              onChange={(v: Address[]) => update({ bcc: v })}
              contacts={contacts}
            />
          </>
        ) : (
          <button type="button" className="compose-link" onClick={() => setShowCc(true)}>
            Cc / Bcc
          </button>
        )}
        {d.kind !== 'reply' && d.kind !== 'replyAll' && (
          <label className="compose-field">
            <span className="compose-label">Subject</span>
            <input value={d.subject} onChange={(e) => update({ subject: e.target.value })} />
          </label>
        )}
        <textarea
          className="compose-body"
          aria-label="Message"
          autoFocus={d.kind === 'reply' || d.kind === 'replyAll'}
          value={d.text}
          onChange={(e) => update({ text: e.target.value })}
        />
        {d.quoted && (
          <details className="compose-quoted">
            <summary>Forwarded message</summary>
            {/* Server-sanitized HTML from the replica, shown as text-only preview. */}
            <p className="muted">{previewText(d.quoted)}</p>
          </details>
        )}
        <footer className="compose-footer">
          <button type="button" className="send" onClick={send}>
            Send <Kbd keys="mod+enter" />
          </button>
          {d.remindAt ? (
            <button
              type="button"
              className="compose-link compose-remind"
              title="Remove reminder"
              onClick={() => update({ remindAt: undefined })}
            >
              ⏰ If no reply by {dueTime(d.remindAt)} ×
            </button>
          ) : (
            <button type="button" className="compose-link" onClick={() => setReminding(true)}>
              Remind me <Kbd keys="mod+shift+r" />
            </button>
          )}
          {error && (
            <span className="compose-error" role="alert">
              {error}
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="compose-link" onClick={discard}>
            Discard
          </button>
          <button type="button" className="compose-link" onClick={close}>
            Close <Kbd keys="escape" />
          </button>
        </footer>
      </section>
      {reminding && (
        <SnoozePicker
          title="Remind me if no reply"
          onPick={(at) => update({ remindAt: at })}
          onClose={() => setReminding(false)}
        />
      )}
    </div>
  )
}

function previewText(html: string): string {
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 400)
}
