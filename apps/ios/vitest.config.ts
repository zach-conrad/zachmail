import { defineConfig } from 'vitest/config'

// Unit tests cover the pure mail and theme logic; React Native views are checked by `expo export`.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
