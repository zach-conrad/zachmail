export interface Env {
  SUPABASE_URL: string
  /** Comma-separated emails allowed to use the API (defense in depth behind the auth hook). */
  ALLOWED_EMAILS: string
  GIT_SHA?: string
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const missing = ['SUPABASE_URL', 'ALLOWED_EMAILS'].filter((k) => !source[k])
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`)
  return {
    SUPABASE_URL: source.SUPABASE_URL!,
    ALLOWED_EMAILS: source.ALLOWED_EMAILS!,
    GIT_SHA: source.VERCEL_GIT_COMMIT_SHA ?? source.GIT_SHA,
  }
}
