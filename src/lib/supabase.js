import { createClient } from '@supabase/supabase-js'

const normalizeEnvValue = (value) => {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().replace(/^['\"]|['\"]$/g, '')
}

const supabaseUrl = normalizeEnvValue(import.meta.env.VITE_SUPABASE_URL)
const supabaseAnonKey = normalizeEnvValue(import.meta.env.VITE_SUPABASE_ANON_KEY)

export const missingSupabaseEnv = [
  ['VITE_SUPABASE_URL', supabaseUrl],
  ['VITE_SUPABASE_ANON_KEY', supabaseAnonKey],
]
  .filter(([, value]) => !value)
  .map(([name]) => name)

export const isSupabaseConfigured = missingSupabaseEnv.length === 0

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null
