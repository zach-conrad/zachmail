import sanitizeHtml from 'sanitize-html'

export interface SanitizeOptions {
  /** Builds the proxied URL for a remote image (signed, so the proxy can't be abused). */
  proxyImage: (url: string) => string
}

export interface SanitizedBody {
  html: string
  /** True when at least one remote image was found and held back until Zach loads images. */
  hasRemoteImages: boolean
}

const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img',
  'style',
  'center',
  'font',
  'span',
  'del',
  'ins',
  's',
  'u',
  'sub',
  'sup',
  'small',
  'big',
]

const PRESENTATIONAL = [
  'style',
  'class',
  'align',
  'valign',
  'width',
  'height',
  'bgcolor',
  'color',
  'dir',
]

// Remote loads hidden in CSS (background images, fonts, @import) would bypass image blocking.
const stripCssUrls = (css: string) =>
  css.replace(/@import[^;]*;?/gi, '').replace(/url\s*\(([^)]*)\)/gi, 'none')

/**
 * Server-side sanitizing of email HTML. Output is safe to drop into a sandboxed iframe with no
 * scripts: no active content, no event handlers, remote images parked in `data-zm-src`
 * (behind the image proxy) until Zach chooses to load them.
 */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions): SanitizedBody {
  let hasRemoteImages = false

  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowVulnerableTags: true, // <style> only; scripts are never allowed and CSS is defused below
    allowedAttributes: {
      '*': PRESENTATIONAL,
      a: ['href', 'name', 'title', 'target', 'rel', ...PRESENTATIONAL],
      img: ['src', 'alt', 'title', 'data-zm-src', 'data-zm-cid', ...PRESENTATIONAL],
      table: ['border', 'cellpadding', 'cellspacing', ...PRESENTATIONAL],
      td: ['colspan', 'rowspan', 'nowrap', ...PRESENTATIONAL],
      th: ['colspan', 'rowspan', 'nowrap', ...PRESENTATIONAL],
      font: ['face', 'size', ...PRESENTATIONAL],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
      a: ['http', 'https', 'mailto', 'tel'],
    },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
      img: (tagName, attribs) => {
        const { src, ...rest } = attribs
        if (!src) return { tagName, attribs: rest }
        if (/^https?:/i.test(src)) {
          hasRemoteImages = true
          return { tagName, attribs: { ...rest, 'data-zm-src': opts.proxyImage(src) } }
        }
        if (/^cid:/i.test(src))
          return { tagName, attribs: { ...rest, 'data-zm-cid': src.slice(4) } }
        if (/^data:image\/(png|gif|jpe?g|webp);/i.test(src))
          return { tagName, attribs: { ...rest, src } }
        return { tagName, attribs: rest }
      },
    },
  })

  const defused = clean
    .replace(
      /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (_m, open: string, css: string, close: string) => open + stripCssUrls(css) + close,
    )
    .replace(/style="([^"]*)"/gi, (_m, css: string) => `style="${stripCssUrls(css)}"`)
  return { html: defused, hasRemoteImages }
}

/** Plain-text body → minimal HTML, so the reader always renders one format. */
export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<>"']+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  )
  return `<div style="white-space: pre-wrap">${linked}</div>`
}
