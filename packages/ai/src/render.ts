import type { Address } from '@zachmail/core'

/** One message as the prompts see it. `text` is the plain-text body (or the snippet). */
export interface PromptMessage {
  from: Address | null
  to: Address[]
  cc: Address[]
  date: number
  listUnsubscribe?: boolean
  text: string
}

const addr = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email)
const list = (as: Address[]) => as.map(addr).join(', ')
// Mail is untrusted input; keep it from closing the tags that fence it off.
const fence = (s: string) => s.replace(/<\/?(?:message|thread|draft)\b[^>]*>/gi, '')

const attr = (s: string) => fence(s).replace(/"/g, "'")

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…${text.length - max} more characters]` : text
}

export function renderMessages(messages: PromptMessage[], maxChars: number): string {
  return messages
    .map((m) => {
      const head = [
        `from="${m.from ? attr(addr(m.from)) : 'unknown'}"`,
        `to="${attr(list(m.to))}"`,
        m.cc.length ? `cc="${attr(list(m.cc))}"` : '',
        `date="${new Date(m.date).toISOString()}"`,
        m.listUnsubscribe ? 'bulk="true"' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `<message ${head}>\n${fence(clip(m.text.trim(), maxChars))}\n</message>`
    })
    .join('\n')
}
