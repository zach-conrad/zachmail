import { aiConfigFromEnv, type Ai } from '@zachmail/ai/config'
import { fromPostgresJs, type Db } from '@zachmail/db/server'
import {
  ProviderFactory,
  Storage,
  microsoftConfigFromEnv,
  type EngineConfig,
} from '@zachmail/engine'
import type { FetchLike } from '@zachmail/providers/gmail'
import type { JWTVerifyGetKey } from 'jose'
import postgres from 'postgres'
import { required, type Env } from './env'

export interface Deps {
  db: () => Db
  providers: () => ProviderFactory
  engineConfig: () => EngineConfig
  fetch: FetchLike
  /** Attachment storage; null until SUPABASE_SERVICE_ROLE_KEY is set. */
  storage: () => Storage | null
  /**
   * Claude client; null while ANTHROPIC_API_KEY is unset. Loaded on first use so the SDK
   * stays out of cold starts for every other route.
   */
  ai: () => Promise<Ai | null>
  /** Supabase JWKS (overridable in tests). */
  supabaseKeys?: JWTVerifyGetKey
  /** Google OIDC JWKS for Pub/Sub push tokens (overridable in tests). */
  googleKeys?: JWTVerifyGetKey
}

/** Production wiring: one pooled connection per warm function instance, created on first use. */
export function buildDeps(env: Env, overrides: Partial<Deps> = {}): Deps {
  let db: Db | undefined
  let providers: ProviderFactory | undefined
  let storage: Storage | undefined
  let ai: Promise<Ai> | undefined
  const aiConfig = aiConfigFromEnv({
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
  })
  const storageConfig = env.SUPABASE_SERVICE_ROLE_KEY
    ? {
        url: env.SUPABASE_URL,
        serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
        bucket: env.ATTACHMENTS_BUCKET ?? 'attachments',
      }
    : undefined
  const engineConfig = (): EngineConfig => ({
    google: {
      clientId: required(env, 'GOOGLE_CLIENT_ID'),
      clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
      pubsubTopic: env.GMAIL_PUBSUB_TOPIC,
    },
    microsoft: microsoftConfigFromEnv({ ...env }),
    imageProxySecret: required(env, 'IMAGE_PROXY_SECRET'),
    appOrigin: env.APP_ORIGIN,
    tokenKey: env.TOKEN_ENCRYPTION_KEY,
    storage: storageConfig,
    ai: aiConfig,
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
    storage: () => (storageConfig ? (storage ??= new Storage(storageConfig, fetchImpl)) : null),
    ai: async () =>
      aiConfig ? (ai ??= import('@zachmail/ai').then((m) => m.createAi(aiConfig))) : null,
    ...overrides,
  }
}
