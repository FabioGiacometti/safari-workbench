import { getAdminClient } from '../supabaseServer.js'
import { badRequest, notFound, conflict, serverError } from '../errors.js'

const VALID_STATUSES = ['open', 'keep_manual', 'accept_provider', 'dismissed']
const VALID_ACTIONS  = ['keep_manual', 'accept_provider', 'dismissed']
const MAX_FILTER_LEN = 100
const MAX_LIMIT      = 500

// UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// venue_discrepancies.id is bigint (positive integer PK, not UUID)
function parseDiscId(raw) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

// ---------------------------------------------------------------------------
// Field compatibility table — derived from actual venues schema inspection.
//
// resolve_venue_discrepancy uses dynamic SQL:
//   UPDATE venues SET <field_name> = (provider_value ->> 'value')
// The ->> operator always returns text. PostgreSQL will cast text→text silently,
// but text→double precision (or any numeric) raises error 42804 at runtime.
//
// Classification key:
//   supported   — text column, proven compatible with the RPC's text assignment
//   numeric     — double precision or integer; RPC raises 42804 — blocked here
//   json_array  — jsonb or text[]; RPC would raise type error — blocked here
//   timestamp   — timestamptz; RPC would raise type error — blocked here
//   unknown     — anything else or a newly-seen field — blocked by default
//
// Technical debt: resolve_venue_discrepancy lacks type-aware casting. A separate
// RPC-hardening loop is required before numeric fields can use accept_provider.
// ---------------------------------------------------------------------------
const FIELD_COMPAT = {
  // text columns — supported
  canonical_name: 'supported',
  display_name:   'supported',
  city:           'supported',
  region:         'supported',
  address:        'supported',
  category:       'supported',
  accessibility:  'supported',
  image_url:      'supported',
  description:    'supported',
  merged_by:      'supported',

  // double precision — unsupported (42804 at runtime)
  lat:                  'numeric',
  lng:                  'numeric',
  geo_confidence:       'numeric',
  resolution_confidence:'numeric',

  // integer — unsupported
  provider_count: 'numeric',
  event_count:    'numeric',
  capacity:       'numeric',

  // jsonb/array — unsupported
  social_links:          'json_array',
  aliases:               'json_array',
  manually_edited_fields:'json_array',

  // timestamptz — unsupported
  first_seen_at: 'timestamp',
  last_seen_at:  'timestamp',
  created_at:    'timestamp',
  updated_at:    'timestamp',
  merged_at:     'timestamp',
}

// Fields the client may expose "Aceptar provider" for.
// Exported so the list endpoint can include it in responses.
export const ACCEPT_PROVIDER_SUPPORTED_FIELDS = Object.entries(FIELD_COMPAT)
  .filter(([, v]) => v === 'supported')
  .map(([k]) => k)

function mapRpcError(err) {
  // err.code 'P0001' is a RAISE EXCEPTION from the function body
  if (err.code === 'P0001') {
    const msg = err.message ?? ''
    if (msg.includes('not found'))      return { status: 404, code: 'discrepancy_not_found' }
    if (msg.includes('already closed')) return { status: 409, code: 'already_resolved' }
    if (msg.includes('invalid action')) return { status: 400, code: 'invalid_action' }
    return { status: 400, code: 'rpc_error' }
  }
  return null
}

// GET /api/admin/discrepancies
export async function list(req, res, _user) {
  const { status, provider, field } = req.query

  if (status   && !VALID_STATUSES.includes(status))  return badRequest(res, 'invalid_status')
  if (provider && provider.length > MAX_FILTER_LEN)  return badRequest(res, 'provider_too_long')
  if (field    && field.length > MAX_FILTER_LEN)     return badRequest(res, 'field_too_long')

  const db = getAdminClient()
  let q = db
    .from('venue_discrepancies')
    .select(`
      id, venue_id, field_name, manual_value, provider_value, provider,
      detected_at, status, resolved_at, resolved_by, resolution,
      venues ( id, canonical_name, fingerprint, city )
    `)
    .order('status',      { ascending: true })
    .order('detected_at', { ascending: false })
    .limit(MAX_LIMIT)

  if (status)   q = q.eq('status',     status)
  if (provider) q = q.eq('provider',   provider)
  if (field)    q = q.eq('field_name', field)

  const { data, error } = await q
  if (error) return serverError(res, 'discrepancy list failed', error)

  res.status(200).json({
    ok: true,
    discrepancies: data,
    accept_provider_supported_fields: ACCEPT_PROVIDER_SUPPORTED_FIELDS,
  })
}

