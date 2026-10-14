import { InvalidSnippetError, parseSnippetInput, type SnippetRow } from '@zachmail/core'
import { useState } from 'react'
import { useData } from '../data/DataProvider'
import { useCommands } from '../lib/useCommands'
import { parseAddresses, textToHtml } from './draft'
import { htmlToText } from './extras'

interface Form {
  id: string
  name: string
  shortcut: string
  subject: string
  body: string
  cc: string
  bcc: string
}

const list = (a: SnippetRow['cc']) =>
  a.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(', ')

const toForm = (s: SnippetRow): Form => ({
  id: s.id,
  name: s.name,
  shortcut: s.shortcut,
  subject: s.subject,
  body: htmlToText(s.html),
  cc: list(s.cc),
  bcc: list(s.bcc),
})

const blank = (): Form => ({
  id: crypto.randomUUID(),
  name: '',
  shortcut: '',
  subject: '',
  body: '',
  cc: '',
  bcc: '',
})

/**
 * Settings → Compose → Snippets (design §6.4). Saving applies to the replica at once and
 * syncs after; type `;shortcut` or press ⌘; in the composer to use one.
 */
export function SnippetsEditor({ onClose }: { onClose: () => void }) {
  const { snippets, editSnippet } = useData()
  const [form, setForm] = useState<Form>(() => (snippets[0] ? toForm(snippets[0]) : blank()))
  const [error, setError] = useState<string | null>(null)
  const exists = snippets.some((s) => s.id === form.id)

  useCommands({ 'nav.back': onClose })

  const edit = (patch: Partial<Form>) => {
    setError(null)
    setForm((f) => ({ ...f, ...patch }))
  }

  const save = () => {
    try {
      const input = parseSnippetInput({
        name: form.name,
        shortcut: form.shortcut.replace(/^;/, ''),
        subject: form.subject,
        html: textToHtml(form.body),
        cc: parseAddresses(form.cc),
        bcc: parseAddresses(form.bcc),
      })
      const clash = snippets.find(
        (s) => s.id !== form.id && s.shortcut && s.shortcut === input.shortcut,
      )
      if (clash) return setError(`;${input.shortcut} is already used by “${clash.name}”`)
      const row: SnippetRow = { id: form.id, ...input, updatedAt: Date.now() }
      editSnippet(row.id, row)
      setForm(toForm(row))
    } catch (err) {
      if (err instanceof InvalidSnippetError) setError(err.message)
      else throw err
    }
  }

  const remove = () => {
    editSnippet(form.id, null)
    const next = snippets.find((s) => s.id !== form.id)
    setForm(next ? toForm(next) : blank())
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="rules-editor"
        role="dialog"
        aria-label="Snippets"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="rules-list">
          <h2 className="section-label">Snippets</h2>
          <ol>
            {snippets.map((s) => (
              <li key={s.id} aria-current={s.id === form.id || undefined}>
                <button type="button" className="rules-item" onClick={() => setForm(toForm(s))}>
                  <span>{s.name}</span>
                  {s.shortcut && <span className="muted">;{s.shortcut}</span>}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="compose-link" onClick={() => setForm(blank())}>
            + New snippet
          </button>
        </aside>
        <form
          className="rules-form"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <label className="field">
            Name
            <input value={form.name} onChange={(e) => edit({ name: e.target.value })} autoFocus />
          </label>
          <label className="field">
            Shortcut (type ;shortcut in a message)
            <input
              value={form.shortcut}
              placeholder="call"
              onChange={(e) => edit({ shortcut: e.target.value })}
            />
          </label>
          <label className="field">
            Subject (used when the message has none)
            <input value={form.subject} onChange={(e) => edit({ subject: e.target.value })} />
          </label>
          <label className="field">
            Text
            <textarea
              className="snippet-body"
              value={form.body}
              placeholder={'Hi {first_name|there},\n\n…'}
              onChange={(e) => edit({ body: e.target.value })}
            />
          </label>
          <p className="rules-hint muted">
            Variables: {'{first_name}'} {'{last_name}'} {'{full_name}'} {'{email}'}{' '}
            {'{my_first_name}'} {'{date}'} {'{day}'}. Add a fallback with {'{first_name|there}'}.
          </p>
          <label className="field">
            Add Cc
            <input value={form.cc} onChange={(e) => edit({ cc: e.target.value })} />
          </label>
          <label className="field">
            Add Bcc
            <input value={form.bcc} onChange={(e) => edit({ bcc: e.target.value })} />
          </label>
          {error && (
            <p className="compose-error" role="alert">
              {error}
            </p>
          )}
          <div className="rules-actions">
            <button type="submit" className="btn btn-primary">
              Save
            </button>
            <span className="spacer" />
            {exists && (
              <button type="button" className="btn btn-danger" onClick={remove}>
                Delete
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
