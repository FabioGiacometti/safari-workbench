import { getAdminClient } from '../supabaseServer.js'
import { serverError, badRequest, notFound } from '../errors.js'

// UUID pattern (accepts any RFC 4122 variant — venues.id is a plain uuid)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_FILTER_LEN    = 100
const VALID_LIST_STATUS = ['active', 'merged', 'all']
const VALID_ORDER       = ['events', 'name', 'city']
const DEFAULT_LIMIT     = 100
const MAX_LIMIT         = 200

export async function search(req, res, _user) {
  const q = (req.query.q ?? '').trim()
  const limit = Math.min(parseInt(req.query.limit ?? '20', 10) || 20, 50)

  if (!q) return badRequest(res, 'missing_q')

  const db = getAdminClient()

  const { data, error } = await db
    .from('venues')
    .select('id, canonical_name, city, lat, lng, merged_into')
    .is('merged_into', null)
    .not('lat', 'is', null)
    .ilike('canonical_name', `%${q}%`)
    .limit(limit)

  if (error) return serverError(res, 'venue search failed', error)

  res.status(200).json({ ok: true, venues: data })
}

// GET /api/admin/venues
export async function list(req, res, _user) {
  const search = (req.query.search ?? '').trim()
  const city   = (req.query.city ?? '').trim()
  const noCity = req.query.no_city === 'true' || req.query.no_city === '1'
  const status = req.query.status ?? 'active'
  const order  = req.query.order ?? 'events'

  if (!VALID_LIST_STATUS.includes(status)) return badRequest(res, 'invalid_status')
  if (!VALID_ORDER.includes(order))        return badRequest(res, 'invalid_order')
  if (search.length > MAX_FILTER_LEN)      return badRequest(res, 'search_too_long')
  if (city.length > MAX_FILTER_LEN)        return badRequest(res, 'city_too_long')

  let limit  = parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10)
  let offset = parseInt(req.query.offset ?? '0', 10)
  if (!Number.isFinite(limit)  || limit  <= 0) limit  = DEFAULT_LIMIT
  if (!Number.isFinite(offset) || offset <  0) offset = 0
  limit = Math.min(limit, MAX_LIMIT)

  const db = getAdminClient()
  let q = db
    .from('venues_catalog')
    .select('*', { count: 'exact' })
    .range(offset, offset + limit - 1)

  if (search)              q = q.ilike('canonical_name', `%${search}%`)
  if (city)                q = q.ilike('city', `%${city}%`)
  if (noCity)              q = q.is('city', null)
  if (status === 'active') q = q.is('merged_into', null)
  if (status === 'merged') q = q.not('merged_into', 'is', null)

  if (order === 'name')   q = q.order('canonical_name', { ascending: true })
  if (order === 'events') q = q.order('real_event_count', { ascending: false })
  if (order === 'city')   q = q.order('city', { ascending: true, nullsFirst: false })

  const { data, error, count } = await q
  if (error) return serverError(res, 'venue list failed', error)

  // Drift filter stays client-side (no stored column on the view to filter against).
  res.status(200).json({ ok: true, venues: data ?? [], total: count ?? 0 })
}

// GET /api/admin/venues/:id
export async function detail(req, res, _user, venueId) {
  if (!UUID_RE.test(venueId)) return badRequest(res, 'invalid_venue_id')

  const db = getAdminClient()

  // The venue row itself is mandatory — fetch it first.
  const { data: venue, error: venueErr } = await db
    .from('venues_catalog')
    .select('*')
    .eq('id', venueId)
    .single()

  if (venueErr) {
    if (venueErr.code === 'PGRST116') return notFound(res, 'venue_not_found')
    return serverError(res, 'venue detail fetch failed', venueErr)
  }
  if (!venue) return notFound(res, 'venue_not_found')

  // Sub-resource queries fan out in parallel. Each may fail independently —
  // failures are reported via section_errors + partial flag, never fatal.
  const section_errors = {}
  let partial = false

  const settle = async (key, promise) => {
    try {
      const { data, error } = await promise
      if (error) {
        section_errors[key] = error.message ?? 'query_failed'
        partial = true
        return null
      }
      return data ?? []
    } catch (e) {
      section_errors[key] = e?.message ?? 'query_failed'
      partial = true
      return null
    }
  }

  const [events, merge_history, mutations, rules] = await Promise.all([
    settle('events',
      db.from('events')
        .select('id, title, venue_name, city, year, month, day, provider, venue_fingerprint')
        .eq('venue_id', venueId)
        .order('year',  { ascending: false })
        .order('month', { ascending: false })
        .order('day',   { ascending: false })
        .limit(20)),
    settle('merge_history',
      db.from('venue_merge_event_log')
        .select('id, candidate_id, event_id, old_venue_id, new_venue_id, old_fingerprint, new_fingerprint, merged_at')
        .or(`old_venue_id.eq.${venueId},new_venue_id.eq.${venueId}`)
        .order('merged_at', { ascending: false })
        .limit(20)),
    settle('mutations',
      db.from('venue_mutations')
        .select('id, mutation_type, provider, occurred_at, old_value, new_value')
        .eq('venue_id', venueId)
        .order('occurred_at', { ascending: false })
        .limit(10)),
    settle('rules',
      db.from('canonical_rules')
        .select('id, match_raw_location, match_provider, type, scope, source, confidence, notes, created_by, created_at, venue_id')
        .or(`venue_id.eq.${venueId},match_raw_location.eq.${venue.canonical_name}`)
        .order('created_at', { ascending: false })
        .limit(10)),
  ])

  // If merged, fetch the winning venue (minimal projection).
  let merged_into_venue = null
  if (venue.merged_into) {
    merged_into_venue = await settle('merged_into_venue',
      db.from('venues')
        .select('id, canonical_name, city, fingerprint')
        .eq('id', venue.merged_into)
        .single())
  }

  res.status(200).json({
    ok: true,
    partial,
    section_errors,
    venue,
    events,
    merge_history,
    mutations,
    rules,
    merged_into_venue,
  })
}

