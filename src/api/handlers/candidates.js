import { getAdminClient } from '../supabaseServer.js'
import { serverError, badRequest, notFound, conflict } from '../errors.js'

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 50

const VALID_STATUSES = ['pending', 'approved', 'rejected', 'merged', 'rolled_back', 'all']

// GET /api/admin/venue-candidates?status=pending&page=1
export async function list(req, res, _user) {
  const status = req.query.status ?? 'pending'
  const page   = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

  if (!VALID_STATUSES.includes(status)) return badRequest(res, 'invalid_status')

  const db = getAdminClient()

  let q = db
    .from('venue_merge_candidates')
    .select(`
      id, candidate_type, confidence, status, rejection_reason, created_at,
      rule_was_created, created_rule_id,
      keep:venue_id_keep ( id, canonical_name, city, fingerprint, lat, lng, event_count ),
      drop:venue_id_drop ( id, canonical_name, city, fingerprint, lat, lng, event_count )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (status !== 'all') q = q.eq('status', status)

  const { data, error, count } = await q
  if (error) return serverError(res, 'venue candidates list failed', error)

  res.status(200).json({
    ok:    true,
    rows:  data ?? [],
    total: count ?? 0,
    page,
    pages: Math.ceil((count ?? 0) / PAGE_SIZE) || 1,
  })
}

// POST /api/admin/venue-candidates/:id/approve
export async function approve(req, res, user, candidateId) {
  if (!UUID_RE.test(candidateId)) return notFound(res, 'candidate_not_found')

  const db = getAdminClient()
  const { data, error } = await db.rpc('review_venue_merge_candidate', {
    p_candidate_id: candidateId,
    p_action:       'approve',
    p_reason:       null,
    p_actor:        user.email,
  })

  if (error) return mapReviewError(res, error)
  res.status(200).json({ ok: true, candidate_id: candidateId, status: 'approved', detail: data })
}

// POST /api/admin/venue-candidates/:id/reject
export async function reject(req, res, user, candidateId) {
  if (!UUID_RE.test(candidateId)) return notFound(res, 'candidate_not_found')

  const reason = (req.body?.reason ?? '').trim()
  if (!reason) return badRequest(res, 'missing_reason')

  const db = getAdminClient()
  const { data, error } = await db.rpc('review_venue_merge_candidate', {
    p_candidate_id: candidateId,
    p_action:       'reject',
    p_reason:       reason,
    p_actor:        user.email,
  })

  if (error) return mapReviewError(res, error)
  res.status(200).json({ ok: true, candidate_id: candidateId, status: 'rejected', detail: data })
}

// POST /api/admin/venue-candidates/:id/restore-pending
export async function restorePending(req, res, user, candidateId) {
  if (!UUID_RE.test(candidateId)) return notFound(res, 'candidate_not_found')

  const db = getAdminClient()
  const { data, error } = await db.rpc('review_venue_merge_candidate', {
    p_candidate_id: candidateId,
    p_action:       'restore_pending',
    p_reason:       null,
    p_actor:        user.email,
  })

  if (error) return mapReviewError(res, error)
  res.status(200).json({ ok: true, candidate_id: candidateId, status: 'pending', detail: data })
}

// POST /api/admin/venue-candidates/:id/merge
export async function merge(req, res, user, candidateId) {
  if (!UUID_RE.test(candidateId)) return notFound(res, 'candidate_not_found')

  const db = getAdminClient()
  const { data, error } = await db.rpc('workbench_merge_venue_candidate', {
    p_candidate_id: candidateId,
    p_actor:        user.email,
  })

  if (error) return mapMergeError(res, error)
  res.status(200).json({ ok: true, candidate_id: candidateId, result: data })
}

// POST /api/admin/venue-candidates/:id/rollback
export async function rollback(req, res, user, candidateId) {
  if (!UUID_RE.test(candidateId)) return notFound(res, 'candidate_not_found')

  const db = getAdminClient()
  const { data, error } = await db.rpc('workbench_rollback_venue_merge', {
    p_candidate_id: candidateId,
    p_actor:        user.email,
  })

  if (error) return mapMergeError(res, error)
  res.status(200).json({ ok: true, candidate_id: candidateId, result: data })
}

// ── Error mappers ─────────────────────────────────────────────────────────────

function mapReviewError(res, err) {
  const msg  = err?.message ?? ''
  const code = msg.split('::')[0]?.trim()
  switch (code) {
    case 'invalid_actor':      return badRequest(res, 'invalid_actor')
    case 'invalid_action':     return badRequest(res, 'invalid_action')
    case 'missing_reason':     return badRequest(res, 'missing_reason')
    case 'not_found':          return notFound(res, 'candidate_not_found')
    case 'invalid_transition': return conflict(res, 'invalid_transition')
    default:                   return serverError(res, 'review_venue_merge_candidate failed', err)
  }
}

function mapMergeError(res, err) {
  const msg  = err?.message ?? ''
  const code = msg.split('::')[0]?.trim()
  switch (code) {
    case 'invalid_actor':   return badRequest(res, 'invalid_actor')
    case 'not_found':       return notFound(res, 'candidate_not_found')
    case 'invalid_status':  return conflict(res, 'invalid_status')
    // Guards from the inner RPCs surface as P0001 with specific messages:
    case 'candidate not found':                return notFound(res, 'candidate_not_found')
    case 'candidate must be in status approved': return conflict(res, 'invalid_status')
    case 'can only rollback merged candidates':  return conflict(res, 'invalid_status')
    default:                return serverError(res, 'merge/rollback rpc failed', err)
  }
}
