import { gunzipSync, gzipSync } from 'node:zlib'
import { applySyncBatch, type Db } from '@zachhub/db/server'
import { USER, createTestDb, type TestDb } from '@zachhub/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BACKUP_TABLES,
  InvalidBackupError,
  NOT_BACKED_UP,
  S3Client,
  backupKey,
  exportBackup,
  parseBackup,
  readBackupStatus,
  restoreBackup,
  runNightlyBackup,
  type BackupConfig,
} from '../src'
import { fakeS3 } from './fakeS3'

const OTHER = '00000000-0000-0000-0000-000000000002'
const ids = {
  rule: '00000000-0000-4000-8000-00000000a001',
  snippet: '00000000-0000-4000-8000-00000000b001',
  draft: '00000000-0000-4000-8000-00000000c001',
  reminderThread: '00000000-0000-4000-8000-00000000d001',
  reminderSent: '00000000-0000-4000-8000-00000000d002',
  op: '00000000-0000-4000-8000-00000000e001',
}

let source: TestDb
let db: Db
let accountId: string
let threadId: string

async function seed(t: TestDb) {
  const d = t.db
  await d.query(`INSERT INTO allowed_users (email) VALUES ('owner@example.com')`)
  const [a] = await d.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email, display_name, color, send_as, status, sync_state)
     VALUES ($1, 'gmail', 'zach@x.com', 'Zach', 3, '[{"email":"z@alias.com"}]', 'active', '{"historyId":"9"}')
     RETURNING id`,
    [USER],
  )
  accountId = a!.id
  await applySyncBatch(d, {
    userId: USER,
    accountId,
    batch: {
      deletedMessageIds: [],
      messages: [
        {
          providerMessageId: 'p1',
          providerThreadId: 'pt1',
          rfc822MessageId: '<p1@x>',
          inReplyTo: null,
          references: [],
          from: { email: 'ana@x.com', name: 'Ana' },
          to: [{ email: 'zach@x.com' }],
          cc: [],
          bcc: [],
          replyTo: [],
          subject: 'Proposal',
          snippet: 'Any thoughts?',
          date: new Date('2026-10-01T10:00:00Z'),
          folderIds: [],
          unread: false,
          starred: false,
          hasAttachments: false,
          listUnsubscribe: null,
          size: 10,
          attachments: [],
        },
      ],
    },
  })
  threadId = (await d.query<{ id: string }>(`SELECT id FROM threads`))[0]!.id
  await d.query(
    `INSERT INTO notification_settings (user_id, enabled, splits, vips, muted_accounts)
     VALUES ($1, true, '{important,vip}', '{ana@x.com}', '{}')`,
    [USER],
  )
  await d.query(
    `INSERT INTO split_rules (id, user_id, name, target, match, conditions, position)
     VALUES ($1, $2, 'Receipts', 'receipts', 'any', '[{"field":"from","value":"stripe.com"}]', 1.5)`,
    [ids.rule, USER],
  )
  await d.query(
    `INSERT INTO snippets (id, user_id, name, shortcut, subject, html, cc, bcc)
     VALUES ($1, $2, 'Intro "call"', 'call', 'Quick call?', '<p>Hi {first_name|there} ✓</p>', '[]', '[{"email":"crm@x.com"}]')`,
    [ids.snippet, USER],
  )
  await d.query(
    `INSERT INTO drafts (id, user_id, account_id, payload, version, synced_version, provider_draft_id)
     VALUES ($1, $2, $3, '{"subject":"Draft","to":[{"email":"bo@x.com"}]}', 4, 3, 'r-123')`,
    [ids.draft, USER, accountId],
  )
  await d.query(
    `INSERT INTO reminders (id, user_id, account_id, thread_id, op_id, remind_at, condition)
     VALUES ($1, $2, $3, $4, $5, '2026-10-20T09:00:00Z', 'always')`,
    [ids.reminderThread, USER, accountId, threadId, ids.op],
  )
  await d.query(
    `INSERT INTO reminders (id, user_id, account_id, sent_message_id, op_id, remind_at)
     VALUES ($1, $2, $3, '<sent@x>', $4, '2026-10-21T09:00:00Z')`,
    [ids.reminderSent, USER, accountId, ids.op],
  )
  await d.query(
    `INSERT INTO nudge_dismissals (thread_id, user_id, last_message_at) VALUES ($1, $2, '2026-10-01T10:00:00Z')`,
    [threadId, USER],
  )
}

/** Every backed-up table as JSON text, ordered, so two databases compare exactly. */
async function dump(d: Db, transform = true) {
  const out: Record<string, unknown[]> = {}
  for (const t of BACKUP_TABLES) {
    const rows = await d.query<{ r: Record<string, unknown> }>(
      `SELECT to_jsonb(x) AS r FROM "${t.name}" x ORDER BY ${t.orderBy}`,
    )
    out[t.name] = rows.map(({ r }) => (transform && t.onRestore ? t.onRestore(r) : r))
  }
  return out
}

beforeAll(async () => {
  source = await createTestDb()
  db = source.db
  await seed(source)
})
afterAll(() => source.close())

describe('coverage', () => {
  it('decides on every table in the schema', async () => {
    const tables = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    )
    const decided = new Set([...BACKUP_TABLES.map((t) => t.name), ...Object.keys(NOT_BACKED_UP)])
    expect(tables.map((t) => t.name).filter((n) => !decided.has(n))).toEqual([])
  })
})

describe('export', () => {
  it('writes header, rows, derived contacts and a trailer with counts', async () => {
    const now = new Date('2026-10-15T10:00:00Z')
    const { body, rows } = await exportBackup(db, { now })
    const lines = gunzipSync(body).toString().trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({
      format: 'zachhub-backup',
      version: 1,
      createdAt: now.toISOString(),
      userId: null,
    })
    expect(rows).toEqual({
      allowed_users: 1,
      accounts: 1,
      notification_settings: 1,
      split_rules: 1,
      snippets: 1,
      drafts: 1,
      reminders: 2,
      nudge_dismissals: 1,
      contacts: 1,
    })
    expect(lines.some((l) => l.includes('"t":"contacts"') && l.includes('ana@x.com'))).toBe(true)
    expect(lines.some((l) => /credential|ciphertext/.test(l))).toBe(false)
    // Deterministic: the same data exports the same lines (contact scores decay with time).
    const stable = (gz: Buffer) =>
      gunzipSync(gz)
        .toString()
        .split('\n')
        .filter((l) => !l.includes('"t":"contacts"') && !l.includes('"end":true'))
    expect(stable((await exportBackup(db, { now })).body)).toEqual(stable(body))
  })

  it('exports one user when asked', async () => {
    await source.exec(`INSERT INTO auth.users VALUES ('${OTHER}', 'other@example.com')`)
    await db.query(
      `INSERT INTO snippets (id, user_id, name) VALUES ('00000000-0000-4000-8000-00000000b099', $1, 'Theirs')`,
      [OTHER],
    )
    const { rows } = await exportBackup(db, { userId: USER })
    expect(rows.snippets).toBe(1)
    expect(rows.allowed_users).toBe(1)
    await db.query(`DELETE FROM snippets WHERE user_id = $1`, [OTHER])
  })
})

describe('restore', () => {
  it('round-trips first-party data into a fresh database', async () => {
    const { body } = await exportBackup(db)
    const fresh = await createTestDb()
    try {
      const report = await restoreBackup(fresh.db, body)
      // The fresh database has no mail yet, so thread-bound rows wait out; everything else is in.
      expect(report.restored).toEqual({
        allowed_users: 1,
        accounts: 1,
        notification_settings: 1,
        split_rules: 1,
        snippets: 1,
        drafts: 1,
        reminders: 1,
        nudge_dismissals: 0,
      })
      expect(report.skipped).toMatchObject({ reminders: 1, nudge_dismissals: 1 })
      const want = await dump(db)
      want.reminders = want.reminders!.filter((r) => (r as { id: string }).id === ids.reminderSent)
      want.nudge_dismissals = []
      expect(await dump(fresh.db, false)).toEqual(want)
      const [acct] = await fresh.db.query<{ status: string }>(`SELECT status FROM accounts`)
      expect(acct!.status).toBe('needs_reauth')

      // Restoring again changes nothing.
      const again = await restoreBackup(fresh.db, body)
      expect(Object.values(again.restored).every((n) => n === 0)).toBe(true)
    } finally {
      await fresh.close()
    }
  })

  it('restores everything when the mail mirror survived', async () => {
    const { body } = await exportBackup(db)
    const before = await dump(db, false)
    await source.exec(`DELETE FROM drafts; DELETE FROM reminders; DELETE FROM nudge_dismissals;
      DELETE FROM snippets; DELETE FROM split_rules; DELETE FROM notification_settings`)
    const report = await restoreBackup(db, body)
    expect(report.restored).toMatchObject({ reminders: 2, nudge_dismissals: 1, drafts: 1 })
    expect(report.skipped).toMatchObject({ accounts: 1, allowed_users: 1 })
    // The live account keeps its live state; restore never downgrades it to needs_reauth.
    expect(await dump(db, false)).toEqual(before)
  })

  it('follows an account that was reconnected under a new id, and remaps the user', async () => {
    const { body } = await exportBackup(db)
    const fresh = await createTestDb()
    try {
      await fresh.exec(`INSERT INTO auth.users VALUES ('${OTHER}', 'other@example.com')`)
      const [live] = await fresh.db.query<{ id: string }>(
        `INSERT INTO accounts (user_id, provider, email, status) VALUES ($1, 'gmail', 'zach@x.com', 'active') RETURNING id`,
        [OTHER],
      )
      const report = await restoreBackup(fresh.db, body, { userId: OTHER })
      expect(report.restored).toMatchObject({ accounts: 0, drafts: 1, snippets: 1 })
      const [draft] = await fresh.db.query<{ account_id: string; user_id: string }>(
        `SELECT account_id, user_id FROM drafts`,
      )
      expect(draft).toEqual({ account_id: live!.id, user_id: OTHER })
      const owners = await fresh.db.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM snippets UNION SELECT user_id FROM split_rules`,
      )
      expect(owners).toEqual([{ user_id: OTHER }])
    } finally {
      await fresh.close()
    }
  })

  it('writes nothing on a dry run', async () => {
    const fresh = await createTestDb()
    try {
      const report = await restoreBackup(fresh.db, (await exportBackup(db)).body, { dryRun: true })
      expect(report).toMatchObject({ dryRun: true, restored: { snippets: 1 } })
      expect(await fresh.db.query(`SELECT 1 FROM snippets`)).toEqual([])
    } finally {
      await fresh.close()
    }
  })

  it('refuses a truncated or damaged file', async () => {
    const lines = gunzipSync((await exportBackup(db)).body)
      .toString()
      .trim()
      .split('\n')
    const gz = (l: string[]) => gzipSync(l.join('\n') + '\n')
    expect(() => parseBackup(gz(lines.slice(0, -1)))).toThrow(/truncated/)
    expect(() => parseBackup(gz([...lines.slice(0, 2), ...lines.slice(3)]))).toThrow(/damaged/)
    expect(() => parseBackup(Buffer.from('nope'))).toThrow(InvalidBackupError)
    expect(() => parseBackup(gz(['{"format":"zachhub-backup","version":99}', '{}']))).toThrow(
      /newer/,
    )
  })
})

