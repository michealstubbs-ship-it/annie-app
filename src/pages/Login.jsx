import React, { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export default function Login() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [form, setForm] = useState({
    email: '', password: '', fullName: '', firmName: '',
  })

  function update(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    setError('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      if (mode === 'login') {
        const { error } = await signIn(form.email, form.password)
        if (error) setError(error.message)
      } else {
        if (!form.fullName.trim()) return setError('Please enter your full name')
        if (!form.firmName.trim()) return setError('Please enter your firm name')
        if (form.password.length < 8) return setError('Password must be at least 8 characters')

        const { error } = await signUp(form.email, form.password, form.fullName, form.firmName)
        if (error) setError(error.message)
        else setSuccess('Account created! Check your email to verify, then sign in.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-navy flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="flex items-center gap-3 mb-10 justify-center">
          <svg width="48" height="48" viewBox="0 0 68 68" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="68" height="68" rx="16" fill="#c9a84c"/>
            <path d="M34 14 L50 54 H44 L40 44 H28 L24 54 H18 L34 14Z M34 24 L30 38 H38 L34 24Z" fill="#0d1b3e"/>
          </svg>
          <div>
            <div className="text-white font-bold text-2xl leading-none">annie</div>
            <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl p-8 shadow-2xl">
          <h1 className="text-2xl font-bold text-navy mb-1">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="text-gray-500 text-sm mb-6">
            {mode === 'login' ? 'Sign in to your Annie dashboard' : 'Start your free trial — no credit card needed'}
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm mb-4">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <>
                <div>
                  <label className="label">Full name</label>
                  <input className="input" type="text" placeholder="Michael Stubbs" value={form.fullName} onChange={e => update('fullName', e.target.value)} required />
                </div>
                <div>
                  <label className="label">Firm name</label>
                  <input className="input" type="text" placeholder="Vantage Search Group" value={form.firmName} onChange={e => update('firmName', e.target.value)} required />
                </div>
              </>
            )}

            <div>
              <label className="label">Email address</label>
              <input className="input" type="email" placeholder="you@yourfirm.com" value={form.email} onChange={e => update('email', e.target.value)} required />
            </div>

            <div>
              <label className="label">Password</label>
              <input className="input" type="password" placeholder={mode === 'signup' ? 'Min. 8 characters' : '••••••••'} value={form.password} onChange={e => update('password', e.target.value)} required />
            </div>

            <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
              {loading ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-500">
            {mode === 'login' ? (
              <>Don't have an account?{' '}
                <button onClick={() => { setMode('signup'); setError(''); }} className="text-gold font-semibold hover:underline">Sign up free</button>
              </>
            ) : (
              <>Already have an account?{' '}
                <button onClick={() => { setMode('login'); setError(''); }} className="text-gold font-semibold hover:underline">Sign in</button>
              </>
            )}
          </div>
        </div>

        <p className="text-center text-gray-500 text-xs mt-6">
          By signing up you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  )
}
