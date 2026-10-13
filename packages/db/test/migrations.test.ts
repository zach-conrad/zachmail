// Migration dry run: applies every migration to an in-memory Postgres with a minimal stand-in
// for the Supabase auth schema and roles, then exercises the allowlist hook and job queue.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const dir = join(import.meta.dirname, '..', 'migrations')
const USER = '00000000-0000-0000-0000-000000000001'

const SUPABASE_STUB = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    for (const stmt of readFileSync(join(dir, f), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.exec(stmt)
    }
  }
  await db.exec(`INSERT INTO auth.users VALUES ('${USER}', 'owner@example.com')`)
})

describe('migrations', () => {
  it('allowlist hook admits only allowed emails', async () => {
    await db.exec(`INSERT INTO allowed_users (email) VALUES ('owner@example.com')`)
    const hook = async (email: string) =>
      (
        await db.query<{ r: Record<string, unknown> }>(
          `SELECT public.hook_before_user_created($1::jsonb) AS r`,
          [JSON.stringify({ user: { email } })],
        )
      ).rows[0]!.r
    expect(await hook('Owner@Example.com')).toEqual({})
    expect(await hook('intruder@example.com')).toHaveProperty('error.http_code', 403)
  })

  it('claim_jobs hands each ready job to exactly one worker', async () => {
    await db.exec(`
      INSERT INTO jobs (user_id, kind) VALUES ('${USER}', 'a'), ('${USER}', 'b');
      INSERT INTO jobs (user_id, kind, run_at) VALUES ('${USER}', 'later', now() + interval '1 hour');
    `)
    const first = await db.query<{ kind: string; attempts: number }>(
      `SELECT * FROM claim_jobs('w1', 10)`,
    )
    expect(first.rows.map((r) => r.kind).sort()).toEqual(['a', 'b'])
    expect(first.rows.every((r) => r.attempts === 1)).toBe(true)
    const second = await db.query(`SELECT * FROM claim_jobs('w2', 10)`)
    expect(second.rows).toHaveLength(0)
  })

  it('dedupe_key coalesces pending jobs', async () => {
    await db.exec(
      `INSERT INTO jobs (user_id, kind, dedupe_key) VALUES ('${USER}', 'sync', 'sync:acct1')`,
    )
    await expect(
      db.exec(
        `INSERT INTO jobs (user_id, kind, dedupe_key) VALUES ('${USER}', 'sync', 'sync:acct1')`,
      ),
    ).rejects.toThrow()
  })
})
