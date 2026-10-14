import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { desktop } from './desktop'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/** Null when the build has no Supabase config (local dev / CI fixtures run in demo mode). */
export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // In the macOS app the session lives in the Keychain, not web storage.
          ...(desktop ? { storage: desktop.secureStorage } : {}),
        },
      })
    : null

/** Demo mode serves a generated mailbox: dev without Supabase, or a VITE_DEMO=1 build (perf CI). */
export const demoMode = !supabase && (import.meta.env.DEV || import.meta.env.VITE_DEMO === '1')
