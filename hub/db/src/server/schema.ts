/**
 * Server (Postgres / Supabase) schema. Every table carries user_id with RLS so isolation is
 * real even though there is one user. Changes here need a migration (pnpm generate), the
 * matching client SQLite table, and a `changes` entity type.
 */
import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { firstPartyColumns, ownRowsReadOnly, ownerId } from './tables'

/** Maintained by triggers (migration 0014_search_triggers): subject A, sender B, recipients C, body D. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

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

export const folderKindEnum = pgEnum('folder_kind', [
  'inbox',
  'sent',
  'drafts',
  'trash',
  'spam',
  'archive',
  'starred',
  'important',
  'custom',
])

export interface Address {
  name?: string
  email: string
}

/** Provider-neutral "labels": Gmail labels, Graph folders/categories, IMAP mailboxes. */
export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    name: text('name').notNull(),
    kind: folderKindEnum('kind').notNull().default('custom'),
    unreadCount: integer('unread_count').notNull().default(0),
    totalCount: integer('total_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('folders_account_provider').on(t.accountId, t.providerId),
    ownRowsReadOnly('folders'),
  ],
).enableRLS()

export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    providerThreadId: text('provider_thread_id').notNull(),
    subject: text('subject').notNull().default(''),
    snippet: text('snippet').notNull().default(''),
    participants: jsonb('participants').$type<Address[]>().notNull().default([]),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
    messageCount: integer('message_count').notNull().default(0),
    unread: boolean('unread').notNull().default(false),
    starred: boolean('starred').notNull().default(false),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    /** ZachMail-only: archived at the provider until then, then back to the inbox. */
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    /** ZachMail-only state: new replies get archived (Gmail's API has no mute). */
    muted: boolean('muted').notNull().default(false),
    /** Inbox split under the user's rules (core `compileSplitRules`); null when not in the inbox. */
    split: text('split'),
    /** Claude triage (packages/ai), as of `ai_triaged_at`; re-run when newer mail arrives. */
    aiCategory: text('ai_category'),
    aiSummary: text('ai_summary'),
    aiNeedsReply: boolean('ai_needs_reply'),
    aiTriagedAt: timestamp('ai_triaged_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('threads_muted')
      .on(t.accountId)
      .where(sql`muted`),
    uniqueIndex('threads_account_provider').on(t.accountId, t.providerThreadId),
    index('threads_user_recent').on(t.userId, t.lastMessageAt.desc()),
    index('threads_snoozed')
      .on(t.snoozedUntil)
      .where(sql`snoozed_until is not null`),
    ownRowsReadOnly('threads'),
  ],
).enableRLS()

export const threadFolders = pgTable(
  'thread_folders',
  {
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    userId: ownerId(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.folderId] }),
    index('thread_folders_folder').on(t.folderId),
    ownRowsReadOnly('thread_folders'),
  ],
).enableRLS()

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id').notNull(),
    rfc822MessageId: text('rfc822_message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references').array().notNull().default([]),
    from: jsonb('from').$type<Address | null>(),
    to: jsonb('to').$type<Address[]>().notNull().default([]),
    cc: jsonb('cc').$type<Address[]>().notNull().default([]),
    bcc: jsonb('bcc').$type<Address[]>().notNull().default([]),
    replyTo: jsonb('reply_to').$type<Address[]>().notNull().default([]),
    subject: text('subject').notNull().default(''),
    snippet: text('snippet').notNull().default(''),
    date: timestamp('date', { withTimezone: true }).notNull(),
    providerLabels: text('provider_labels').array().notNull().default([]),
    unread: boolean('unread').notNull().default(false),
    starred: boolean('starred').notNull().default(false),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    listUnsubscribe: text('list_unsubscribe'),
    size: integer('size').notNull().default(0),
    bodyStatus: text('body_status', { enum: ['none', 'cached'] })
      .notNull()
      .default('none'),
    search: tsvector('search'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_account_provider').on(t.accountId, t.providerMessageId),
    index('messages_thread_date').on(t.threadId, t.date),
    index('messages_search').using('gin', t.search),
    ownRowsReadOnly('messages'),
  ],
).enableRLS()

/** Sanitized bodies. Large ones (> ~256 KB) go to Storage and keep only the key here. */
export const messageBodies = pgTable(
  'message_bodies',
  {
    messageId: uuid('message_id')
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: ownerId(),
    html: text('html'),
    text: text('text'),
    storageKey: text('storage_key'),
    hasRemoteImages: boolean('has_remote_images').notNull().default(false),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [ownRowsReadOnly('message_bodies')],
).enableRLS()

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull().default(''),
    mime: text('mime').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    providerAttachmentId: text('provider_attachment_id'),
    contentId: text('content_id'),
    inline: boolean('inline').notNull().default(false),
    storageKey: text('storage_key'),
  },
  (t) => [index('attachments_message').on(t.messageId), ownRowsReadOnly('attachments')],
).enableRLS()

