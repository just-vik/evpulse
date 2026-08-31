'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Loader, AlertCircle } from 'lucide-react'
import { EVPulseLogo } from '@/components/branding/EVPulseLogo'
import { useAuth } from '@/hooks/useAuth'

export default function LoginPage() {

  const { login } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {

    e.preventDefault()

    if (loading) return

    setError(null)
    setLoading(true)

    try {

      await login(email.trim(), password)

      // Full navigation so middleware sees the httpOnly cookie and
      // Zustand rehydrates cleanly — router.push() has a race with
      // the persist rehydration and the double useEffect redirect.
      window.location.href = '/dashboard'

    } catch (err: unknown) {

      console.error('Login error:', err)

      if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('Invalid email or password')
      }

    } finally {

      setLoading(false)

    }

  }

  return (

    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >

        {/* Logo */}

        <div className="flex items-center justify-center mb-8">
          <EVPulseLogo size="large" withLink={false} className="brightness-110" />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8">

          <h1 className="text-2xl font-bold text-white mb-1">
            Welcome back
          </h1>

          <p className="text-slate-400 text-sm mb-6">
            Sign in to your account
          </p>

          {error && (

            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm mb-5">
              <AlertCircle size={16} className="shrink-0" />
              {error}
            </div>

          )}

          <form onSubmit={handleSubmit} className="space-y-4">

            {/* EMAIL */}

            <div>

              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                Email
              </label>

              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />

            </div>

            {/* PASSWORD */}

            <div>

              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                Password
              </label>

              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />

            </div>

            {/* SUBMIT */}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-colors flex items-center justify-center gap-2"
            >

              {loading && (
                <Loader size={16} className="animate-spin" />
              )}

              {loading ? 'Signing in...' : 'Sign in'}

            </button>

          </form>

          {/* REGISTER */}

          <p className="text-center text-sm text-slate-400 mt-6">

            No account?{' '}

            <Link
              href="/register"
              className="text-blue-400 hover:text-blue-300 font-medium transition-colors"
            >

              Create one

            </Link>

          </p>

        </div>

      </motion.div>

    </div>

  )

}