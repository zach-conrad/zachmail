export interface Address {
  name?: string
  email: string
}

/**
 * Parses an RFC 5322 address-list header ("Ana Ruiz <ana@x.com>, bob@y.com, "Lee, J" <j@z>").
 * Tolerant of the malformed headers real mail contains; never throws.
 */
export function parseAddressList(header: string | undefined | null): Address[] {
  if (!header) return []
  const out: Address[] = []
  let buf = ''
  let quoted = false
  let depth = 0
  for (const ch of header) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') depth++
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1)
    if (ch === ',' && !quoted && depth === 0) {
      push(buf)
      buf = ''
    } else buf += ch
  }
  push(buf)
  return out

  function push(part: string) {
    const s = part.trim()
    if (!s) return
    const m = s.match(/^(.*?)<([^>]+)>\s*$/)
    if (m) {
      const name = decodeName(m[1]!)
      const email = m[2]!.trim().toLowerCase()
      if (email) out.push(name ? { name, email } : { email })
    } else if (s.includes('@')) {
      out.push({ email: s.replace(/^mailto:/i, '').toLowerCase() })
    }
  }
}

function decodeName(raw: string): string {
  return raw
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\(.)/g, '$1')
    .trim()
}

export const parseAddress = (header: string | undefined | null): Address | null =>
  parseAddressList(header)[0] ?? null
