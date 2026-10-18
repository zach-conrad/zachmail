import { defineConfig } from 'vitest/config'

export default defineConfig({
  // rrule's ESM build uses extensionless imports Node can't load; let Vite transform it.
  test: { server: { deps: { inline: ['rrule'] } } },
})
