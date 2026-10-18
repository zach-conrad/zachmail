/**
 * What the nightly backup holds. Only first-party data is here: things Zach typed or decided,
 * which no provider can give back. The mail mirror is rebuilt by a resync, so it stays out.
 *
 * Every table in the public schema must appear in BACKUP_TABLES or NOT_BACKED_UP (a test
 * enforces it), so a new module's tables (tasks, docs, links) can't be forgotten.
 */
export interface BackupTable {
  name: string
  /** Rows are exported in this order, so two exports of the same data are byte-identical. */
  orderBy: string
  /** Filter by user_id when exporting one user's data (the settings button). */
  userScoped: boolean
  /**
   * Columns that must point at an existing row for the restore to keep a row. Rows whose
   * target is gone (a thread that a resync gave a new id) are skipped and counted.
   */
  requires?: Record<string, string>
  /** Applied to each row before it is restored. */
  onRestore?: (row: Record<string, unknown>) => Record<string, unknown>
}

/** In restore order: a table comes after every table it references. */
export const BACKUP_TABLES: BackupTable[] = [
  { name: 'allowed_users', orderBy: 'email', userScoped: false },
  {
    // Account rows (no credentials) so drafts and reminders keep their account. A restored
    // account waits for a reconnect; the OAuth callback reuses the row by provider + email.
    name: 'accounts',
    orderBy: 'created_at, id',
    userScoped: true,
    onRestore: (r) => ({
      ...r,
      status: 'needs_reauth',
      sync_state: {},
      last_synced_at: null,
      last_error: null,
    }),
  },
  { name: 'notification_settings', orderBy: 'user_id', userScoped: true },
  { name: 'split_rules', orderBy: 'position, id', userScoped: true },
  { name: 'snippets', orderBy: 'id', userScoped: true },
  { name: 'drafts', orderBy: 'id', userScoped: true, requires: { account_id: 'accounts' } },
  {
    name: 'reminders',
    orderBy: 'id',
    userScoped: true,
    requires: { account_id: 'accounts', thread_id: 'threads' },
  },
  {
    name: 'nudge_dismissals',
    orderBy: 'thread_id',
    userScoped: true,
    requires: { thread_id: 'threads' },
  },
]

/** Tables deliberately left out, and why. */
export const NOT_BACKED_UP: Record<string, string> = {
  account_credentials: 'provider tokens; reconnecting an account issues new ones',
  changes: 'sync log, rebuilt by sync',
  jobs: 'work queue',
  folders: 'mail mirror',
  threads: 'mail mirror',
  thread_folders: 'mail mirror',
  messages: 'mail mirror',
  message_bodies: 'mail body cache',
  attachments: 'mail mirror',
  outbox: 'in-flight sends',
  uploads: 'outgoing attachments, swept when orphaned',
  devices: 'push subscriptions; each device re-subscribes',
  backup_runs: 'bookkeeping for this job',
}

/**
 * Derived data written into the export for reading, never restored: the provider mail it
 * comes from brings it back.
 */
export const DERIVED_TABLES = ['contacts'] as const
