import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/schema.ts',
  out: './migrations',
  schemaFilter: ['public'],
  entities: { roles: { provider: 'supabase' } },
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
