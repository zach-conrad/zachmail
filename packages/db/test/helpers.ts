import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const USER = '00000000-0000-0000-0000-000000000001'

const SUPABASE_STUB = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin;
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

/** In-memory Postgres with a Supabase stand-in, every migration applied, and one user. */
export async function migratedDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(SUPABASE_STUB)
  const dir = join(import.meta.dirname, '..', 'migrations')
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(dir, f), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.exec(stmt)
    }
  }
  await db.exec(`INSERT INTO auth.users VALUES ('${USER}', 'owner@example.com')`)
  return db
}
