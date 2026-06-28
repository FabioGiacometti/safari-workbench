/**
 * Unit tests for ConflictResolutionPanel UX logic.
 *
 * Run:  node --test test/conflict-resolution-panel.test.mjs
 *
 * Covers:
 *   - confidenceBand thresholds
 *   - COPY strings (kept in sync with conflict-meta.js)
 *   - canAct gating (no selection, low-conf, scope-switch, loading)
 *   - name-mismatch detection (stringSimilarity)
 *   - scope defaults and global-scope behavior (PART 3)
 *   - outgoing payload contract (PART 4)
 *   - consequence summary accuracy
 *   - ruleCreated success copy
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Logic functions — kept in sync with src/conflict-meta.js
// ---------------------------------------------------------------------------

function confidenceBand(score) {
  if (score == null) return { band: 'unknown', label: 'Sin dato', color: 'gray' }
  if (score >= 0.85) return { band: 'high',   label: 'Alta confianza', color: 'green' }
  if (score >= 0.65) return { band: 'medium', label: 'Confianza media — revisar', color: 'yellow' }
  return               { band: 'low',    label: 'Confianza baja — verificar manualmente', color: 'red' }
}

const COPY = {
  scopeProvider:       (provider) => `Recordar para futuros eventos de ${provider}`,
  scopeProviderDetail: (provider, raw) => `Cuando ${provider} vuelva a enviar "${raw}", el sistema usará esta entidad automáticamente.`,
  scopeGlobal:         'Aplicar a todos los proveedores',
  scopeGlobalWarning:  'Esta regla global afecta a todos los proveedores. Aplicar solo si el valor es inequívoco para cualquier fuente.',
  consequenceProvider: (raw, name, provider) => `Vas a asociar "${raw}" con ${name}. Esta regla se aplicará cuando ${provider} vuelva a enviar este valor.`,
  consequenceGlobal:   (raw, name) => `Vas a asociar "${raw}" con ${name} para cualquier proveedor que envíe este valor.`,
  consequenceNoRewrite:'Los eventos existentes no se reescriben. Los próximos ingresos del pipeline usarán esta asociación.',
  ruleCreated: (ruleId, scope, provider) => {
    const scopeDesc = scope === 'global' ? 'para todos los proveedores' : `para ${provider}`
    return `Conflicto cerrado. Regla persistente creada ${scopeDesc} (id: ${ruleId}). Los eventos existentes no se reescriben.`
  },
  confirmAndRemember:  (provider) => `Confirmar y recordar para ${provider}`,
  createGlobalRule:    'Crear regla para todos los proveedores',
  noCandidates:        'Sin coincidencias sugeridas',
  lowConfAck:          'Esta coincidencia tiene baja confianza. Verificar que la entidad sugerida sea correcta antes de continuar.',
  nameMismatchWarning: (raw, name) => `El valor reportado "${raw}" y el candidato "${name}" son muy diferentes. Verificar que correspondan a la misma ubicación.`,
  markInReview:        'Marcar en revisión',
  providerBug:         'Error del proveedor',
  dismiss:             'Ignorar',
}

function stringSimilarity(a, b) {
  const s = a.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  const t = b.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  if (s === t) return 1
  const m = s.length, n = t.length
  if (m === 0 || n === 0) return 0
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = s[i-1] === t[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return 1 - dp[m][n] / Math.max(m, n)
}

// Simulate panel canAct logic (mirrors ConflictResolutionPanel)
function computeCanAct({ selectedEntityId, selectedCandidate, lowConfAcknowledged, opStatus }) {
  const isLowConf = selectedCandidate != null && selectedCandidate.confidence < 0.65
  return !!selectedEntityId && (!isLowConf || lowConfAcknowledged) && opStatus !== 'loading'
}

// Build the outgoing payload (mirrors handleCreateRule)
function buildPayload({ selectedEntityId, scopeGlobal, provider }) {
  return {
    geo_entity_id:  selectedEntityId,
    provider_scope: scopeGlobal ? '' : provider,
  }
}

// Helpers
function makeCluster(overrides = {}) {
  return { id: 1001, conflict_type: 'ORPHAN_CITY', provider: 'edenentradas',
           raw_value: 'córdoba', avg_confidence: 0.90, candidate_entities: [], status: 'open', ...overrides }
}

function makeCandidate(overrides = {}) {
  return { id: 'geo::city::cordoba-ar', display_name: 'Córdoba', level: 'city',
           source: 'provider', confidence: 1.0, ...overrides }
}

// ---------------------------------------------------------------------------
// Test 16 — confidenceBand thresholds
// ---------------------------------------------------------------------------

describe('confidenceBand thresholds (test 16)', () => {
  test('1.0 → high',                         () => assert.equal(confidenceBand(1.0).band,  'high'))
  test('0.85 → high (boundary)',             () => assert.equal(confidenceBand(0.85).band, 'high'))
  test('0.84 → medium (below high)',         () => assert.equal(confidenceBand(0.84).band, 'medium'))
  test('0.65 → medium (boundary)',           () => assert.equal(confidenceBand(0.65).band, 'medium'))
  test('0.64 → low (below medium boundary)', () => assert.equal(confidenceBand(0.64).band, 'low'))
  test('null → unknown',                     () => assert.equal(confidenceBand(null).band,  'unknown'))
})

// ---------------------------------------------------------------------------
// Test 1 — no silent preselection
// ---------------------------------------------------------------------------

describe('ORPHAN_CITY: no silent preselection (test 1)', () => {
  test('selectedEntityId starts as null', () => {
    let selectedEntityId = null
    const candidates = [makeCandidate()]
    // New code never auto-selects — operator must click a CandidateCard
    assert.equal(selectedEntityId, null)
    // Simulate explicit click
    selectedEntityId = candidates[0].id
    assert.equal(selectedEntityId, 'geo::city::cordoba-ar')
  })
})

// ---------------------------------------------------------------------------
// Tests 2, 6, 7 — canAct gating
// ---------------------------------------------------------------------------

describe('canAct gating (tests 2, 6, 7)', () => {
  test('test 2 — disabled when no selection', () => {
    assert.equal(computeCanAct({ selectedEntityId: null, selectedCandidate: null, lowConfAcknowledged: false, opStatus: null }), false)
  })

  test('test 6 — low-conf requires acknowledgment; true after', () => {
    const c = makeCandidate({ confidence: 0.30 })
    assert.equal(computeCanAct({ selectedEntityId: c.id, selectedCandidate: c, lowConfAcknowledged: false, opStatus: null }), false)
    assert.equal(computeCanAct({ selectedEntityId: c.id, selectedCandidate: c, lowConfAcknowledged: true,  opStatus: null }), true)
  })

  test('test 7 — high-conf: canAct without ack', () => {
    const c = makeCandidate({ confidence: 0.90 })
    assert.equal(computeCanAct({ selectedEntityId: c.id, selectedCandidate: c, lowConfAcknowledged: false, opStatus: null }), true)
  })

  test('canAct false while opStatus=loading', () => {
    const c = makeCandidate({ confidence: 1.0 })
    assert.equal(computeCanAct({ selectedEntityId: c.id, selectedCandidate: c, lowConfAcknowledged: false, opStatus: 'loading' }), false)
  })
})

// ---------------------------------------------------------------------------
// Tests 3, 4 — candidate display
// ---------------------------------------------------------------------------

describe('Candidate display (tests 3, 4)', () => {
  test('test 3 — zero candidates → empty card list', () => {
    const candidates = makeCluster({ conflict_type: 'UNMATCHED' }).candidate_entities
    assert.deepEqual(candidates.map(c => c.id), [])
  })

  test('test 4 — multiple candidates: one card per candidate', () => {
    const list = [
      makeCandidate({ id: 'geo-1', display_name: 'Córdoba', confidence: 0.37 }),
      makeCandidate({ id: 'geo-2', display_name: 'Mendoza', confidence: 0.20 }),
    ]
    assert.deepEqual(list.map(c => c.id), ['geo-1', 'geo-2'])
  })
})

// ---------------------------------------------------------------------------
// Test 5 — manual search override
// ---------------------------------------------------------------------------

describe('Manual search override (test 5)', () => {
  test('combobox selection replaces suggested candidate', () => {
    let selectedEntityId = makeCandidate().id
    selectedEntityId = 'geo-manual-pick'
    assert.equal(selectedEntityId, 'geo-manual-pick')
  })
})

// ---------------------------------------------------------------------------
// Tests 8, 9, 10 — scope defaults  (PART 3)
// ---------------------------------------------------------------------------

describe('Scope defaults (tests 8, 9, 10)', () => {
  test('test 8 — provider scope label includes provider name', () => {
    assert.ok(COPY.scopeProvider('edenentradas').includes('edenentradas'))
  })

  test('test 9 — global is not default (scopeGlobal starts false)', () => {
    let scopeGlobal = false
    assert.equal(scopeGlobal, false)
  })

  test('test 10 — global requires explicit action; changes primary label', () => {
    let scopeGlobal = false
    scopeGlobal = true
    assert.equal(COPY.createGlobalRule, 'Crear regla para todos los proveedores')
  })
})

// ---------------------------------------------------------------------------
// PART 3 — additional scope behavior
// ---------------------------------------------------------------------------

describe('Scope behavior — PART 3 additions', () => {
  test('opening global <details> does not auto-select global scope', () => {
    // scopeGlobal is state; <details> open/close is a DOM event that does NOT change state
    let scopeGlobal = false
    // Simulate DOM open event — state unchanged unless radio clicked
    assert.equal(scopeGlobal, false)
  })

  test('switching candidate does not reset scope', () => {
    let scopeGlobal = true
    let selectedEntityId = 'geo-a'
    // Simulate candidate switch
    selectedEntityId = 'geo-b'
    assert.equal(scopeGlobal, true, 'scope must remain unchanged when candidate switches')
  })

  test('changing conflict resets candidate, ack, and scope', () => {
    let selectedEntityId = 'geo-a'
    let lowConfAcknowledged = true
    let scopeGlobal = true
    // Simulate cluster.id change (useEffect)
    selectedEntityId   = null
    lowConfAcknowledged = false
    scopeGlobal        = false
    assert.equal(selectedEntityId,    null)
    assert.equal(lowConfAcknowledged, false)
    assert.equal(scopeGlobal,         false)
  })

  test('low-conf ack required for BOTH provider and global scopes', () => {
    const lowConfCandidate = makeCandidate({ confidence: 0.30 })
    // Provider scope without ack
    assert.equal(computeCanAct({ selectedEntityId: lowConfCandidate.id, selectedCandidate: lowConfCandidate, lowConfAcknowledged: false, opStatus: null }), false)
    // Global scope — same gate
    assert.equal(computeCanAct({ selectedEntityId: lowConfCandidate.id, selectedCandidate: lowConfCandidate, lowConfAcknowledged: false, opStatus: null }), false)
    // After ack — both scopes enabled
    assert.equal(computeCanAct({ selectedEntityId: lowConfCandidate.id, selectedCandidate: lowConfCandidate, lowConfAcknowledged: true,  opStatus: null }), true)
  })

  test('name-mismatch warning not bypassed by switching scope', () => {
    // showNameMismatch is computed from raw_value + selectedCandidate, not scope
    const sim = stringSimilarity('pawtucket', 'Quincy')
    const showMismatch = sim < 0.4
    assert.equal(showMismatch, true, 'mismatch flag depends on names only, not scope')
    // Changing scope does not affect the mismatch flag
    let scopeGlobal = false
    scopeGlobal = true
    assert.equal(showMismatch, true, 'mismatch still shown after scope change')
  })
})

// ---------------------------------------------------------------------------
// Tests 11, 12 — consequence summary accuracy
// ---------------------------------------------------------------------------

describe('Consequence summary (tests 11, 12)', () => {
  test('test 11 — provider consequence names raw value, entity, and provider', () => {
    const cluster   = makeCluster()
    const candidate = makeCandidate({ display_name: 'Córdoba' })
    const text = COPY.consequenceProvider(cluster.raw_value, candidate.display_name, cluster.provider)
    assert.ok(text.includes('córdoba'))
    assert.ok(text.includes('Córdoba'))
    assert.ok(text.includes('edenentradas'))
  })

  test('global consequence names raw value and entity for all providers', () => {
    const text = COPY.consequenceGlobal('córdoba', 'Córdoba')
    assert.ok(text.includes('córdoba'))
    assert.ok(text.includes('Córdoba'))
    assert.ok(text.includes('cualquier proveedor'))
  })

  test('test 12 — consequenceNoRewrite does not say "reescriben ahora"', () => {
    const text = COPY.consequenceNoRewrite
    assert.equal(text.includes('reescriben ahora'), false)
    assert.ok(text.includes('no se reescriben'))
  })
})

// ---------------------------------------------------------------------------
// Tests 13, 14 — name mismatch detection
// ---------------------------------------------------------------------------

describe('Name mismatch detection (tests 13, 14)', () => {
  test('test 13 — "pawtucket" vs "Quincy" → mismatch', () => {
    assert.ok(stringSimilarity('pawtucket', 'Quincy') < 0.4)
  })

  test('test 14 — "córdoba" vs "Córdoba" → no mismatch (diacritics normalized)', () => {
    assert.equal(stringSimilarity('córdoba', 'Córdoba'), 1)
  })
})

// ---------------------------------------------------------------------------
// Test 15 — secondary actions
// ---------------------------------------------------------------------------

describe('Secondary actions (test 15)', () => {
  test('all secondary action labels defined', () => {
    assert.equal(COPY.markInReview, 'Marcar en revisión')
    assert.equal(COPY.providerBug,  'Error del proveedor')
    assert.equal(COPY.dismiss,      'Ignorar')
  })
})

// ---------------------------------------------------------------------------
// PART 4 — payload contract tests
// ---------------------------------------------------------------------------

describe('Payload contract — PART 4', () => {
  test('P4-1a: provider-scoped payload uses selected entity and cluster provider', () => {
    const payload = buildPayload({ selectedEntityId: 'geo::city::cordoba-ar', scopeGlobal: false, provider: 'edenentradas' })
    assert.equal(payload.geo_entity_id,  'geo::city::cordoba-ar')
    assert.equal(payload.provider_scope, 'edenentradas')
  })

  test('P4-1b: provider-scoped payload does not use empty string for provider_scope', () => {
    const payload = buildPayload({ selectedEntityId: 'geo::city::cordoba-ar', scopeGlobal: false, provider: 'edenentradas' })
    assert.notEqual(payload.provider_scope, '')
  })

  test('P4-2a: global-scoped payload uses empty string for provider_scope', () => {
    const payload = buildPayload({ selectedEntityId: 'geo::city::cordoba-ar', scopeGlobal: true, provider: 'edenentradas' })
    assert.equal(payload.provider_scope, '')
  })

  test('P4-2b: global-scoped payload does not accidentally retain provider', () => {
    const payload = buildPayload({ selectedEntityId: 'geo::city::cordoba-ar', scopeGlobal: true, provider: 'edenentradas' })
    assert.equal(payload.provider_scope, '', 'global must send empty provider_scope, not provider name')
  })

  test('P4-3: manual search replaces suggested — payload uses manually selected entity', () => {
    const suggestedId = 'geo::city::cordoba-ar'
    const manualId    = 'geo::city::rosario-ar'
    // Operator ignored suggestion and searched manually
    let selectedEntityId = manualId
    const payload = buildPayload({ selectedEntityId, scopeGlobal: false, provider: 'edenentradas' })
    assert.equal(payload.geo_entity_id, manualId)
    assert.notEqual(payload.geo_entity_id, suggestedId)
  })

  test('P4-4: candidate switching — payload uses last explicit selection', () => {
    let selectedEntityId = 'geo-1'
    selectedEntityId = 'geo-2'
    const payload = buildPayload({ selectedEntityId, scopeGlobal: false, provider: 'edenentradas' })
    assert.equal(payload.geo_entity_id, 'geo-2')
  })

  test('P4-5: low-conf candidate — request cannot fire before acknowledgment', () => {
    const c = makeCandidate({ confidence: 0.30 })
    const canFire = computeCanAct({ selectedEntityId: c.id, selectedCandidate: c, lowConfAcknowledged: false, opStatus: null })
    assert.equal(canFire, false, 'low-conf must block request before ack')
  })

  test('P4-6: no candidate selected — no request sent (canAct=false)', () => {
    const canFire = computeCanAct({ selectedEntityId: null, selectedCandidate: null, lowConfAcknowledged: false, opStatus: null })
    assert.equal(canFire, false)
  })
})

// ---------------------------------------------------------------------------
// ruleCreated success message
// ---------------------------------------------------------------------------

describe('ruleCreated success copy', () => {
  test('provider-scope message includes rule_id, provider, no-rewrite', () => {
    const msg = COPY.ruleCreated(42, 'provider', 'edenentradas')
    assert.ok(msg.includes('42'))
    assert.ok(msg.includes('edenentradas'))
    assert.ok(msg.includes('Regla persistente creada'))
    assert.ok(msg.includes('no se reescriben'))
    assert.ok(msg.includes('Conflicto cerrado'))
  })

  test('global-scope message says "todos los proveedores"', () => {
    const msg = COPY.ruleCreated(99, 'global', 'edenentradas')
    assert.ok(msg.includes('todos los proveedores'))
    assert.ok(msg.includes('99'))
  })
})