// GET /api/admin/venues/:venueId/discrepancies
export async function listForVenue(req, res, _user, venueId) {
  if (!UUID_RE.test(venueId)) return badRequest(res, 'invalid_venue_id')

  const db = getAdminClient()
  const { data, error } = await db
    .from('venue_discrepancies')
    .select('id, field_name, manual_value, provider_value, provider, detected_at, status, resolved_at, resolved_by, resolution')
    .eq('venue_id', venueId)
    .order('status',      { ascending: true })
    .order('detected_at', { ascending: false })
    .limit(50)

  if (error) return serverError(res, 'venue discrepancy list failed', error)

  res.status(200).json({
    ok: true,
    discrepancies: data,
    accept_provider_supported_fields: ACCEPT_PROVIDER_SUPPORTED_FIELDS,
  })
}

// POST /api/admin/discrepancies/:id/resolve
export async function resolve(req, res, user, discId) {
  const id = parseDiscId(discId)
  if (!id) return badRequest(res, 'invalid_discrepancy_id')

  const body   = req.body ?? {}
  const action = body.action

  if (!action)                        return badRequest(res, 'missing_action')
  if (!VALID_ACTIONS.includes(action)) return badRequest(res, 'invalid_action')

  // Actor identity comes exclusively from the authenticated operator session.
  // Any actor-like field in the body is ignored.
  const actor = user.email

  const db = getAdminClient()

  // For accept_provider: fetch the discrepancy first, then check field compatibility
  // before invoking the RPC. This prevents a PostgreSQL 42804 runtime error for
  // numeric fields (lat, lng, geo_confidence, etc.) that the RPC cannot currently
  // handle because it assigns provider_value->>value (always text) directly to the
  // column without casting.
  if (action === 'accept_provider') {
    const { data: disc, error: fetchErr } = await db
      .from('venue_discrepancies')
      .select('id, status, field_name, venue_id, manual_value, provider_value')
      .eq('id', id)
      .single()

    if (fetchErr || !disc) return notFound(res, 'discrepancy_not_found')
    if (disc.status !== 'open') return conflict(res, 'already_resolved')

    const compat = FIELD_COMPAT[disc.field_name] ?? 'unknown'
    if (compat !== 'supported') {
      return res.status(409).json({
        ok: false,
        error: 'unsupported_field_type',
        field: disc.field_name,
        field_type: compat,
        message: `El campo "${disc.field_name}" (${compat}) no puede ser aceptado automáticamente. Usá "Conservar manual" o "Descartar".`,
      })
    }
  }

  const { data, error } = await db.rpc('resolve_venue_discrepancy', {
    p_discrepancy_id: id,
    p_action:         action,
    p_actor:          actor,
  })

  if (error) {
    const mapped = mapRpcError(error)
    if (mapped) {
      return res.status(mapped.status).json({ ok: false, error: mapped.code })
    }
    return serverError(res, 'resolve_venue_discrepancy rpc failed', error)
  }

  if (data && data.ok === false) {
    return res.status(400).json({ ok: false, error: data.error ?? 'rpc_returned_error' })
  }

  // For accept_provider: return fresh venue data so the client can update
  // both the discrepancy row and the venue detail in a single response.
  if (action === 'accept_provider' && data?.venue_id) {
    const { data: venue } = await db
      .from('venues')
      .select('id, canonical_name, lat, lng, city, region, geo_confidence, manually_edited_fields, updated_at')
      .eq('id', data.venue_id)
      .single()
    return res.status(200).json({ ok: true, resolution: data, venue: venue ?? null })
  }

  res.status(200).json({ ok: true, resolution: data })
}
