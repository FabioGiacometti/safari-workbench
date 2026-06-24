import { randomUUID } from 'crypto'
import { getAdminClient } from '../supabaseServer.js'
import { badRequest, notFound, conflict, serverError } from '../errors.js'

// Fields the operator may supply on create/update.
// actor/status/provider/id are never accepted from the body.
const ALLOWED_CREATE_FIELDS = [
  'title', 'venue_id', 'year', 'month', 'day',
  'start_time', 'timezone',
  'artist_name', 'artist_profile_url',
  'description', 'image_url',
  'price_min', 'price_max', 'currency',
  'ticket_url', 'category',
]
const ALLOWED_UPDATE_FIELDS = [
  'title', 'year', 'month', 'day',
  'start_time', 'timezone',
  'artist_name', 'artist_profile_url',
  'description', 'image_url',
  'price_min', 'price_max', 'currency',
  'ticket_url', 'category',
]

// ─── helpers ────────────────────────────────────────────────────────────────

async function auditEvent(db, eventId, actor, actionType, beforeState, afterState, notes) {
  try {
    await db.from('editorial_actions').insert({
      actor,
      action_type: actionType,
      entity_type: 'event',
      entity_id: String(eventId),
      before_state: beforeState,
      after_state: afterState,
      notes: notes ?? null,
    })
  } catch (_) {
    // Non-fatal — audit failure must not block the primary action.
  }
}

function pickFields(body, allowed) {
  const out = {}
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k]
  }
  return out
}

async function fetchEvent(db, id) {
  const { data, error } = await db
    .from('events')
    .select('*')
    .eq('id', id)
    .single()
  if (error) return null
  return data
}

async function resolveVenue(db, venueId) {
  const { data, error } = await db
    .from('venues')
    .select('id, canonical_name, lat, lng, merged_into')
    .eq('id', venueId)
    .single()
  if (error || !data) return { venue: null, error: 'venue_not_found' }
  if (data.merged_into)  return { venue: null, error: 'venue_merged' }
  if (!data.lat || !data.lng) return { venue: null, error: 'venue_missing_coordinates' }
  return { venue: data, error: null }
}

