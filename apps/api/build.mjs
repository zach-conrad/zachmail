// Bundles the API into a single ESM file for the Vercel Function (no node_modules at runtime,
// which keeps cold starts short).
import { build } from 'esbuild'

await build({
  entryPoints: ['src/vercel.ts'],
  outfile: 'dist/index.mjs',
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
