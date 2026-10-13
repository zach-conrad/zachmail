export interface Env {
  SUPABASE_URL: string
  /** Comma-separated emails allowed to use the API (defense in depth behind the auth hook). */
  ALLOWED_EMAILS: string
  GIT_SHA?: string
  /** Supabase pooler URL (transaction mode). Optional so /api/health works before setup. */
  DATABASE_URL?: string
  APP_ORIGIN: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GMAIL_PUBSUB_TOPIC?: string
  /** Audience configured on the Pub/Sub push subscription (usually the webhook URL). */
  GMAIL_PUSH_AUDIENCE?: string
  /** Service account the push subscription authenticates as. */
  GMAIL_PUSH_SERVICE_ACCOUNT?: string
  /** HMAC secrets for OAuth state and image-proxy URLs. */
  OAUTH_STATE_SECRET?: string
  IMAGE_PROXY_SECRET?: string
  TOKEN_ENCRYPTION_KEY?: string
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const missing = ['SUPABASE_URL', 'ALLOWED_EMAILS'].filter((k) => !source[k])
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`)
  return {
    SUPABASE_URL: source.SUPABASE_URL!,
    ALLOWED_EMAILS: source.ALLOWED_EMAILS!,
    GIT_SHA: source.VERCEL_GIT_COMMIT_SHA ?? source.GIT_SHA,
    DATABASE_URL: source.DATABASE_URL,
    APP_ORIGIN: source.APP_ORIGIN ?? 'https://mail.zachconrad.dev',
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET,
    GMAIL_PUBSUB_TOPIC: source.GMAIL_PUBSUB_TOPIC,
    GMAIL_PUSH_AUDIENCE: source.GMAIL_PUSH_AUDIENCE,
    GMAIL_PUSH_SERVICE_ACCOUNT: source.GMAIL_PUSH_SERVICE_ACCOUNT,
    OAUTH_STATE_SECRET: source.OAUTH_STATE_SECRET,
    IMAGE_PROXY_SECRET: source.IMAGE_PROXY_SECRET,
    TOKEN_ENCRYPTION_KEY: source.TOKEN_ENCRYPTION_KEY,
  }
}

export function required<K extends keyof Env>(env: Env, key: K): NonNullable<Env[K]> {
  const v = env[key]
  if (!v) throw new Error(`Missing env: ${key}`)
  return v as NonNullable<Env[K]>
}
