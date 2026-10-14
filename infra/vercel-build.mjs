// Assembles the Vercel Build Output API layout (.vercel/output) from the web and API builds:
// static SPA + one bundled Node function for /api/*. Run after `turbo run build`.
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const out = '.vercel/output'
rmSync(out, { recursive: true, force: true })

// Source maps stay out of the public static output.
cpSync('apps/web/dist', `${out}/static`, {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
})

const fn = `${out}/functions/api.func`
mkdirSync(fn, { recursive: true })
cpSync('apps/api/dist/index.mjs', `${fn}/index.mjs`)
cpSync('apps/api/dist/index.mjs.map', `${fn}/index.mjs.map`)
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: 'module' }))
writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({
    runtime: 'nodejs22.x',
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    maxDuration: 30,
  }),
)

// CSP: allow the one inline theme script by hash instead of 'unsafe-inline'.
const html = readFileSync('apps/web/dist/index.html', 'utf8')
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
)
const csp = [
  "default-src 'self'",
  // wasm-unsafe-eval: the data worker compiles SQLite (wasm); it allows no JS eval.
  `script-src 'self' 'wasm-unsafe-eval' ${inline.join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const security = {
  'Content-Security-Policy': csp,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: '^/assets/(.*)$',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          continue: true,
        },
        { src: '^/(.*)$', headers: security, continue: true },
        // The original path rides along in __zm_path; apps/api/src/vercel.ts restores it.
        { src: '^/(api|webhooks)(/.*)?$', dest: '/api?__zm_path=/$1$2' },
        { handle: 'filesystem' },
        { src: '^/(.*)$', dest: '/index.html', headers: { 'Cache-Control': 'no-cache' } },
      ],
    },
    null,
    2,
  ),
)

console.log('wrote', out)
