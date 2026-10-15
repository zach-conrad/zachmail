import { aiConfigFromEnv, type AiConfig } from '@zachhub/ai/config'
import type { StorageConfig } from './storage'

export interface EngineConfig {
  google: { clientId: string; clientSecret: string; pubsubTopic?: string }
  /** Microsoft 365 / Outlook.com through Graph; Outlook accounts are refused while unset. */
  microsoft?: MicrosoftConfig
  /** HMAC key for signed image-proxy URLs. */
  imageProxySecret: string
  /** Public origin of the app, used to build absolute proxy URLs if needed. */
  appOrigin: string
  /** Base64 32-byte token key; when unset it is read from Supabase Vault. */
  tokenKey?: string
  /** Supabase Storage for outgoing attachments; uploads are refused while unset. */
  storage?: StorageConfig
  /** Claude API; every AI feature is off while unset (no ANTHROPIC_API_KEY). */
  ai?: AiConfig
}

export interface MicrosoftConfig {
  clientId: string
  clientSecret: string
  /** 'common' unless pinned to one tenant. */
  tenant?: string
  /** Signs each account's Graph clientState; push notifications are off while unset. */
  webhookSecret?: string
}

export function microsoftConfigFromEnv(
  env: Record<string, string | undefined>,
): MicrosoftConfig | undefined {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) return undefined
  return {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    tenant: env.MICROSOFT_TENANT || undefined,
    webhookSecret: env.GRAPH_WEBHOOK_SECRET || undefined,
  }
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
    microsoft: microsoftConfigFromEnv(env),
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
    ai: aiConfigFromEnv(env),
  }
}
