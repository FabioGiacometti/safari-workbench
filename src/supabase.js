import { createClient } from '@supabase/supabase-js'

// TEMPORARY COMPATIBILITY FIX — delete this file when the last legacy tab is serverized.
// Without persistSession:false, supabase-js v2 reads the shared sb-<ref>-auth-token
// localStorage slot (written by authClient on login) and injects the user JWT as the
// Authorization header on every REST request, overriding the service-role key and causing
// RLS to return empty results silently.
//
// This does NOT make browser-side service-role access secure.  VITE_SUPABASE_KEY (service-role)
// must be removed from the client bundle and rotated after Steps C–E are complete and all
// legacy tabs (Conflictos, VenueCatalog, VenueCandidates, VenueDiscrepancies) have been
// serverized via /api/admin/*.  See CLAUDE.md §Migration status.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY,
  { auth: { persistSession: false } }
)
