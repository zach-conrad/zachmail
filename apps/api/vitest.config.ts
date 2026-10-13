import { defineConfig } from 'vitest/config'

// PGlite boots a full Postgres in WASM; first start plus migrations can take several seconds.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } })
