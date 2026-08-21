import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { withTimeout } from '../lib/withTimeout'
import { identifyUser, resetAnalytics } from '../lib/analytics'

const AuthContext = createContext({})

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const hadUserRef = useRef(false)
  const intentionalSignOutRef = useRef(false)

  useEffect(() => {
    // Safety net — never spin forever
    const fallback = setTimeout(() => setLoading(false), 8000)

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) { hadUserRef.current = true; fetchProfile(session.user.id).finally(() => clearTimeout(fallback)) }
      else { setLoading(false); clearTimeout(fallback) }
    }).catch(() => { setLoading(false); clearTimeout(fallback) })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        hadUserRef.current = true
        await fetchProfile(session.user.id)
      } else {
        // If we had a live session and it disappeared without the user hitting
        // "Log out" themselves, that's an involuntary sign-out — almost always
        // caused by having Annie open in more than one tab: Supabase rotates the
        // refresh token on every use, so once one tab refreshes, every other
        // tab's copy is invalidated and gets signed out on its next request.
        // Flag it so the login page can explain what happened instead of just
        // silently dropping the person back at the login form.
        if (hadUserRef.current && !intentionalSignOutRef.current) {
          try { sessionStorage.setItem('annie_involuntary_signout', '1') } catch {}
        }
        hadUserRef.current = false
        intentionalSignOutRef.current = false
        setProfile(null)
        setLoading(false)
        resetAnalytics()
      }
    })

    return () => { subscription.unsubscribe(); clearTimeout(fallback) }
  }, [])

  async function fetchProfile(userId) {
    try {
      // Timeout-guarded like save-onboarding: this still calls supabase.co
      // directly (a GET, so there's nothing to proxy through our own domain
      // for), but without a timeout a silently-blocked request here hangs
      // this call forever with no error and no way for the caller to move
      // on — that's what left "Setting up Annie..." stuck indefinitely
      // after a successful save, since handleFinish awaits refreshProfile().
      const { data, error } = await withTimeout(
        supabase.from('profiles').select('*').eq('id', userId).single(),
        10000,
        'fetch-profile',
      )

      if (!error && data) { setProfile(data); identifyUser(userId, data) }
    } catch (err) {
      console.error('Profile fetch error:', err)
    } finally {
      setLoading(false)
    }
  }

  async function signUp(email, password, fullName, firmName) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, firm_name: firmName } },
    })
    return { data, error }
  }

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    return { data, error }
  }

  async function signOut() {
    intentionalSignOutRef.current = true
    await supabase.auth.signOut()
  }

  async function resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    return { error }
  }

  async function updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    return { error }
  }

  async function resendConfirmation(email) {
    const { error } = await supabase.auth.resend({ type: 'signup', email })
    return { error }
  }

  async function refreshProfile() {
    if (user) await fetchProfile(user.id)
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signUp, signIn, signOut, refreshProfile, resetPassword, updatePassword, resendConfirmation }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
