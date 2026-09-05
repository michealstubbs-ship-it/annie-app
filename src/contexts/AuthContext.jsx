import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { withTimeout } from '../lib/withTimeout'
import { identifyUser, resetAnalytics } from '../lib/analytics'
import { getEmailStatus } from '../lib/email/emailApi'
import { readNetwork, NETWORK_SWEEPING } from '../lib/networkGate'

const AuthContext = createContext({})

// Slow on purpose: a first mailbox pass takes minutes, not seconds, and this
// is two requests per tick on every open tab.
const SWEEP_REFRESH_MS = 30000

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(true)
  // WHETHER THIS CUSTOMER HAS A NETWORK, read alongside the profile rather
  // than derived from it. Admission to the dashboard used to be a boolean on
  // the profile row (linkedin_import_completed) that "Skip for now" set to
  // true — a record that a dialog had been shown, read everywhere as "they
  // have a network". See lib/networkGate.js for the whole argument.
  //
  // Two facts, one round trip each, both in parallel with the profile fetch:
  // how many contacts the team has, and whether a mailbox is connected. Either
  // can fail, and a failure is reported as UNKNOWN rather than as an empty
  // network — see readNetwork.
  const [network, setNetwork] = useState(null)
  const [networkLoading, setNetworkLoading] = useState(true)
  const hadUserRef = useRef(false)
  const intentionalSignOutRef = useRef(false)

  // One loading flag for consumers, as before. Route decisions depend on both:
  // rendering the dashboard before the network is known would flash a feed at
  // someone who is about to be sent to /get-started, and vice versa.
  const loading = profileLoading || networkLoading

  useEffect(() => {
    // Safety net — never spin forever
    const fallback = setTimeout(() => { setProfileLoading(false); setNetworkLoading(false) }, 8000)

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        hadUserRef.current = true
        Promise.all([fetchProfile(session.user.id), fetchNetwork()]).finally(() => clearTimeout(fallback))
      } else {
        setProfileLoading(false); setNetworkLoading(false); clearTimeout(fallback)
      }
    }).catch(() => { setProfileLoading(false); setNetworkLoading(false); clearTimeout(fallback) })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        hadUserRef.current = true
        await Promise.all([fetchProfile(session.user.id), fetchNetwork()])
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
        setNetwork(null)
        setProfileLoading(false)
        setNetworkLoading(false)
        resetAnalytics()
      }
    })

    return () => { subscription.unsubscribe(); clearTimeout(fallback) }
  }, [])

  // Wrapped in useCallback (empty deps — this closes over nothing but stable
  // setters and imports) so the context value below can actually be
  // memoized. Without this, `value` would need fresh function references in
  // its dependency array on every render anyway, defeating the point of
  // useMemo. See the comment on AuthContext.Provider's value for why this
  // matters — 24+ files call useAuth().
  const fetchProfile = useCallback(async (userId) => {
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
      setProfileLoading(false)
    }
  }, [])

  // The two facts behind the gate. Read together, allowed to fail
  // independently, and never allowed to throw: an unreadable fact is UNKNOWN,
  // which readNetwork/admitsToDashboard handle by falling back to the old
  // flag — the one thing that must not happen here is a blocked request
  // ejecting a customer with 753 contacts back into signup.
  //
  // Both are timeout-guarded for the same reason every other call in this file
  // is: a silently blocked request hangs the caller forever with no error, and
  // this one is on the path to every authenticated screen.
  const fetchNetwork = useCallback(async () => {
    try {
      const [countRes, statusRes] = await Promise.allSettled([
        // head:true — the count only, no rows over the wire. Team-scoped by
        // RLS, deliberately not filtered by user_id: a colleague's contacts
        // are this customer's network too, exactly as the feed treats them.
        withTimeout(
          supabase.from('contacts').select('id', { count: 'exact', head: true }),
          8000,
          'network-contact-count',
        ),
        withTimeout(getEmailStatus(), 8000, 'network-email-status'),
      ])

      const count = countRes.status === 'fulfilled' && !countRes.value?.error
        ? (countRes.value.count ?? 0)
        : null

      // getEmailStatus answers with { available: false, error } rather than
      // throwing, so the error field — not the promise — says whether the
      // mailbox is genuinely absent or merely unreadable.
      const status = statusRes.status === 'fulfilled' && !statusRes.value?.error ? statusRes.value : null

      setNetwork({
        ...readNetwork({ account: status?.account || null, contactCount: count, mailboxKnown: Boolean(status) }),
        // Carried through so the screens that offer the mailbox can tell
        // "this account cannot use it" from "they have not connected it yet".
        available: Boolean(status?.available),
        configured: Boolean(status?.configured),
        account: status?.account || null,
      })
    } catch (err) {
      console.error('Network state fetch error:', err)
      setNetwork(readNetwork({ contactCount: null, mailboxKnown: false }))
    } finally {
      setNetworkLoading(false)
    }
  }, [])

  // THE ONE THING THAT CHANGES WITHOUT ANYONE DOING ANYTHING. The first pass
  // over a newly connected mailbox runs in the background for minutes, and
  // every screen that says "Annie is reading your sent mail" is making a claim
  // that has to stop being made when it finishes. One slow timer here keeps
  // that honest everywhere at once, and it ticks in no other state — an
  // account with a network never polls.
  useEffect(() => {
    if (network?.state !== NETWORK_SWEEPING) return
    const timer = setInterval(() => { fetchNetwork() }, SWEEP_REFRESH_MS)
    return () => clearInterval(timer)
  }, [network?.state, fetchNetwork])

  const signUp = useCallback(async (email, password, fullName, firmName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, firm_name: firmName } },
    })
    return { data, error }
  }, [])

  const signIn = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    return { data, error }
  }, [])

  const signOut = useCallback(async () => {
    intentionalSignOutRef.current = true
    await supabase.auth.signOut()
  }, [])

  const resetPassword = useCallback(async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    return { error }
  }, [])

  const updatePassword = useCallback(async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    return { error }
  }, [])

  const resendConfirmation = useCallback(async (email) => {
    const { error } = await supabase.auth.resend({ type: 'signup', email })
    return { error }
  }, [])

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id)
  }, [user, fetchProfile])

  // Re-read the two facts. Called after anything that can create a network —
  // finishing a contacts import, or coming back from the mailbox consent
  // screen — so the route guard re-evaluates against what is now true.
  // Deliberately separate from refreshProfile: Onboarding awaits that one on a
  // timeout, and it should not start waiting on two more round trips.
  const refreshNetwork = useCallback(async () => {
    if (user) await fetchNetwork()
  }, [user, fetchNetwork])

  // Memoized — without this, every consumer of useAuth() (24+ files) would
  // re-render on every AuthProvider render, since a fresh object literal is
  // a new reference every time regardless of whether any of its values
  // actually changed. The functions above are themselves useCallback'd so
  // this dependency array is meaningful rather than always-fresh too.
  const value = useMemo(
    () => ({ user, profile, network, loading, signUp, signIn, signOut, refreshProfile, refreshNetwork, resetPassword, updatePassword, resendConfirmation }),
    [user, profile, network, loading, signUp, signIn, signOut, refreshProfile, refreshNetwork, resetPassword, updatePassword, resendConfirmation],
  )

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
