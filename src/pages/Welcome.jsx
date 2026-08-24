import React from 'react'
import { Link } from 'react-router-dom'

export default function Welcome() {
  return (
    <div className="min-h-screen bg-navy flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-10 justify-center">
          <svg width="48" height="48" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="8" fill="#c9a84c"/>
            <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
            <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
          </svg>
          <div>
            <div className="text-white font-bold text-2xl leading-none">annie</div>
            <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
          </div>
        </div>
        <div className="bg-white rounded-2xl p-8 shadow-2xl text-center">
          <div className="w-14 h-14 rounded-full bg-yellow-50 border-2 border-gold flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">✉️</span>
          </div>
          <h1 className="text-2xl font-bold text-navy mb-2">You're in, check your email</h1>
          <p className="text-gray-500 text-sm mb-6">Your trial has started. We've sent a link to set your password and get into Annie. It can take a couple of minutes to arrive, check spam if you don't see it.</p>
          <Link to="/login" className="text-gold font-semibold text-sm hover:underline">Already set your password? Sign in</Link>
        </div>
      </div>
    </div>
  )
}
