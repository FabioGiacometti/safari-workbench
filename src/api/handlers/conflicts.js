import { getAdminClient } from '../supabaseServer.js'
import { serverError, badRequest, notFound, conflict as conflictRes } from '../errors.js'

const ACTIVE_STATUSES = ['open', 'in_review', 'resolution_failed']

// GET /api/admin/conflicts
export async function list(req, res, _user) {
  const db = getAdminClient()
  const { data, error } = await db
    .from('resolution_conflicts')
    .select('*')
    .in('status', ACTIVE_STATUSES)
    .order('affected_count', { ascending: false })

  if (error) return serverError(res, 'conflicts list failed', error)
  res.status(200).json({ ok: true, rows: data ?? [], total: (data ?? []).length })
}

// GET /api/admin/conflicts/:id/events
export async function events(req, res, _user, conflictId) {
  const db = getAdminClient()

  const { data: c, error: ce } = await db
    .from('resolution_conflicts')
    .select('sample_event_ids')
    .eq('id', conflictId)
    .maybeSingle()

  if (ce)  return serverError(res, 'conflict events lookup failed', ce)
  if (!c)  return notFound(res, 'conflict_not_found')

  const ids = c.sample_event_ids ?? []
  if (ids.length === 0) return res.status(200).json({ ok: true, events: [] })

  const { data, error } = await db
    .from('events')
    .select('title, venue_name, city, geo_confidence, geo_source')
    .in('id', ids)

  if (error) return serverError(res, 'conflict sample events failed', error)
  res.status(200).json({ ok: true, events: data ?? [] })
}

// GET /api/admin/conflicts/:id/rules
export async function rules(req, res, _user, conflictId) {
  const db = getAdminClient()

  const { data: c, error: ce } = await db
    .from('resolution_conflicts')
    .select('raw_value')
    .eq('id', conflictId)
    .maybeSingle()

  if (ce)  return serverError(res, 'conflict rules lookup failed', ce)
  if (!c)  return notFound(res, 'conflict_not_found')

  if (c.raw_value === null) return res.status(200).json({ ok: true, rules: [] })

  const { data, error } = await db
    .from('canonical_rules')
    .select('id, match_provider, geo_entity_id, type, scope, source, notes, created_at')
    .eq('match_raw_location', c.raw_value)
    .order('created_at', { ascending: false })

  if (error) return serverError(res, 'canonical rules lookup failed', error)
  res.status(200).json({ ok: true, rules: data ?? [] })
}

// GET /api/admin/geo-entities
// Without ?q= : returns full list (legacy — used by non-VENUE_WITHOUT_GEO paths for now)
// With    ?q= : returns ≤20 search results ranked exact/prefix/fuzzy (used by GeoEntityCombobox)
export async function geoEntities(req, res, _user) {
  const q = (req.query?.q ?? '').trim()

  if (q) {
    if (q.length < 2) return badRequest(res, 'query_too_short')
    return _geoEntitySearch(res, q)
  }

  const db = getAdminClient()
  const { data, error } = await db
    .from('geo_entities')
    .select('id, display_name, level, country_code, region')
    .eq('status', 'active')
    .order('display_name')

  if (error) return serverError(res, 'geo entities list failed', error)
  res.status(200).json({ ok: true, entities: data ?? [] })
}

// GET /api/admin/geo-entities/search?q=   (explicit search sub-path)
export async function geoEntitySearch(req, res, _user) {
  const q = (req.query?.q ?? '').trim()
  if (q.length < 2) return badRequest(res, 'query_too_short')
  return _geoEntitySearch(res, q)
}

async function _geoEntitySearch(res, q) {
  const db  = getAdminClient()
  const MAX = 20

  // Fetch candidates: ilike on display_name covers most cases.
  // We pull a larger set then rank client-side so exact/prefix wins over fuzzy.
  const { data, error } = await db
    .from('geo_entities')
    .select('id, display_name, level, country_code, region')
    .eq('status', 'active')
    .ilike('display_name', `%${q}%`)
    .limit(100)

  if (error) return serverError(res, 'geo entity search failed', error)

  const lower = q.toLowerCase()
  const ranked = (data ?? [])
    .map(e => {
      const name = e.display_name.toLowerCase()
      const score = name === lower           ? 0   // exact
                  : name.startsWith(lower)   ? 1   // prefix
                  : name.includes(lower)     ? 2   // substring
                  : 3                              // should not occur given ilike
      return { ...e, _score: score }
    })
    .sort((a, b) => a._score - b._score || a.display_name.localeCompare(b.display_name))
    .slice(0, MAX)
    .map(({ _score, ...e }) => e)

  res.status(200).json({ ok: true, entities: ranked, query: q })
}

