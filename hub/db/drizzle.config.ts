import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  // Module schemas join the kernel's so one migration sequence covers the whole database.
  schema: ['./src/server/schema.ts', '../../modules/*/db/src/schema.ts'],
  out: './migrations',
  schemaFilter: ['public', 'hub', 'tasks', 'docs'],
  entities: { roles: { provider: 'supabase' } },
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
