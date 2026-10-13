/**
 * Server (Postgres / Supabase) schema. Every table carries user_id with RLS so isolation is
 * real even though there is one user. Changes here need a migration (pnpm generate), the
 * matching client SQLite table, and a `changes` entity type.
 */
import { sql } from 'drizzle-orm'
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { authUid, authUsers, authenticatedRole } from 'drizzle-orm/supabase'

const ownerId = () =>
  uuid('user_id')
    .notNull()
    .default(sql`auth.uid()`)
    .references(() => authUsers.id, { onDelete: 'cascade' })

/** Read-only for clients; only server code (service role, bypasses RLS) writes. */
const ownRowsReadOnly = (table: string) =>
  pgPolicy(`${table}_owner_read`, {
    for: 'select',
    to: authenticatedRole,
    using: sql`${authUid} = user_id`,
  })

export const providerEnum = pgEnum('provider', ['gmail', 'graph', 'imap'])
export const accountStatusEnum = pgEnum('account_status', [
  'connecting',
  'backfilling',
  'active',
  'needs_reauth',
  'error',
  'disabled',
])

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    provider: providerEnum('provider').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    shortName: text('short_name'),
    color: integer('color').notNull().default(0),
    sendAs: jsonb('send_as').$type<{ email: string; name?: string }[]>().notNull().default([]),
    status: accountStatusEnum('status').notNull().default('connecting'),
    syncState: jsonb('sync_state').$type<Record<string, unknown>>().notNull().default({}),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_user_email').on(t.userId, t.provider, t.email),
    ownRowsReadOnly('accounts'),
  ],
).enableRLS()

/** Provider secrets, AES-256-GCM encrypted with a Vault-held key. No client policy at all. */
export const accountCredentials = pgTable('account_credentials', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  userId: ownerId(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  scopes: text('scopes').array().notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS()

/** Append-only change log: the sync spine. Clients pull `since=<seq>`. */
export const changes = pgTable(
  'changes',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    userId: ownerId(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    op: text('op', { enum: ['upsert', 'delete'] }).notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('changes_user_seq').on(t.userId, t.seq), ownRowsReadOnly('changes')],
).enableRLS()

/** Worker job queue, claimed with FOR UPDATE SKIP LOCKED. Server-only. */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: ownerId(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Coalesces duplicates, e.g. one pending sync_account per account. */
    dedupeKey: text('dedupe_key'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('jobs_ready')
      .on(t.runAt)
      .where(sql`locked_by is null`),
    uniqueIndex('jobs_dedupe')
      .on(t.dedupeKey)
      .where(sql`locked_by is null and dedupe_key is not null`),
  ],
).enableRLS()

/** Single-row allowlist checked by the auth hook: only these emails can ever get a session. */
export const allowedUsers = pgTable('allowed_users', {
  email: text('email').primaryKey(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS()

export type Account = typeof accounts.$inferSelect
export type Change = typeof changes.$inferSelect
export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