// POST /api/admin/conflicts/:id/in-review
export async function inReview(req, res, user, conflictId) {
  return _transition(res, conflictId, 'in_review', user.email)
}

// POST /api/admin/conflicts/:id/dismiss
export async function dismiss(req, res, user, conflictId) {
  return _transition(res, conflictId, 'dismiss', user.email)
}

// POST /api/admin/conflicts/:id/provider-bug
export async function providerBug(req, res, user, conflictId) {
  return _transition(res, conflictId, 'provider_bug', user.email)
}

// POST /api/admin/conflicts/:id/resolve-rule
// Body: { geo_entity_id: string, provider_scope: string }
export async function resolveRule(req, res, user, conflictId) {
  const geo_entity_id  = (req.body?.geo_entity_id  ?? '').trim()
  const provider_scope = req.body?.provider_scope ?? null  // null = not supplied

  if (!geo_entity_id) return badRequest(res, 'missing_geo_entity_id')
  // provider_scope may be '' (global) or a provider string — null means not supplied
  if (provider_scope === null) return badRequest(res, 'missing_provider_scope')

  const db = getAdminClient()
  const { data, error } = await db.rpc('resolve_conflict_with_rule', {
    p_conflict_id:    conflictId,
    p_geo_entity_id:  geo_entity_id,
    p_provider_scope: provider_scope,
    p_actor:          user.email,
  })

  if (error) return mapConflictError(res, error, 'resolve_conflict_with_rule')
  res.status(200).json({ ok: true, conflict_id: conflictId, result: data })
}

// POST /api/admin/conflicts/:id/resolve-venue-geo
// Body: { geo_entity_id: string }
export async function resolveVenueGeo(req, res, user, conflictId) {
  const geo_entity_id = (req.body?.geo_entity_id ?? '').trim()
  if (!geo_entity_id) return badRequest(res, 'missing_geo_entity_id')

  const db = getAdminClient()
  const { data, error } = await db.rpc('resolve_conflict_venue_geo', {
    p_conflict_id:   conflictId,
    p_geo_entity_id: geo_entity_id,
    p_actor:         user.email,
  })

  if (error) return mapConflictError(res, error, 'resolve_conflict_venue_geo')
  res.status(200).json({ ok: true, conflict_id: conflictId, result: data })
}

// POST /api/admin/conflicts/:id/reconcile
// Closes a VENUE_WITHOUT_GEO conflict whose referenced venue already has valid geo_entity_id.
// No new geo selection required — the venue was already correctly tagged by a prior resolution.
export async function reconcileVenueGeo(req, res, user, conflictId) {
  const db = getAdminClient()
  const { data, error } = await db.rpc('reconcile_venue_without_geo', {
    p_conflict_id: conflictId,
    p_actor:       user.email,
  })

  if (error) return mapConflictError(res, error, 'reconcile_venue_without_geo')
  res.status(200).json({ ok: true, conflict_id: conflictId, result: data })
}

// POST /api/admin/conflicts/:id/resolve-discovery
// Body: { action: 'approve' | 'reject' }
export async function resolveDiscovery(req, res, user, conflictId) {
  const action = (req.body?.action ?? '').trim()
  if (!['approve', 'reject'].includes(action)) return badRequest(res, 'invalid_action')

  const db = getAdminClient()
  const { data, error } = await db.rpc('resolve_conflict_discovery', {
    p_conflict_id: conflictId,
    p_action:      action,
    p_actor:       user.email,
  })

  if (error) return mapConflictError(res, error, 'resolve_conflict_discovery')
  res.status(200).json({ ok: true, conflict_id: conflictId, result: data })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _transition(res, conflictId, action, actor) {
  const db = getAdminClient()
  const { data, error } = await db.rpc('transition_conflict', {
    p_conflict_id: conflictId,
    p_action:      action,
    p_actor:       actor,
  })

  if (error) return mapConflictError(res, error, 'transition_conflict')
  res.status(200).json({ ok: true, conflict_id: conflictId, result: data })
}

function mapConflictError(res, err, rpcName) {
  const msg  = err?.message ?? ''
  const code = msg.split('::')[0]?.trim()
  switch (code) {
    case 'not_found':            return notFound(res, 'conflict_not_found')
    case 'invalid_action':       return badRequest(res, 'invalid_action')
    case 'invalid_transition':   return conflictRes(res, 'invalid_transition')
    case 'wrong_conflict_type':  return badRequest(res, 'wrong_conflict_type')
    case 'no_rule_possible':     return badRequest(res, 'no_rule_possible')
    case 'venue_not_found':      return notFound(res, 'venue_not_found')
    case 'no_discovery_candidate': return notFound(res, 'no_discovery_candidate')
    case 'not_satisfied':          return badRequest(res, 'venue_geo_not_yet_set')
    default:                       return serverError(res, `${rpcName} failed`, err)
  }
}
