import {
  DEFAULT_UNDO_MS,
  findSnippetTrigger,
  matchSnippets,
  type Address,
  type ContactRow,
} from '@zachhub/core'
import { accountColor } from '@zachhub/tokens'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Kbd } from '../app/Kbd'
import { useData } from '../data/DataProvider'
import { endInteraction } from '../lib/perf'
import { useCommands } from '../lib/useCommands'
import { isEmpty, recipientCount, toDraftRequest, toSendRequest, type Draft } from './draft'
import { applyIntro, applySnippet } from './extras'
import { RecipientField } from './RecipientField'
import { SnippetMenu, menuKey, type MenuState } from './SnippetMenu'

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
  const { client, triage, compose, accounts, ownEmails, snippets } = useData()
  const [d, setD] = useState(initial)
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [contacts, setContacts] = useState<readonly ContactRow[]>([])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const body = useRef<HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  const matches = useMemo(() => (menu ? matchSnippets(menu.query, snippets) : []), [menu, snippets])
  const saved = useRef(false)
  const dirty = useRef(false)
  const latest = useRef(d)
  const sheet = d.kind === 'new' || !!d.sheet

  useLayoutEffect(() => {
    latest.current = d
  })
  useLayoutEffect(() => endInteraction(OPEN_COMMAND[initial.kind]), [initial.kind])
  // Put the caret after inserted text once React has written it.
  useLayoutEffect(() => {
    if (caret.current === null || !body.current) return
    body.current.focus()
    body.current.setSelectionRange(caret.current, caret.current)
    caret.current = null
  })

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

  const onBody = (text: string, at: number) => {
    update({ text })
    setNotice(null)
    const t = snippets.length ? findSnippetTrigger(text.slice(0, at)) : null
    setMenu(t ? { query: t.query, start: t.start, end: at, active: 0, source: 'trigger' } : null)
  }

  const pickSnippet = (i: number) => {
    const s = matches[i]
    if (!menu || !s) return
    const account = accounts.get(d.accountId)
    const from = account && { email: account.email, name: account.displayName ?? undefined }
    const r = applySnippet(d, s, menu.start, menu.end, from)
    update(r.patch)
    if (r.patch.cc?.length || r.patch.bcc?.length) setShowCc(true)
    caret.current = r.caret
    setMenu(null)
    if (r.missing.length) setNotice(`Fill in: ${r.missing.join(', ').replace(/_/g, ' ')}`)
  }

  const onMenuKey = (e: KeyboardEvent) => {
    if (menu) menuKey(e, menu, matches.length, setMenu, pickSnippet)
  }

  const openPicker = () => {
    const at = body.current?.selectionStart ?? d.text.length
    setMenu({
      query: '',
      start: at,
      end: body.current?.selectionEnd ?? at,
      active: 0,
      source: 'picker',
    })
  }

  const intro = () => {
    if (!d.threadId || !d.replyToMessageId) return setNotice('Instant intro works on a reply')
    const id = d.replyToMessageId
    void client.api.getThread(d.threadId).then((detail) => {
      const m = detail?.messages.find((x) => x.id === id)
      const patch = m && applyIntro(latest.current, m, ownEmails)
      if (!patch) return setNotice('Nobody to hand this intro off to')
      update(patch)
      setShowCc(true)
      setNotice(null)
    })
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

  useCommands({
    'compose.send': send,
    'nav.back': close,
    'compose.snippets': openPicker,
    'compose.instantIntro': intro,
  })

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
          ref={body}
          className="compose-body"
          aria-label="Message"
          autoFocus={d.kind === 'reply' || d.kind === 'replyAll'}
          value={d.text}
          onChange={(e) => onBody(e.target.value, e.target.selectionStart)}
          onKeyDown={menu?.source === 'trigger' ? onMenuKey : undefined}
          onBlur={() => menu?.source === 'trigger' && setMenu(null)}
        />
        {menu && (
          <SnippetMenu
            menu={menu}
            matches={matches}
            onQuery={(query) => setMenu({ ...menu, query, active: 0 })}
            onKey={(e) => {
              onMenuKey(e)
              if (e.key === 'Escape') body.current?.focus()
            }}
            onPick={pickSnippet}
          />
        )}
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
          {error && (
            <span className="compose-error" role="alert">
              {error}
            </span>
          )}
          {!error && notice && (
            <span className="compose-notice" role="status">
              {notice}
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
    </div>
  )
}

function previewText(html: string): string {
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 400)
}
