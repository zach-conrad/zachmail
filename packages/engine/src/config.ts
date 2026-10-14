import type { StorageConfig } from './storage'

export interface EngineConfig {
  google: { clientId: string; clientSecret: string; pubsubTopic?: string }
  /** HMAC key for signed image-proxy URLs. */
  imageProxySecret: string
  /** Public origin of the app, used to build absolute proxy URLs if needed. */
  appOrigin: string
  /** Base64 32-byte token key; when unset it is read from Supabase Vault. */
  tokenKey?: string
  /** Supabase Storage for outgoing attachments; uploads are refused while unset. */
  storage?: StorageConfig
}

export function engineConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): EngineConfig {
  const need = (k: string) => {
    const v = env[k]
    if (!v) throw new Error(`Missing env: ${k}`)
    return v
  }
  return {
    google: {
      clientId: need('GOOGLE_CLIENT_ID'),
      clientSecret: need('GOOGLE_CLIENT_SECRET'),
      pubsubTopic: env.GMAIL_PUBSUB_TOPIC,
    },
    imageProxySecret: need('IMAGE_PROXY_SECRET'),
    appOrigin: env.APP_ORIGIN ?? 'https://mail.zachconrad.dev',
    tokenKey: env.TOKEN_ENCRYPTION_KEY,
    storage:
      env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
        ? {
            url: env.SUPABASE_URL,
            serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
            bucket: env.ATTACHMENTS_BUCKET ?? 'attachments',
          }
        : undefined,
  }
}
