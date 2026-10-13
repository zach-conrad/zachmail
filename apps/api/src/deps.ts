import { fromPostgresJs, type Db } from '@zachmail/db/server'
import { ProviderFactory, type EngineConfig } from '@zachmail/engine'
import type { FetchLike } from '@zachmail/providers/gmail'
import type { JWTVerifyGetKey } from 'jose'
import postgres from 'postgres'
import { required, type Env } from './env'

export interface Deps {
  db: () => Db
  providers: () => ProviderFactory
  engineConfig: () => EngineConfig
  fetch: FetchLike
  /** Supabase JWKS (overridable in tests). */
  supabaseKeys?: JWTVerifyGetKey
  /** Google OIDC JWKS for Pub/Sub push tokens (overridable in tests). */
  googleKeys?: JWTVerifyGetKey
}

/** Production wiring: one pooled connection per warm function instance, created on first use. */
export function buildDeps(env: Env, overrides: Partial<Deps> = {}): Deps {
  let db: Db | undefined
  let providers: ProviderFactory | undefined
  const engineConfig = (): EngineConfig => ({
    google: {
      clientId: required(env, 'GOOGLE_CLIENT_ID'),
      clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
      pubsubTopic: env.GMAIL_PUBSUB_TOPIC,
    },
    imageProxySecret: required(env, 'IMAGE_PROXY_SECRET'),
    appOrigin: env.APP_ORIGIN,
    tokenKey: env.TOKEN_ENCRYPTION_KEY,
  })
  const getDb =
    overrides.db ??
    (() =>
      (db ??= fromPostgresJs(
        // Supavisor transaction mode: no prepared statements; tiny pool per function instance.
        postgres(required(env, 'DATABASE_URL'), {
          prepare: false,
          max: 2,
          idle_timeout: 20,
        }) as never,
      )))
  const fetchImpl = overrides.fetch ?? fetch
  return {
    db: getDb,
    providers: () => (providers ??= new ProviderFactory(getDb(), engineConfig(), fetchImpl)),
    engineConfig,
    fetch: fetchImpl,
    ...overrides,
  }
}
