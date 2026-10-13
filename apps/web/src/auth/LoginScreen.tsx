import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function LoginScreen() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!supabase) {
    return (
      <main className="login">
        <h1 className="display">ZachMail</h1>
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
      <h1 className="display">ZachMail</h1>
      <div className="login-actions">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => run(() => auth.signInWithPasskey())}
        >
          Sign in with passkey
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(() =>
              auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: location.origin },
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
