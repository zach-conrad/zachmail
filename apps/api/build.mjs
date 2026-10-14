// Bundles the API into ESM for the Vercel Function (no node_modules at runtime, which keeps
// cold starts short). Dynamic imports (the Claude SDK, used only by /api/ai) become separate
// chunks that load on first use instead of on every cold start.
import { rmSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('dist', { recursive: true, force: true })
await build({
  entryPoints: { index: 'src/vercel.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
