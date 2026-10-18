import type { Address, ContactRow } from '@zachhub/core'
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { displayName } from '../lib/format'
import { parseAddresses } from './draft'

const MAX_SUGGESTIONS = 6

function suggest(query: string, contacts: readonly ContactRow[], taken: Address[]): ContactRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: ContactRow[] = []
  for (const c of contacts) {
    if (taken.some((a) => a.email.toLowerCase() === c.email)) continue
    const name = c.name?.toLowerCase() ?? ''
    // Prefix of the address, the name, or any word of the name; contacts arrive best first.
    if (c.email.startsWith(q) || name.startsWith(q) || name.includes(` ${q}`)) out.push(c)
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/** To/Cc/Bcc: chips plus a text input that autocompletes from contacts. */
export function RecipientField({
  label,
  value,
  onChange,
  contacts,
  autoFocus,
}: {
  label: string
  value: Address[]
  onChange: (v: Address[]) => void
  contacts: readonly ContactRow[]
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const matches = suggest(text, contacts, value)
  const listId = `rcpt-${label.toLowerCase()}`

  const commit = (extra: Address[]) => {
    if (!extra.length) return false
    onChange([...value, ...extra])
    setText('')
    setActive(0)
    return true
  }
  const commitTyped = () => {
    const m = matches[active]
    if (m) return commit([m.name ? { name: m.name, email: m.email } : { email: m.email }])
    return commit(parseAddresses(text))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault()
      setActive((i) => (i + 1) % matches.length)
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault()
      setActive((i) => (i - 1 + matches.length) % matches.length)
    } else if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && text.trim()) {
      // Tab with nothing to commit moves on as usual.
      if (commitTyped()) e.preventDefault()
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const parsed = parseAddresses(e.clipboardData.getData('text'))
    if (parsed.length > 1 || (parsed.length === 1 && !text)) {
      e.preventDefault()
      commit(parsed)
    }
  }

  return (
    <div className="compose-field rcpt">
      <span className="compose-label">{label}</span>
      <div className="rcpt-box">
        {value.map((a, i) => (
          <span key={`${a.email}-${i}`} className="chip" title={a.email}>
            {displayName(a)}
            <button
              type="button"
              aria-label={`Remove ${a.email}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          autoFocus={autoFocus}
          aria-label={label}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(parseAddresses(text))}
        />
      </div>
      {matches.length > 0 && (
        <ul id={listId} className="rcpt-suggest" role="listbox">
          {matches.map((c, i) => (
            <li
              key={c.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                commit([c.name ? { name: c.name, email: c.email } : { email: c.email }])
              }}
            >
              <span>{c.name ?? c.email}</span>
              {c.name && <span className="muted">{c.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