/**
 * Provider writes waiting for the worker: triage ops now, sends later. One row per client op
 * per account, executed in `seq` order per account. `payload` holds thread and folder ids
 * (resolved to provider ids at execution time); `not_before` delays undo-send / send-later.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    userId: ownerId(),
    opId: uuid('op_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    state: text('state', { enum: ['pending', 'in_flight', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outbox_op_account').on(t.opId, t.accountId),
    index('outbox_account_open')
      .on(t.accountId, t.seq)
      .where(sql`state in ('pending', 'in_flight')`),
    ownRowsReadOnly('outbox'),
  ],
).enableRLS()

/**
 * User split rules (core `SplitRuleRow`). ZachMail-only data: written by the API, synced to
 * clients as the `split_rule` entity, evaluated on ingest into `threads.split`. Ids are
 * client-generated so an offline edit keeps its id.
 */
export const splitRules = pgTable(
  'split_rules',
  {
    id: uuid('id').primaryKey(),
    userId: ownerId(),
    name: text('name').notNull(),
    target: text('target').notNull(),
    match: text('match', { enum: ['all', 'any'] })
      .notNull()
      .default('all'),
    conditions: jsonb('conditions')
      .$type<{ field: string; value: string }[]>()
      .notNull()
      .default([]),
    position: doublePrecision('position').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('split_rules_user').on(t.userId, t.position), ownRowsReadOnly('split_rules')],
).enableRLS()

/**
 * Composer drafts, keyed by the client's id. The worker mirrors each to a provider draft
 * (`synced_version` trails `version` until it has); deleted drafts linger until the provider
 * copy is gone too.
 */
export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey(),
    userId: ownerId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    version: integer('version').notNull().default(1),
    syncedVersion: integer('synced_version').notNull().default(0),
    providerDraftId: text('provider_draft_id'),
    deleted: boolean('deleted').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [ownRowsReadOnly('drafts')],
).enableRLS()

/** Files uploaded (straight to Storage) for outgoing mail; referenced by sends and drafts. */
export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [ownRowsReadOnly('uploads')],
).enableRLS()

export const reminderConditionEnum = pgEnum('reminder_condition', ['always', 'if_no_reply'])

/**
 * ZachMail-only reminders, at most one per thread. A "remind if no reply" set while composing
 * has no thread until the sent copy syncs back: it waits on `sent_message_id` (the send's
 * Message-ID) and gets its thread_id from the sync that brings that message in.
 */
export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    sentMessageId: text('sent_message_id'),
    /** The op that set it; a send's op id for compose reminders. */
    opId: uuid('op_id').notNull(),
    remindAt: timestamp('remind_at', { withTimezone: true }).notNull(),
    condition: reminderConditionEnum('condition').notNull().default('if_no_reply'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reminders_thread').on(t.threadId),
    index('reminders_due').on(t.remindAt),
    index('reminders_sent_message')
      .on(t.accountId, t.sentMessageId)
      .where(sql`thread_id is null`),
    ownRowsReadOnly('reminders'),
  ],
).enableRLS()

/**
 * Composer snippets (core `SnippetRow`). ZachMail-only data: written by the API, synced to
 * clients as the `snippet` entity. Ids are client-generated so an offline edit keeps its id;
 * a non-empty shortcut is unique per user.
 */
export const snippets = pgTable(
  'snippets',
  {
    id: uuid('id').primaryKey(),
    userId: ownerId(),
    name: text('name').notNull(),
    shortcut: text('shortcut').notNull().default(''),
    subject: text('subject').notNull().default(''),
    html: text('html').notNull().default(''),
    cc: jsonb('cc').$type<Address[]>().notNull().default([]),
    bcc: jsonb('bcc').$type<Address[]>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('snippets_user_shortcut')
      .on(t.userId, t.shortcut)
      .where(sql`shortcut <> ''`),
    ownRowsReadOnly('snippets'),
  ],
).enableRLS()

/**
 * Dismissed follow-up nudges (core `NudgeDismissalRow`), one per thread. The nudge stays hidden
 * until the thread gets a message newer than `last_message_at`.
 */
