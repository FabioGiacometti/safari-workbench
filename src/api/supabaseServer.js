import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL

// Auth-verification client: uses the anon key.
// Calls auth.getUser(token) against the Supabase Auth server.
// Must not be used for privileged DB access.
export function getAuthClient() {
  const key = process.env.SUPABASE_ANON_KEY
  if (!SUPABASE_URL || !key) throw new Error('missing SUPABASE_URL or SUPABASE_ANON_KEY')
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false } })
}

// Administrative DB client: uses the service-role key.
// Only created after authentication succeeds via getAuthClient().
export function getAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !key) throw new Error('missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false } })
}
