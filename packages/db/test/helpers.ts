import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { fromPGlite, fromPostgresJs, type Db } from '../src/server/sql'

export const USER = '00000000-0000-0000-0000-000000000001'

const ROLES = ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']

const SUPABASE_STUB = `
  ${ROLES.map((r) => `DO $$ BEGIN CREATE ROLE ${r}; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;`).join('\n')}
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE SCHEMA realtime;
  CREATE TABLE realtime.messages (topic text, extension text, payload jsonb, event text, private boolean);
  ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT current_setting('realtime.topic', true) $$;
  CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) RETURNS void
    LANGUAGE sql AS $$ INSERT INTO realtime.messages VALUES (topic, 'broadcast', payload, event, private) $$;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`

export interface TestDb {
  db: Db
  /** Runs one or more statements without parameters. */
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

/**
 * A fresh database with a Supabase stand-in, every migration applied, and one user.
 * In-memory PGlite by default; a real server when TEST_DATABASE_URL is set (CI runs both, so
 * the postgres.js adapter is exercised exactly as production uses it).
 */
export async function createTestDb(): Promise<TestDb> {
  const t = process.env.TEST_DATABASE_URL
    ? await realPostgres(process.env.TEST_DATABASE_URL)
    : await pglite()
  await t.exec(SUPABASE_STUB)
  const dir = join(import.meta.dirname, '..', 'migrations')
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    for (const stmt of readFileSync(join(dir, f), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await t.exec(stmt)
    }
  }
  await t.exec(`INSERT INTO auth.users VALUES ('${USER}', 'owner@example.com')`)
  return t
}

async function pglite(): Promise<TestDb> {
  const pg = new PGlite()
  return { db: fromPGlite(pg), exec: async (s) => void (await pg.exec(s)), close: () => pg.close() }
}

async function realPostgres(adminUrl: string): Promise<TestDb> {
  const name = `zm_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const sql = postgres(url.toString(), { max: 4, onnotice: () => {} })
  return {
    db: fromPostgresJs(sql as never),
    exec: async (s) => void (await sql.unsafe(s)),
    close: async () => {
      await sql.end()
      const a = postgres(adminUrl, { max: 1, onnotice: () => {} })
      await a.unsafe(`DROP DATABASE IF EXISTS ${name}`)
      await a.end()
    },
  }
}
