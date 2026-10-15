import type { ComposeDraft } from '@zachhub/core'

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const addresses = (s: string) =>
  decode(s)
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)

/** Parses a mailto: URL (RFC 6068). Returns null for anything else. */
export function parseMailto(url: string): ComposeDraft | null {
  if (!/^mailto:/i.test(url)) return null
  const rest = url.slice('mailto:'.length)
  const q = rest.indexOf('?')
  const draft: ComposeDraft = {
    to: addresses(q === -1 ? rest : rest.slice(0, q)),
    cc: [],
    bcc: [],
    subject: '',
    body: '',
  }
  if (q === -1) return draft
  // Not URLSearchParams: RFC 6068 treats "+" as a literal plus, not a space.
  for (const pair of rest.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = decode(pair.slice(0, eq)).toLowerCase()
    const value = pair.slice(eq + 1)
    if (name === 'to' || name === 'cc' || name === 'bcc') draft[name].push(...addresses(value))
    else if (name === 'subject') draft.subject = decode(value)
    else if (name === 'body') draft.body = decode(value).replace(/\r\n/g, '\n')
  }
  return draft
}
