import type { Session } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { demoMode, supabase } from '../lib/supabase'

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; email: string; session: Session | null }

const AuthContext = createContext<AuthState>({ status: 'loading' })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() =>
    demoMode
      ? { status: 'signedIn', email: 'demo@zachmail.local', session: null }
      : { status: 'loading' },
  )

  useEffect(() => {
    if (!supabase) return
    const apply = (session: Session | null) =>
      setState(
        session
          ? { status: 'signedIn', email: session.user.email ?? '', session }
          : { status: 'signedOut' },
      )
    // getSession reads local storage, so a returning user gets the shell without a network wait.
    supabase.auth.getSession().then(({ data }) => apply(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, session) => apply(session))
    return () => data.subscription.unsubscribe()
  }, [])

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)

export async function signOut() {
  await supabase?.auth.signOut()
}
