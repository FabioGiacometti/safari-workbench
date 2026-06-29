import { getAdminClient } from '../supabaseServer.js'
import { serverError, badRequest, notFound, conflict as conflictRes } from '../errors.js'

const PAGE_SIZE = 50

const DISABLE_REASONS = new Set([
  'Asociación incorrecta',
  'Regla demasiado amplia',
  'El proveedor corrigió el dato',
  'Entidad geográfica incorrecta',
  'Duplicada',
  'Otro',
])

// GET /api/admin/rules
// Query params: q (raw_value search), provider, scope (provider|global), status, page
export async function list(req, res, _user) {
  const db       = getAdminClient()
  const q        = (req.query?.q        ?? '').trim()
  const provider = (req.query?.provider ?? '').trim()
  const scope    = (req.query?.scope    ?? '').trim()   // 'provider' | 'global' | ''
  const status   = (req.query?.status   ?? '').trim()   // 'active' | 'disabled' | ''
  const page     = Math.max(0, parseInt(req.query?.page ?? '0', 10) || 0)

  let query = db
    .from('canonical_rules')
    .select(`
      id, match_raw_location, match_provider, geo_entity_id, type, scope,
      confidence, source, status, notes, disabled_reason,
      created_by, updated_by, created_at, updated_at,
      previous_geo_entity_id,
      geo_entities!canonical_rules_geo_entity_id_fkey(
        id, display_name, level, country_code, region
      )
    `, { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  if (q)        query = query.ilike('match_raw_location', `%${q}%`)
  if (provider) query = query.eq('match_provider', provider)
  if (scope === 'global')   query = query.eq('match_provider', '')
  if (scope === 'provider') query = query.neq('match_provider', '')
  if (status)   query = query.eq('status', status)

  const { data, error, count } = await query
  if (error) return serverError(res, 'rules list failed', error)

  res.status(200).json({
    ok:       true,
    rules:    (data ?? []).map(formatRule),
    total:    count ?? 0,
    page,
    page_size: PAGE_SIZE,
  })
}

// GET /api/admin/rules/:id
export async function detail(req, res, _user, ruleId) {
  const db = getAdminClient()
  const { data, error } = await db
    .from('canonical_rules')
    .select(`
      id, match_raw_location, match_provider, geo_entity_id, type, scope,
      confidence, source, status, notes, disabled_reason,
      created_by, updated_by, created_at, updated_at,
      previous_geo_entity_id,
      geo_entities!canonical_rules_geo_entity_id_fkey(
        id, display_name, level, country_code, region
      )
    `)
    .eq('id', ruleId)
    .maybeSingle()

  if (error) return serverError(res, 'rule detail failed', error)
  if (!data)  return notFound(res, 'rule_not_found')

  // Fetch audit history for this rule
  const { data: history } = await db
    .from('editorial_actions')
    .select('actor, action_type, after_state, created_at')
    .eq('entity_type', 'canonical_rule')
    .eq('entity_id', ruleId)
    .order('created_at', { ascending: false })
    .limit(20)

  res.status(200).json({
    ok:      true,
    rule:    formatRule(data),
    history: history ?? [],
  })
}

// POST /api/admin/rules/:id/disable
// Body: { reason: string }
export async function disable(req, res, user, ruleId) {
  const reason = (req.body?.reason ?? '').trim()
  if (!reason)                    return badRequest(res, 'missing_reason')
  if (!DISABLE_REASONS.has(reason)) return badRequest(res, 'invalid_reason')

  const db = getAdminClient()
  const { data, error } = await db.rpc('disable_rule', {
    p_rule_id: parseInt(ruleId, 10),
    p_reason:  reason,
    p_actor:   user.email,
  })

  if (error) return mapRuleError(res, error, 'disable_rule')
  res.status(200).json({ ok: true, rule_id: ruleId, result: data })
}

// POST /api/admin/rules/:id/enable
export async function enable(req, res, user, ruleId) {
  const db = getAdminClient()
  const { data, error } = await db.rpc('enable_rule', {
    p_rule_id: parseInt(ruleId, 10),
    p_actor:   user.email,
  })

  if (error) return mapRuleError(res, error, 'enable_rule')
  res.status(200).json({ ok: true, rule_id: ruleId, result: data })
}

// POST /api/admin/rules/:id/correct
// Body: { new_geo_entity_id: string, reason: string }
export async function correct(req, res, user, ruleId) {
  const new_geo_entity_id = (req.body?.new_geo_entity_id ?? '').trim()
  const reason            = (req.body?.reason            ?? '').trim()

  if (!new_geo_entity_id) return badRequest(res, 'missing_geo_entity_id')
  if (!reason)             return badRequest(res, 'missing_reason')

  const db = getAdminClient()
  const { data, error } = await db.rpc('correct_rule', {
    p_rule_id:           parseInt(ruleId, 10),
    p_new_geo_entity_id: new_geo_entity_id,
    p_reason:            reason,
    p_actor:             user.email,
  })

  if (error) return mapRuleError(res, error, 'correct_rule')
  res.status(200).json({ ok: true, rule_id: ruleId, result: data })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function formatRule(r) {
  const entity = r.geo_entities ?? null
  return {
    id:                   r.id,
    reported_value:       r.match_raw_location,
    provider:             r.match_provider === '' ? null : r.match_provider,
    scope:                r.match_provider === '' ? 'global' : 'provider',
    entity_id:            r.geo_entity_id,
    entity_name:          entity?.display_name ?? null,
    entity_level:         entity?.level        ?? null,
    entity_country:       entity?.country_code ?? null,
    entity_region:        entity?.region       ?? null,
    status:               r.status,
    type:                 r.type,
    source:               r.source,
    disabled_reason:      r.disabled_reason    ?? null,
    previous_entity_id:   r.previous_geo_entity_id ?? null,
    created_by:           r.created_by         ?? null,
    updated_by:           r.updated_by         ?? null,
    created_at:           r.created_at,
    updated_at:           r.updated_at,
  }
}

function mapRuleError(res, err, rpcName) {
  const msg  = err?.message ?? ''
  const code = msg.split('::')[0]?.trim()
  switch (code) {
    case 'not_found':       return notFound(res, 'rule_not_found')
    case 'missing_reason':  return badRequest(res, 'missing_reason')
    case 'invalid_reason':  return badRequest(res, 'invalid_reason')
    case 'already_disabled':return conflictRes(res, 'already_disabled')
    case 'already_active':  return conflictRes(res, 'already_active')
    case 'no_change':       return conflictRes(res, 'no_change')
    default:                return serverError(res, `${rpcName} failed`, err)
  }
}
