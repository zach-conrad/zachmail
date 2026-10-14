import type { MessageBody } from '@zachmail/core'
import { tokens } from '@zachmail/tokens'
import { useMemo, useRef } from 'react'

const c = tokens.color
// Mail renders on light "paper": most HTML mail assumes a white page.
const STYLE = `html{color-scheme:light}body{margin:0;padding:12px 16px;font:400 ${tokens.type.body.size}px/${tokens.type.body.line}px ${tokens.font.ui};color:${c.text.light};background:${c.surface.light};overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:${c.accent.light}}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:2px solid ${c.border.light};color:${c['text-muted'].light}}pre{white-space:pre-wrap}table{max-width:100%}`

function buildDoc(html: string, images: boolean): string {
  // CSP is the second wall behind the server sanitizer: no scripts, no remote fetches except
  // our signed image proxy, and only after "Load images".
  const img = images ? `img-src data: cid: 'self'` : 'img-src data:'
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${img}; font-src data:`
  const body = images ? html.replace(/\sdata-zm-src=/g, ' src=') : html
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${STYLE}</style></head><body>${body}</body></html>`
}

/**
 * One message body in a sandboxed iframe. No allow-scripts, so mail can never run code;
 * allow-same-origin only lets the parent size the frame and forward keys.
 */
export function BodyFrame({
  body,
  images,
  onReady,
}: {
  body: MessageBody
  images: boolean
  onReady?: () => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const srcDoc = useMemo(() => buildDoc(body.html, images), [body.html, images])

  const onLoad = () => {
    const frame = ref.current
    const doc = frame?.contentDocument
    if (!frame || !doc) return
    const fit = () => (frame.style.height = `${doc.documentElement.scrollHeight}px`)
    fit()
    new ResizeObserver(fit).observe(doc.body)
    // Keys typed while the frame has focus still drive the app.
    doc.addEventListener('keydown', (e) => {
      const fwd = new KeyboardEvent('keydown', {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        cancelable: true,
      })
      if (!window.dispatchEvent(fwd)) e.preventDefault()
    })
    onReady?.()
  }

  return (
    <iframe
      ref={ref}
      className="body-frame"
      title="Message body"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={onLoad}
    />
  )
}