describe('nightly job', () => {
  const config: BackupConfig = {
    s3: {
      endpoint: 'https://r2.example',
      bucket: 'b',
      region: 'auto',
      accessKeyId: 'k',
      secretAccessKey: 's',
    },
    prefix: 'zachhub/',
    retentionDays: 30,
    hourUtc: 10,
  }

  it('waits for its hour, runs once a day, uploads a restorable file and prunes old ones', async () => {
    const s3 = fakeS3()
    const client = new S3Client(config.s3, s3.fetch)
    const old = backupKey('zachhub/', '2026-09-14')
    const kept = backupKey('zachhub/', '2026-09-15')
    for (const k of [old, kept, 'zachhub/notes.txt', 'elsewhere/2020-01-01.ndjson.gz'])
      await client.put(k, new Uint8Array([1]))

    expect(await runNightlyBackup(db, config, client, new Date('2026-10-15T09:59:00Z'))).toBeNull()
    const run = await runNightlyBackup(db, config, client, new Date('2026-10-15T10:05:00Z'))
    expect(run).toMatchObject({
      day: '2026-10-15',
      key: 'zachhub/2026-10-15.ndjson.gz',
      pruned: [old],
    })
    expect(s3.objects.has(kept) && s3.objects.has('zachhub/notes.txt')).toBe(true)
    expect(await runNightlyBackup(db, config, client, new Date('2026-10-15T23:00:00Z'))).toBeNull()

    const fresh = await createTestDb()
    try {
      const report = await restoreBackup(fresh.db, s3.objects.get(run!.key)!.body)
      expect(report.restored.snippets).toBe(1)
    } finally {
      await fresh.close()
    }
    const status = await readBackupStatus(db)
    expect(status.lastOk).toMatchObject({ day: '2026-10-15', status: 'ok', bytes: run!.bytes })
  })

  it('records a failure and retries it on a later sweep', async () => {
    const day = new Date('2026-10-16T11:00:00Z')
    const failing = new S3Client(config.s3, fakeS3({ failPut: true }).fetch)
    await expect(runNightlyBackup(db, config, failing, day)).rejects.toThrow('InternalError')
    expect((await readBackupStatus(db)).latest).toMatchObject({
      day: '2026-10-16',
      status: 'failed',
      attempts: 1,
    })
    const ok = new S3Client(config.s3, fakeS3().fetch)
    expect(await runNightlyBackup(db, config, ok, day)).toMatchObject({ day: '2026-10-16' })
    expect((await readBackupStatus(db)).latest).toMatchObject({ status: 'ok', attempts: 2 })
  })
})
