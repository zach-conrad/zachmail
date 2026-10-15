// Generates CSS variables from tokens.json, the single source of truth shared with the Apple apps.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const t = JSON.parse(readFileSync(new URL('../tokens.json', import.meta.url), 'utf8'))

const vars = (theme) => {
  const out = []
  for (const [name, v] of Object.entries(t.color)) out.push(`  --${name}: ${v[theme]};`)
  out.push(`  --shadow-float: ${t.shadow.float[theme]};`)
  return out.join('\n')
}

const statics = [
  ...t.account.map((c, i) => `  --account-${i}: ${c};`),
  `  --font-ui: ${t.font.ui};`,
  `  --font-display: ${t.font.display};`,
  `  --font-mono: ${t.font.mono};`,
  ...Object.entries(t.radius).map(([k, v]) => `  --radius-${k}: ${v}px;`),
  ...t.space.map((v, i) => `  --space-${i}: ${v}px;`),
  ...Object.entries(t.row).map(([k, v]) => `  --row-${k}: ${v}px;`),
  `  --dur-fast: ${t.motion.fast}ms;`,
  `  --dur-base: ${t.motion.base}ms;`,
  `  --dur-slow: ${t.motion.slow}ms;`,
  `  --ease: ${t.motion.easing};`,
].join('\n')

const css = `/* Generated from tokens.json. Do not edit. */
:root {
${statics}
${vars('dark')}
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme='dark']) {
${vars('light')}
    color-scheme: light;
  }
}
:root[data-theme='light'] {
${vars('light')}
  color-scheme: light;
}
:root[data-theme='dark'] {
${vars('dark')}
  color-scheme: dark;
}
`

mkdirSync(new URL('../dist', import.meta.url), { recursive: true })
writeFileSync(new URL('../dist/tokens.css', import.meta.url), css)