// Maps an edit_venue RPC error to an HTTP status + sanitized client payload.
// RPC messages use a stable 'code:field:detail' prefix split on ':'.
function mapEditError(err) {
  const msg   = err?.message ?? ''
  const parts = msg.split(':')
  const code  = (parts[0] ?? '').trim()
  const field = (parts[1] ?? '').trim() || undefined

  switch (code) {
    case 'venue not found':     return { status: 404, body: { ok: false, error: 'venue_not_found' } }
    case 'venue is merged':     return { status: 409, body: { ok: false, error: 'venue_is_merged' } }
    case 'no changes':          return { status: 409, body: { ok: false, error: 'no_changes' } }
    case 'empty fields':        return { status: 400, body: { ok: false, error: 'missing_fields' } }
    case 'unknown field':       return { status: 400, body: { ok: false, error: 'unknown_field', field } }
    case 'invalid_type':        return { status: 400, body: { ok: false, error: 'invalid_type', field } }
    case 'invalid_value':       return { status: 400, body: { ok: false, error: 'invalid_value', field } }
    case 'invalid_coordinates': return { status: 400, body: { ok: false, error: 'invalid_coordinates' } }
    case 'invalid actor':       return { status: 400, body: { ok: false, error: 'invalid_actor' } }
    default:                    return null
  }
}

// Maps a create_manual_venue RPC error to an HTTP status + sanitized client payload.
// Error messages use the same 'code:field:detail' format as edit_venue.
function mapCreateError(err) {
  const msg   = err?.message ?? ''
  const parts = msg.split(':')
  const code  = (parts[0] ?? '').trim()
  const field = (parts[1] ?? '').trim() || undefined

  switch (code) {
    case 'required':           return { status: 422, body: { ok: false, error: 'required', field } }
    case 'invalid_type':       return { status: 400, body: { ok: false, error: 'invalid_type', field } }
    case 'invalid_value':      return { status: 400, body: { ok: false, error: 'invalid_value', field } }
    case 'invalid_coordinates':return { status: 400, body: { ok: false, error: 'invalid_coordinates' } }
    case 'invalid actor':      return { status: 400, body: { ok: false, error: 'invalid_actor' } }
    case 'unknown field':      return { status: 400, body: { ok: false, error: 'unknown_field', field } }
    case 'empty fields':       return { status: 400, body: { ok: false, error: 'missing_fields' } }
    case 'duplicate_venue':    return { status: 409, body: { ok: false, error: 'duplicate_venue' } }
    default:                   return null
  }
}

// POST /api/admin/venues
export async function create(req, res, user) {
  const body = req.body ?? {}

  // Never accept created_by, origin, or actor from the browser.
  // Actor comes exclusively from the authenticated session.
  const fields = body.fields
  const override_reason = typeof body.override_reason === 'string'
    ? body.override_reason.trim() || null
    : null

  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
    return badRequest(res, 'missing_fields')
  }
  if (Object.keys(fields).length === 0) return badRequest(res, 'missing_fields')

  const actor = user.email

  const db = getAdminClient()

  const { data, error } = await db.rpc('create_manual_venue', {
    p_fields:          fields,
    p_actor:           actor,
    p_override_reason: override_reason,
  })

  if (error) {
    const mapped = mapCreateError(error)
    if (mapped) return res.status(mapped.status).json(mapped.body)
    return serverError(res, 'create_manual_venue rpc failed', error)
  }

  if (!data || data.ok !== true) {
    return serverError(res, 'create_manual_venue returned non-ok', data)
  }

  // Fetch the full venue record so the client can navigate to the detail panel.
  const { data: venue, error: fetchErr } = await db
    .from('venues_catalog')
    .select('*')
    .eq('id', data.venue_id)
    .single()

  if (fetchErr) return serverError(res, 'venue fetch after create failed', fetchErr)

  return res.status(201).json({ ok: true, venue_id: data.venue_id, venue })
}

// PATCH /api/admin/venues/:id
export async function update(req, res, user, venueId) {
  if (!UUID_RE.test(venueId)) return badRequest(res, 'invalid_venue_id')

  const body   = req.body ?? {}
  const fields = body.fields

  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
    return badRequest(res, 'missing_fields')
  }
  if (Object.keys(fields).length === 0) return badRequest(res, 'missing_fields')

  // Actor identity is taken exclusively from the authenticated operator session.
  const actor = user.email

  const db = getAdminClient()

  const { data, error } = await db.rpc('edit_venue', {
    p_venue_id: venueId,
    p_fields:   fields,
    p_actor:    actor,
  })

  if (error) {
    const mapped = mapEditError(error)
    if (mapped) return res.status(mapped.status).json(mapped.body)
    return serverError(res, 'edit_venue rpc failed', error)
  }

  if (!data || data.ok !== true) {
    return serverError(res, 'edit_venue returned non-ok', data)
  }

  // Re-fetch authoritative state from the catalog view so the client can
  // update its detail panel without a second round-trip. A re-fetch failure
  // is a 500 (never venue:null) — the edit committed, but state is unknown.
  const { data: venue, error: refetchErr } = await db
    .from('venues_catalog')
    .select('*')
    .eq('id', venueId)
    .single()

  if (refetchErr) return serverError(res, 'venue re-fetch after edit failed', refetchErr)

  res.status(200).json({
    ok:           true,
    changes:      data.changes,
    diff:         data.diff,
    city_warning: data.city_warning ?? null,
    venue,
  })
}
