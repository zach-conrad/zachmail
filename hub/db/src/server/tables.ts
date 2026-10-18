/**
 * Column and policy helpers shared by the kernel schema and module schemas
 * (modules/<m>/db). Module tables live in their own Postgres schema (`tasks`, `docs`) and are
 * listed in drizzle.config.ts so one migration sequence covers the whole database.
 */
import { sql } from 'drizzle-orm'
import { jsonb, pgPolicy, timestamp, uuid } from 'drizzle-orm/pg-core'
import { authUid, authUsers, authenticatedRole } from 'drizzle-orm/supabase'

export const ownerId = () =>
  uuid('user_id')
    .notNull()
    .default(sql`auth.uid()`)
    .references(() => authUsers.id, { onDelete: 'cascade' })

/** Read-only for clients; only server code (service role, bypasses RLS) writes. */
export const ownRowsReadOnly = (table: string) =>
  pgPolicy(`${table}_owner_read`, {
    for: 'select',
    to: authenticatedRole,
    using: sql`${authUid} = user_id`,
  })

/**
 * The columns every first-party entity table needs (see entities.ts): a client-generated id,
 * the owner, and the per-field HLC stamps the merge compares against. Spread into the table:
 * `pgSchema('tasks').table('tasks', { ...firstPartyColumns(), title: text('title')... })`.
 */
export const firstPartyColumns = () => ({
  id: uuid('id').primaryKey(),
  userId: ownerId(),
  fieldHlc: jsonb('field_hlc').$type<Record<string, string>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
