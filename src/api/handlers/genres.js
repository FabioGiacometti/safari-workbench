import { getAdminClient } from '../supabaseServer.js'
import { serverError, badRequest, notFound } from '../errors.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/admin/genres
// Returns the full active genre vocabulary ordered by display_order.
export async function list(req, res, _user) {
  const db = getAdminClient()
  const { data, error } = await db
    .from('genres')
    .select('id, slug, name')
    .eq('is_active', true)
    .order('display_order')
    .order('name') // deterministic tie-breaker

  if (error) return serverError(res, 'genres list failed', error)
  res.status(200).json({ ok: true, genres: data ?? [] })
}

// GET /api/admin/venues/:id/genres
// Returns the genre associations for a single venue, ordered by display_order.
export async function getForVenue(req, res, _user, venueId) {
  if (!UUID_RE.test(venueId)) return badRequest(res, 'invalid_venue_id')

  const db = getAdminClient()

  // Two flat queries — consistent with the repository pattern (no nested selects used).
  const { data: vgRows, error: vgErr } = await db
    .from('venue_genres')
    .select('genre_id')
    .eq('venue_id', venueId)

  if (vgErr) return serverError(res, 'venue_genres fetch failed', vgErr)

  const genreIds = (vgRows ?? []).map(r => r.genre_id)

  if (genreIds.length === 0) {
    return res.status(200).json({ ok: true, genres: [] })
  }

  const { data: genreRows, error: gErr } = await db
    .from('genres')
    .select('id, slug, name')
    .in('id', genreIds)
    .eq('is_active', true)
    .order('display_order')
    .order('name')

  if (gErr) return serverError(res, 'genres fetch failed', gErr)

  res.status(200).json({ ok: true, genres: genreRows ?? [] })
}

// PUT /api/admin/venues/:id/genres
// Atomically replaces the full genre set for a venue.
// Body: { genre_ids: number[] }
// Actor is always derived from the authenticated operator session — never from the body.
export async function setForVenue(req, res, user, venueId) {
  if (!UUID_RE.test(venueId)) return badRequest(res, 'invalid_venue_id')

  const body = req.body ?? {}
  const { genre_ids } = body

  if (!Array.isArray(genre_ids)) {
    return badRequest(res, 'genre_ids must be an array')
  }
  if (!genre_ids.every(id => Number.isInteger(id) && id > 0)) {
    return badRequest(res, 'genre_ids must contain only positive integers')
  }

  const actor = user.email
  const db = getAdminClient()

  const { data, error } = await db.rpc('set_venue_genres', {
    p_venue_id:  venueId,
    p_genre_ids: genre_ids,
    p_actor:     actor,
  })

  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('venue_not_found')) return notFound(res, 'venue_not_found')
    if (msg.includes('venue_is_merged')) return res.status(409).json({ ok: false, error: 'venue_is_merged' })
    if (msg.includes('invalid_genre_id')) return badRequest(res, 'invalid_genre_id')
    if (msg.includes('invalid_actor'))    return badRequest(res, 'invalid_actor')
    return serverError(res, 'set_venue_genres rpc failed', error)
  }

  // data is the JSONB returned by the RPC: { ok, changed, genre_ids }
  res.status(200).json({
    ok:        true,
    changed:   data?.changed ?? false,
    genre_ids: data?.genre_ids ?? [],
  })
}
