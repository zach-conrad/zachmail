import { defineConfig } from '@playwright/test'

// Speed budgets (architecture §1a) against the 20k-thread demo build. `pnpm perf` builds it
// with VITE_DEMO=1 into dist-perf and serves it with `vite preview`.
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: 'pnpm exec vite preview --outDir dist-perf --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
})