function buildDedupeKey(title, venueName, year, month, day) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `manual::${slug}::${venueName}::${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}

// ─── handlers ───────────────────────────────────────────────────────────────

export async function list(req, res, _user) {
  const db = getAdminClient()
  const { data, error } = await db
    .from('events')
    .select('id, title, status, provider, year, month, day, start_time, venue_id, venue_name, city, created_by, published_by, cancelled_by')
    .eq('provider', 'manual')
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .order('day', { ascending: false })
    .limit(100)

  if (error) return serverError(res, 'events list failed', error)
  res.status(200).json({ ok: true, events: data })
}

export async function get(req, res, _user, id) {
  if (!id.startsWith('manual-')) return notFound(res)
  const db = getAdminClient()
  const event = await fetchEvent(db, id)
  if (!event) return notFound(res)
  res.status(200).json({ ok: true, event })
}

export async function create(req, res, user) {
  const body = req.body ?? {}
  const fields = pickFields(body, ALLOWED_CREATE_FIELDS)

  // Required field validation
  const missing = ['title', 'venue_id', 'year', 'month', 'day'].filter(f => !fields[f])
  if (missing.length) return badRequest(res, `missing_fields:${missing.join(',')}`)

  const db = getAdminClient()

  // Venue validation
  const { venue, error: venueErr } = await resolveVenue(db, fields.venue_id)
  if (venueErr) return badRequest(res, venueErr)

  const id = `manual-${randomUUID()}`
  const dedup_key = buildDedupeKey(fields.title, venue.canonical_name, fields.year, fields.month, fields.day)

  const row = {
    id,
    provider: 'manual',
    status: 'draft',
    dedup_key,
    venue_id: venue.id,
    venue_name: venue.canonical_name,
    created_by: user.email,
    ...fields,
    // Never accept these from body:
    actor: undefined,
    published_by: undefined,
    cancelled_by: undefined,
  }
  // Remove undefined keys
  for (const k of Object.keys(row)) { if (row[k] === undefined) delete row[k] }

  // Build media array from image_url if provided
  if (fields.image_url) {
    row.media = [{ url: fields.image_url, type: 'image' }]
    delete row.image_url
  }

  const { data, error } = await db.from('events').insert(row).select().single()
  if (error) {
    if (error.code === '23505') return conflict(res, 'duplicate_event')
    return serverError(res, 'event insert failed', error)
  }

  await auditEvent(db, id, user.email, 'event_created', null, { status: 'draft' })

  res.status(201).json({ ok: true, event: data })
}

export async function update(req, res, user, id) {
  if (!id.startsWith('manual-')) return notFound(res)

  const db = getAdminClient()
  const existing = await fetchEvent(db, id)
  if (!existing) return notFound(res)
  if (existing.status !== 'draft') return conflict(res, 'not_a_draft')

  const body = req.body ?? {}
  const fields = pickFields(body, ALLOWED_UPDATE_FIELDS)

  // Reject attempts to change status directly
  if ('status' in body) return badRequest(res, 'status_change_not_allowed')
  if (Object.keys(fields).length === 0) return badRequest(res, 'no_fields')

  const update = { ...fields, updated_by: user.email }
  if (fields.image_url) {
    update.media = [{ url: fields.image_url, type: 'image' }]
    delete update.image_url
  }

  const { data, error } = await db
    .from('events').update(update).eq('id', id).select().single()
  if (error) return serverError(res, 'event update failed', error)

  await auditEvent(db, id, user.email, 'event_updated',
    pickFields(existing, ALLOWED_UPDATE_FIELDS),
    pickFields(fields, ALLOWED_UPDATE_FIELDS))

  res.status(200).json({ ok: true, event: data })
}

export async function publish(req, res, user, id) {
  if (!id.startsWith('manual-')) return notFound(res)

  const db = getAdminClient()
  const existing = await fetchEvent(db, id)
  if (!existing) return notFound(res)
  if (existing.status !== 'draft') return conflict(res, 'invalid_transition')

  // Re-validate venue on publish
  const { error: venueErr } = await resolveVenue(db, existing.venue_id)
  if (venueErr) return badRequest(res, venueErr)

  const { data, error } = await db
    .from('events')
    .update({
      status: 'published',
      published_by: user.email,
      published_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()

  if (error) return serverError(res, 'event publish failed', error)

  await auditEvent(db, id, user.email, 'event_published',
    { status: 'draft' }, { status: 'published', published_by: user.email })

  res.status(200).json({ ok: true, event: data })
}

export async function cancel(req, res, user, id) {
  if (!id.startsWith('manual-')) return notFound(res)

  const body = req.body ?? {}
  const reason = (body.reason ?? '').trim()
  if (!reason) return badRequest(res, 'cancellation_reason_required')

  const db = getAdminClient()
  const existing = await fetchEvent(db, id)
  if (!existing) return notFound(res)
  if (existing.status !== 'published') return conflict(res, 'invalid_transition')

  const { data, error } = await db
    .from('events')
    .update({
      status: 'cancelled',
      cancelled_by: user.email,
      cancelled_at: new Date().toISOString(),
      cancellation_reason: reason,
    })
    .eq('id', id)
    .select()
    .single()

  if (error) return serverError(res, 'event cancel failed', error)

  await auditEvent(db, id, user.email, 'event_cancelled',
    { status: 'published' }, { status: 'cancelled', cancelled_by: user.email, reason })

  res.status(200).json({ ok: true, event: data })
}

export async function audit(req, res, _user, id) {
  if (!id.startsWith('manual-')) return notFound(res)

  const db = getAdminClient()
  const { data, error } = await db
    .from('editorial_actions')
    .select('id, actor, action_type, before_state, after_state, notes, created_at')
    .eq('entity_id', id)
    .order('created_at', { ascending: true })

  if (error) return serverError(res, 'audit fetch failed', error)
  res.status(200).json({ ok: true, entries: data })
}