export const nudgeDismissals = pgTable(
  'nudge_dismissals',
  {
    threadId: uuid('thread_id')
      .primaryKey()
      .references(() => threads.id, { onDelete: 'cascade' }),
    userId: ownerId(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [ownRowsReadOnly('nudge_dismissals')],
).enableRLS()

/**
 * Push targets (architecture §4): Web Push subscriptions now, APNs device tokens with the iOS
 * app. `token` is the push endpoint URL (webpush) or device token (apns); `keys` holds the
 * Web Push p256dh/auth pair. Rows the push service reports gone are deleted by the worker.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: ownerId(),
    kind: text('kind', { enum: ['webpush', 'apns'] }).notNull(),
    token: text('token').notNull(),
    keys: jsonb('keys').$type<{ p256dh: string; auth: string }>(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('devices_token').on(t.token),
    index('devices_user').on(t.userId, t.kind),
    ownRowsReadOnly('devices'),
  ],
).enableRLS()

/** Notification rules (core `NotificationSettings`); no row means the defaults. */
export const notificationSettings = pgTable(
  'notification_settings',
  {
    userId: ownerId().primaryKey(),
    enabled: boolean('enabled').notNull().default(true),
    splits: text('splits')
      .array()
      .notNull()
      .default(sql`'{important}'`),
    vips: text('vips')
      .array()
      .notNull()
      .default(sql`'{}'`),
    mutedAccounts: text('muted_accounts')
      .array()
      .notNull()
      .default(sql`'{}'`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [ownRowsReadOnly('notification_settings')],
).enableRLS()

/**
 * One row per UTC day of the nightly offsite backup (hub/backup). The day key is how worker
 * machines agree on who runs tonight's; a failed day is retried a few times. Server only.
 */
export const backupRuns = pgTable('backup_runs', {
  day: date('day').primaryKey(),
  status: text('status', { enum: ['running', 'ok', 'failed'] })
    .notNull()
    .default('running'),
  attempts: integer('attempts').notNull().default(1),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  objectKey: text('object_key'),
  bytes: integer('bytes'),
  rows: jsonb('rows').$type<Record<string, number>>(),
  error: text('error'),
}).enableRLS()

/** Single-row allowlist checked by the auth hook: only these emails can ever get a session. */
export const allowedUsers = pgTable('allowed_users', {
  email: text('email').primaryKey(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}).enableRLS()

/** Hub kernel tables (ZACHHUB_PLAN.md §2.3, §4). */
export const hub = pgSchema('hub')

/** Cross-module references, entity 'hub.link' (core LinkRow). No FKs: either side may be any module. */
export const links = hub
  .table(
    'links',
    {
      ...firstPartyColumns(),
      fromKind: text('from_kind').notNull(),
      fromId: text('from_id').notNull(),
      toKind: text('to_kind').notNull(),
      toId: text('to_id').notNull(),
      title: text('title').notNull().default(''),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      index('links_from').on(t.userId, t.fromKind, t.fromId),
      index('links_to').on(t.userId, t.toKind, t.toId),
      ownRowsReadOnly('links'),
    ],
  )
  .enableRLS()

/**
 * Deleted first-party rows, for every module. The row itself is gone; this keeps a late or
 * replayed put for the same id from bringing it back.
 */
export const tombstones = hub
  .table(
    'tombstones',
    {
      kind: text('kind').notNull(),
      id: uuid('id').notNull(),
      userId: ownerId(),
      hlc: text('hlc').notNull(),
      deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.kind, t.id] }), ownRowsReadOnly('tombstones')],
  )
  .enableRLS()

/**
 * One full-text index over every module's searchable rows (ZACHHUB_PLAN.md §5), written by
 * applyEntityOps for kinds that declare `search`. Mail keeps its per-message index and is
 * unioned in at query time (hubSearch.ts). Server only: clients keep their own FTS5 table.
 * `tsv` uses the mail tokenizer (public.search_words, migration 0014): A title, D body. The
 * trigram index (pg_trgm, migration 0016) catches typos in titles.
 */
export const searchIndex = hub
  .table(
    'search_index',
    {
      entityKind: text('entity_kind').notNull(),
      entityId: uuid('entity_id').notNull(),
      userId: ownerId(),
      title: text('title').notNull().default(''),
      body: text('body').notNull().default(''),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      tsv: tsvector('tsv')
        .notNull()
        .generatedAlwaysAs(
          sql`setweight(to_tsvector('simple'::regconfig, public.search_words(title)), 'A') || setweight(to_tsvector('simple'::regconfig, public.search_words(left(body, 100000))), 'D')`,
        ),
    },
    (t) => [
      primaryKey({ columns: [t.entityKind, t.entityId] }),
      index('search_index_user_updated').on(t.userId, t.updatedAt),
      index('search_index_tsv').using('gin', t.tsv),
      index('search_index_title_trgm').using('gin', t.title.op('extensions.gin_trgm_ops')),
      ownRowsReadOnly('search_index'),
    ],
  )
  .enableRLS()

export type Account = typeof accounts.$inferSelect
export type SearchIndexRow = typeof searchIndex.$inferSelect
export type Change = typeof changes.$inferSelect
export type Job = typeof jobs.$inferSelect
export type OutboxRow = typeof outbox.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type Folder = typeof folders.$inferSelect
export type Thread = typeof threads.$inferSelect
export type Message = typeof messages.$inferSelect
export type ReminderRecord = typeof reminders.$inferSelect
export type SplitRule = typeof splitRules.$inferSelect
export type Snippet = typeof snippets.$inferSelect
