import { defineConfig } from 'vitest/config'

// PGlite boots a full Postgres in WASM; first start plus migrations can take several seconds.
// rrule (via tasks-core) ships extensionless ESM imports Node can't load; let Vite transform it.
export default defineConfig({
  test: { hookTimeout: 60_000, testTimeout: 30_000, server: { deps: { inline: ['rrule'] } } },
})
