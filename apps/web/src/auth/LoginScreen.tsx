import { useState } from 'react'
import { authRedirect, desktop } from '../lib/desktop'
import { supabase } from '../lib/supabase'

export function LoginScreen() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!supabase) {
    return (
      <main className="login">
        <h1 className="display">ZachHub</h1>
        <p className="muted">This build has no Supabase configuration.</p>
      </main>
    )
  }
  const auth = supabase.auth

  async function run(fn: () => Promise<{ error: { message: string } | null }>) {
    setBusy(true)
    setError(null)
    const { error } = await fn()
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <main className="login">
      <h1 className="display">ZachHub</h1>
      <div className="login-actions">
        {/* Passkeys need a real browser; the macOS app signs in through Google. */}
        {!desktop && (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => run(() => auth.signInWithPasskey())}
          >
            Sign in with passkey
          </button>
        )}
        <button
          className={desktop ? 'btn btn-primary' : 'btn'}
          disabled={busy}
          onClick={() =>
            run(() =>
              auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: authRedirect },
              }),
            )
          }
        >
          Continue with Google
        </button>
      </div>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}
