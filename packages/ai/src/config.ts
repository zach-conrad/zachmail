import type Anthropic from '@anthropic-ai/sdk'

/** Triage runs on every new inbound thread: fast and cheap. */
export const TRIAGE_MODEL = 'claude-haiku-5-5'
/** Writing help runs once per request, where quality matters more. */
export const ASSIST_MODEL = 'claude-sonnet-5-5'

export interface AiConfig {
  apiKey: string
  /** Overrides the API origin (tests point it at a fake). */
  baseURL?: string
  fetch?: typeof fetch
}

/** AI is off unless ANTHROPIC_API_KEY is set; other ambient credentials are ignored on purpose. */
export function aiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AiConfig | undefined {
  const apiKey = env.ANTHROPIC_API_KEY
  return apiKey ? { apiKey, baseURL: env.ANTHROPIC_BASE_URL || undefined } : undefined
}

export type Ai = Anthropic
