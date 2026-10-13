// Migration dry run: applies every migration to an in-memory Postgres with a minimal stand-in
// for the Supabase auth and realtime schemas, then exercises the hook, job queue and nudge.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../src/server/sql'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
})
afterAll(() => t.close())

describe('migrations', () => {
  it('allowlist hook admits only allowed emails', async () => {
    await t.exec(`INSERT INTO allowed_users (email) VALUES ('owner@example.com')`)
    const hook = async (email: string) =>
      (
        await db.query<{ r: Record<string, unknown> }>(
          `SELECT public.hook_before_user_created($1::jsonb) AS r`,
          [{ user: { email } }],
        )
      )[0]!.r
    expect(await hook('Owner@Example.com')).toEqual({})
    expect(await hook('intruder@example.com')).toHaveProperty('error.http_code', 403)
  })

  it('claim_jobs hands each ready job to exactly one worker', async () => {
    await t.exec(`
      INSERT INTO jobs (user_id, kind) VALUES ('${USER}', 'a'), ('${USER}', 'b');
      INSERT INTO jobs (user_id, kind, run_at) VALUES ('${USER}', 'later', now() + interval '1 hour');
    `)
    const first = await db.query<{ kind: string; attempts: number }>(
      `SELECT * FROM claim_jobs('w1', 10)`,
    )
    expect(first.map((r) => r.kind).sort()).toEqual(['a', 'b'])
    expect(first.every((r) => r.attempts === 1)).toBe(true)
    const second = await db.query(`SELECT * FROM claim_jobs('w2', 10)`)
    expect(second).toHaveLength(0)
  })

  it('dedupe_key coalesces pending jobs', async () => {
    await t.exec(
      `INSERT INTO jobs (user_id, kind, dedupe_key) VALUES ('${USER}', 'sync', 'sync:acct1')`,
    )
    await expect(
      t.exec(
        `INSERT INTO jobs (user_id, kind, dedupe_key) VALUES ('${USER}', 'sync', 'sync:acct1')`,
      ),
    ).rejects.toThrow()
  })

  it('nudge_user broadcasts the latest seq on the user channel', async () => {
    await t.exec(
      `INSERT INTO changes (user_id, entity, entity_id, op) VALUES ('${USER}', 'thread', 't1', 'upsert')`,
    )
    await t.exec(`SELECT public.nudge_user('${USER}')`)
    const rows = await db.query<{ topic: string; payload: { seq: number } }>(
      `SELECT topic, payload FROM realtime.messages ORDER BY payload->>'seq' DESC LIMIT 1`,
    )
    expect(rows[0]!.topic).toBe(`user:${USER}`)
    expect(rows[0]!.payload.seq).toBeGreaterThan(0)
  })
})
