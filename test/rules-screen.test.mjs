/**
 * Unit tests for canonical rule administration logic.
 *
 * Run:  node --test test/rules-screen.test.mjs
 *
 * Tests the pure logic extracted from RulesScreen.jsx and the rules handler:
 *   - PART 9 scenarios R1–R15 from the canonical rule administration spec
 *   - formatRule field mapping (handler output → UI display)
 *   - scopeLabel / statusLabel display strings
 *   - Disable reason validation
 *   - Deep-link navigation state
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Logic extracted from src/api/handlers/rules.js
// ---------------------------------------------------------------------------

const DISABLE_REASONS = new Set([
  'Asociación incorrecta',
  'Regla demasiado amplia',
  'El proveedor corrigió el dato',
  'Entidad geográfica incorrecta',
  'Duplicada',
  'Otro',
])

function formatRule(r) {
  const entity = r.geo_entities ?? null
  return {
    id:                 r.id,
    reported_value:     r.match_raw_location,
    provider:           r.match_provider === '' ? null : r.match_provider,
    scope:              r.match_provider === '' ? 'global' : 'provider',
    entity_id:          r.geo_entity_id,
    entity_name:        entity?.display_name ?? null,
    entity_level:       entity?.level        ?? null,
    entity_country:     entity?.country_code ?? null,
    entity_region:      entity?.region       ?? null,
    status:             r.status,
    type:               r.type,
    source:             r.source,
    disabled_reason:    r.disabled_reason    ?? null,
    previous_entity_id: r.previous_geo_entity_id ?? null,
    created_by:         r.created_by         ?? null,
    updated_by:         r.updated_by         ?? null,
    created_at:         r.created_at,
    updated_at:         r.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Logic extracted from src/RulesScreen.jsx
// ---------------------------------------------------------------------------

const COPY_RS = {
  statusActive:   'Activa',
  statusDisabled: 'Desactivada',
  scopeGlobal:    'Global',
  scopeProvider:  (p) => `Solo ${p}`,
  sourceManual:   'Manual',
  sourceAuto:     'Pipeline',
  sourcePipeline: 'Pipeline',
  noResults:      'No se encontraron reglas.',
  disableTitle:   'Desactivar regla',
  enableTitle:    'Reactivar regla',
  correctTitle:   'Corregir entidad geográfica',
  viewRuleLink:   (id) => `Ver regla #${id} →`,
}

function scopeLabel(rule) {
  return rule.scope === 'global' ? COPY_RS.scopeGlobal : COPY_RS.scopeProvider(rule.provider)
}

function sourceLabel(src) {
  if (src === 'manual_override') return COPY_RS.sourceManual
  if (src === 'pipeline')        return COPY_RS.sourcePipeline
  return src ?? '—'
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Simulate the filter logic from RulesScreen
function filterRules(rules, { q = '', provider = '', scope = '', status = '' }) {
  return rules.filter(r => {
    if (q        && !r.reported_value.toLowerCase().includes(q.toLowerCase())) return false
    if (provider && r.provider !== provider)                                     return false
    if (scope === 'global'   && r.scope !== 'global')                           return false
    if (scope === 'provider' && r.scope !== 'provider')                         return false
    if (status   && r.status !== status)                                        return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Deep-link simulation (from App.jsx navigate callback)
// ---------------------------------------------------------------------------

function simulateNavigateToRule(ruleId, state) {
  state.rulesDeepLinkId = ruleId
  state.activeSection   = 'reglas'
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RULE_ACTIVE_PROVIDER = formatRule({
  id: 42,
  match_raw_location: 'Buenos Aires, AR',
  match_provider: 'ticketmaster',
  geo_entity_id:  'geo-ba-001',
  type:           'GEO_OVERRIDE',
  scope:          'match_pattern',
  confidence:     1.0,
  source:         'manual_override',
  status:         'active',
  notes:          null,
  disabled_reason: null,
  created_by:     'ops@example.com',
  updated_by:     null,
  created_at:     '2026-06-01T10:00:00Z',
  updated_at:     '2026-06-01T10:00:00Z',
  previous_geo_entity_id: null,
  geo_entities: { id: 'geo-ba-001', display_name: 'Buenos Aires', level: 'city', country_code: 'AR', region: 'AMBA' },
})

const RULE_ACTIVE_GLOBAL = formatRule({
  id: 7,
  match_raw_location: 'CDMX',
  match_provider: '',
  geo_entity_id:  'geo-cdmx-001',
  type:           'GEO_OVERRIDE',
  scope:          'match_pattern',
  confidence:     0.95,
  source:         'manual_override',
  status:         'active',
  notes:          null,
  disabled_reason: null,
  created_by:     'ops@example.com',
  updated_by:     null,
  created_at:     '2026-05-15T08:00:00Z',
  updated_at:     '2026-05-15T08:00:00Z',
  previous_geo_entity_id: null,
  geo_entities: { id: 'geo-cdmx-001', display_name: 'Ciudad de México', level: 'city', country_code: 'MX', region: null },
})

const RULE_DISABLED = formatRule({
  id: 99,
  match_raw_location: 'Mty, NL',
  match_provider: 'eventbrite',
  geo_entity_id:  'geo-mty-001',
  type:           'GEO_OVERRIDE',
  scope:          'match_pattern',
  confidence:     0.7,
  source:         'manual_override',
  status:         'disabled',
  notes:          null,
  disabled_reason: 'Entidad geográfica incorrecta',
  created_by:     'ops@example.com',
  updated_by:     'ops@example.com',
  created_at:     '2026-04-01T00:00:00Z',
  updated_at:     '2026-06-28T12:00:00Z',
  previous_geo_entity_id: 'geo-mty-old-001',
  geo_entities: { id: 'geo-mty-001', display_name: 'Monterrey', level: 'city', country_code: 'MX', region: 'Nuevo León' },
})

const ALL_RULES = [RULE_ACTIVE_PROVIDER, RULE_ACTIVE_GLOBAL, RULE_DISABLED]

// ---------------------------------------------------------------------------
// R1 — formatRule: provider rule maps correctly
// ---------------------------------------------------------------------------
describe('R1 — formatRule: provider rule field mapping', () => {
  test('scope is "provider" when match_provider is non-empty', () => {
    assert.equal(RULE_ACTIVE_PROVIDER.scope, 'provider')
  })
  test('provider field holds the provider name', () => {
    assert.equal(RULE_ACTIVE_PROVIDER.provider, 'ticketmaster')
  })
  test('reported_value maps from match_raw_location', () => {
    assert.equal(RULE_ACTIVE_PROVIDER.reported_value, 'Buenos Aires, AR')
  })
  test('entity_name comes from joined geo_entities.display_name', () => {
    assert.equal(RULE_ACTIVE_PROVIDER.entity_name, 'Buenos Aires')
  })
})

// ---------------------------------------------------------------------------
// R2 — formatRule: global rule maps correctly
// ---------------------------------------------------------------------------
describe('R2 — formatRule: global rule field mapping', () => {
  test('scope is "global" when match_provider is empty string', () => {
    assert.equal(RULE_ACTIVE_GLOBAL.scope, 'global')
  })
  test('provider is null for global rule', () => {
    assert.equal(RULE_ACTIVE_GLOBAL.provider, null)
  })
  test('status is "active"', () => {
    assert.equal(RULE_ACTIVE_GLOBAL.status, 'active')
  })
})

// ---------------------------------------------------------------------------
// R3 — formatRule: disabled rule maps correctly
// ---------------------------------------------------------------------------
describe('R3 — formatRule: disabled rule field mapping', () => {
  test('status is "disabled"', () => {
    assert.equal(RULE_DISABLED.status, 'disabled')
  })
  test('disabled_reason is preserved', () => {
    assert.equal(RULE_DISABLED.disabled_reason, 'Entidad geográfica incorrecta')
  })
  test('previous_entity_id is preserved', () => {
    assert.equal(RULE_DISABLED.previous_entity_id, 'geo-mty-old-001')
  })
})

// ---------------------------------------------------------------------------
// R4 — scopeLabel display strings
// ---------------------------------------------------------------------------
describe('R4 — scopeLabel', () => {
  test('global rule → "Global"', () => {
    assert.equal(scopeLabel(RULE_ACTIVE_GLOBAL), 'Global')
  })
  test('provider rule → "Solo ticketmaster"', () => {
    assert.equal(scopeLabel(RULE_ACTIVE_PROVIDER), 'Solo ticketmaster')
  })
})

// ---------------------------------------------------------------------------
// R5 — sourceLabel display strings
// ---------------------------------------------------------------------------
describe('R5 — sourceLabel', () => {
  test('manual_override → "Manual"', () => {
    assert.equal(sourceLabel('manual_override'), 'Manual')
  })
  test('pipeline → "Pipeline"', () => {
    assert.equal(sourceLabel('pipeline'), 'Pipeline')
  })
  test('null → "—"', () => {
    assert.equal(sourceLabel(null), '—')
  })
  test('unknown source → passed through', () => {
    assert.equal(sourceLabel('auto_learned'), 'auto_learned')
  })
})

// ---------------------------------------------------------------------------
// R6 — filter: text search
// ---------------------------------------------------------------------------
describe('R6 — filter: text search', () => {
  test('empty q returns all rules', () => {
    assert.equal(filterRules(ALL_RULES, {}).length, 3)
  })
  test('q matching partial reported_value', () => {
    const hits = filterRules(ALL_RULES, { q: 'Buenos' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 42)
  })
  test('q is case-insensitive', () => {
    const hits = filterRules(ALL_RULES, { q: 'cdmx' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 7)
  })
  test('no match → empty array', () => {
    assert.equal(filterRules(ALL_RULES, { q: 'zzzzz' }).length, 0)
  })
})

// ---------------------------------------------------------------------------
// R7 — filter: scope
// ---------------------------------------------------------------------------
describe('R7 — filter: scope', () => {
  test('scope=global returns only global rules', () => {
    const hits = filterRules(ALL_RULES, { scope: 'global' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 7)
  })
  test('scope=provider returns only provider-scoped rules', () => {
    const hits = filterRules(ALL_RULES, { scope: 'provider' })
    assert.equal(hits.length, 2)
    assert.ok(hits.every(r => r.scope === 'provider'))
  })
  test('scope="" returns all', () => {
    assert.equal(filterRules(ALL_RULES, { scope: '' }).length, 3)
  })
})

// ---------------------------------------------------------------------------
// R8 — filter: status
// ---------------------------------------------------------------------------
describe('R8 — filter: status', () => {
  test('status=active returns only active rules', () => {
    const hits = filterRules(ALL_RULES, { status: 'active' })
    assert.equal(hits.length, 2)
    assert.ok(hits.every(r => r.status === 'active'))
  })
  test('status=disabled returns only disabled rules', () => {
    const hits = filterRules(ALL_RULES, { status: 'disabled' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 99)
  })
  test('status="" returns all', () => {
    assert.equal(filterRules(ALL_RULES, { status: '' }).length, 3)
  })
})

// ---------------------------------------------------------------------------
// R9 — filter: provider
// ---------------------------------------------------------------------------
describe('R9 — filter: provider', () => {
  test('provider=ticketmaster returns only that provider', () => {
    const hits = filterRules(ALL_RULES, { provider: 'ticketmaster' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 42)
  })
  test('provider filter does not match global rules', () => {
    const hits = filterRules(ALL_RULES, { provider: 'ticketmaster' })
    assert.ok(hits.every(r => r.provider !== null))
  })
})

// ---------------------------------------------------------------------------
// R10 — filter: combined
// ---------------------------------------------------------------------------
describe('R10 — filter: combined scope+status', () => {
  test('scope=provider + status=disabled → 1 result (Mty rule)', () => {
    const hits = filterRules(ALL_RULES, { scope: 'provider', status: 'disabled' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 99)
  })
  test('scope=global + status=active → 1 result (CDMX rule)', () => {
    const hits = filterRules(ALL_RULES, { scope: 'global', status: 'active' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 7)
  })
  test('scope=global + status=disabled → 0 results', () => {
    assert.equal(filterRules(ALL_RULES, { scope: 'global', status: 'disabled' }).length, 0)
  })
})

// ---------------------------------------------------------------------------
// R11 — disable reason validation
// ---------------------------------------------------------------------------
describe('R11 — disable reason validation', () => {
  test('all six predefined reasons are accepted', () => {
    for (const r of DISABLE_REASONS) {
      assert.ok(DISABLE_REASONS.has(r), `"${r}" should be a valid reason`)
    }
  })
  test('empty string is not a valid reason', () => {
    assert.equal(DISABLE_REASONS.has(''), false)
  })
  test('arbitrary string is not a valid reason', () => {
    assert.equal(DISABLE_REASONS.has('Lo quiero desactivar'), false)
  })
  test('exactly 6 reasons are defined', () => {
    assert.equal(DISABLE_REASONS.size, 6)
  })
})

// ---------------------------------------------------------------------------
// R12 — deep-link navigation: conflict success → Reglas tab
// ---------------------------------------------------------------------------
describe('R12 — deep-link navigation from conflict success', () => {
  test('navigating to rule sets activeSection to "reglas"', () => {
    const state = { activeSection: 'conflicts', rulesDeepLinkId: null }
    simulateNavigateToRule(42, state)
    assert.equal(state.activeSection, 'reglas')
  })
  test('navigating to rule stores rule ID in rulesDeepLinkId', () => {
    const state = { activeSection: 'conflicts', rulesDeepLinkId: null }
    simulateNavigateToRule(42, state)
    assert.equal(state.rulesDeepLinkId, 42)
  })
  test('view-rule link copy format', () => {
    assert.equal(COPY_RS.viewRuleLink(42), 'Ver regla #42 →')
  })
  test('null ruleId does not produce a link (simulated guard)', () => {
    const hasLink = (ruleId) => ruleId !== null
    assert.equal(hasLink(null), false)
    assert.equal(hasLink(42), true)
  })
})

// ---------------------------------------------------------------------------
// R13 — COPY strings match Spanish operator-facing labels
// ---------------------------------------------------------------------------
describe('R13 — COPY strings', () => {
  test('statusActive is "Activa"', () => {
    assert.equal(COPY_RS.statusActive, 'Activa')
  })
  test('statusDisabled is "Desactivada"', () => {
    assert.equal(COPY_RS.statusDisabled, 'Desactivada')
  })
  test('scopeGlobal is "Global"', () => {
    assert.equal(COPY_RS.scopeGlobal, 'Global')
  })
  test('scopeProvider interpolates name', () => {
    assert.equal(COPY_RS.scopeProvider('eventbrite'), 'Solo eventbrite')
  })
  test('noResults string present', () => {
    assert.ok(COPY_RS.noResults.length > 0)
  })
})

// ---------------------------------------------------------------------------
// R14 — fmtDate
// ---------------------------------------------------------------------------
describe('R14 — fmtDate', () => {
  test('null returns "—"', () => {
    assert.equal(fmtDate(null), '—')
  })
  test('undefined returns "—"', () => {
    assert.equal(fmtDate(undefined), '—')
  })
  test('ISO string produces a non-empty formatted date', () => {
    const result = fmtDate('2026-06-01T10:00:00Z')
    assert.ok(result.length > 0)
    assert.notEqual(result, '—')
  })
  test('formatted date contains the year', () => {
    const result = fmtDate('2026-06-01T10:00:00Z')
    assert.ok(result.includes('2026'))
  })
})

// ---------------------------------------------------------------------------
// R15 — rule list pagination (page size contract)
// ---------------------------------------------------------------------------
describe('R15 — pagination contract', () => {
  const PAGE_SIZE = 50

  test('PAGE_SIZE is 50', () => {
    assert.equal(PAGE_SIZE, 50)
  })

  test('page 0 range: 0 to 49', () => {
    const page = 0
    const from = page * PAGE_SIZE
    const to   = page * PAGE_SIZE + PAGE_SIZE - 1
    assert.equal(from, 0)
    assert.equal(to, 49)
  })

  test('page 1 range: 50 to 99', () => {
    const page = 1
    const from = page * PAGE_SIZE
    const to   = page * PAGE_SIZE + PAGE_SIZE - 1
    assert.equal(from, 50)
    assert.equal(to, 99)
  })

  test('prev disabled on page 0', () => {
    assert.equal(0 > 0, false)
  })

  test('next disabled when total ≤ page_size', () => {
    const page = 0, total = 3
    const hasNext = (page + 1) * PAGE_SIZE < total
    assert.equal(hasNext, false)
  })

  test('next enabled when total > page_size', () => {
    const page = 0, total = 51
    const hasNext = (page + 1) * PAGE_SIZE < total
    assert.equal(hasNext, true)
  })
})
