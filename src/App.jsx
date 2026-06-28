import { useState, useEffect, useCallback } from 'react'
import { authClient } from './LoginForm.jsx'
import VenueCandidates from './VenueCandidates.jsx'
import VenueCatalog from './VenueCatalog.jsx'
import VenueDiscrepancies from './VenueDiscrepancies.jsx'
import EventCreateForm from './EventCreateForm.jsx'
import GeoEntityCombobox from './GeoEntityCombobox.jsx'
import {
  isActionable,
  isNonActionable,
  isDiscovery,
  conflictActionability,
  unmatchedSubtype,
  editorialPriorityScore,
  conflictExplanation,
  conflictBadgeStyle,
  confidenceBand,
  COPY,
} from './conflict-meta.js'

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function getToken() {
  const { data: { session } } = await authClient.auth.getSession()
  return session?.access_token ?? null
}

async function apiFetch(path, method = 'GET', body = undefined) {
  const token = await getToken()
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  const res = await fetch(`/api/admin/${path}`, opts)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.error ?? `HTTP ${res.status}`)
    err.status = res.status
    err.code   = json.error
    throw err
  }
  return json
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function clusterKey(c) { return String(c.id) }

function statusDotStyle(status, actionability) {
  if (status === 'resolution_failed')          return 'bg-red-500'
  if (status === 'in_review')                  return 'bg-blue-400'
  if (actionability === 'non_actionable')      return 'bg-gray-400'
  if (actionability === 'informational')       return 'bg-gray-300'
  if (actionability === 'discovery')           return 'bg-teal-400'
  return 'bg-yellow-400'
}

// ---------------------------------------------------------------------------
// ClusterItem — left panel row
// ---------------------------------------------------------------------------

function ClusterItem({ cluster, isSelected, onClick }) {
  const actionability = conflictActionability(cluster.conflict_type)
  const conf = cluster.avg_confidence != null
    ? (cluster.avg_confidence * 100).toFixed(0) + '%'
    : '—'
  const subtype = cluster.conflict_type === 'UNMATCHED' ? unmatchedSubtype(cluster) : null

  return (
    <button
      onClick={onClick}
      className={[
        'w-full text-left px-4 py-3 border-b border-gray-200',
        'hover:bg-gray-50 transition-colors',
        isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent',
        actionability === 'non_actionable' ? 'opacity-60' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotStyle(cluster.status, actionability)}`} />
        <span className="text-gray-900 font-semibold truncate">
          {cluster.raw_value
            ? cluster.raw_value
            : <span className="italic text-gray-400 font-normal">(empty)</span>
          }
        </span>
        <span className="ml-auto text-xs text-gray-400 flex-shrink-0">{conf}</span>
      </div>
      <div className="flex items-center gap-2 pl-4 flex-wrap">
        <span className="text-xs text-gray-500">{cluster.provider}</span>
        <span className="text-xs text-gray-300">·</span>
        <span className="text-xs text-gray-500">{cluster.affected_count} events</span>
        {cluster.status === 'resolution_failed' && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold">
            failed
          </span>
        )}
        {cluster.status === 'in_review' && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-300">
            in review
          </span>
        )}
        {cluster.conflict_type && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${conflictBadgeStyle(cluster.conflict_type)}`}>
            {subtype ?? cluster.conflict_type}
          </span>
        )}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Stat
// ---------------------------------------------------------------------------

function Stat({ label, value }) {
  return (
    <div className="bg-white rounded px-3 py-2 border border-gray-200">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className="text-sm text-gray-900 break-all">{value}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WhySection — explainability panel
// ---------------------------------------------------------------------------

function WhySection({ cluster }) {
  const { reason, detail, signals } = conflictExplanation(cluster)
  const subtype = cluster.conflict_type === 'UNMATCHED' ? unmatchedSubtype(cluster) : null

  return (
    <div className="mb-6 rounded border border-gray-100 bg-white px-4 py-3">
      <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-2.5">Why</h2>
      <div className="space-y-1.5">
        <Row label="reason" value={reason} />
        {subtype && <Row label="subtype" value={subtype} mono />}
        {signals.length > 0 && <Row label="signals" value={signals.join(' · ')} muted />}
      </div>
      {detail && (
        <p className="text-xs text-gray-400 mt-2 border-t border-gray-100 pt-2">{detail}</p>
      )}
    </div>
  )
}

function Row({ label, value, mono, muted }) {
  return (
    <div className="flex gap-2">
      <span className="text-xs text-gray-400 w-14 flex-shrink-0">{label}</span>
      <span className={`text-xs ${mono ? 'font-mono' : ''} ${muted ? 'text-gray-500' : 'text-gray-700'}`}>
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// NonActionableNotice — replaces rule-creation UI for system failures
// ---------------------------------------------------------------------------

const NON_ACTIONABLE_NOTICES = {
  EXTRACTION_FAILURE: {
    title: 'Extraction failure',
    body:  'raw_location and venue_hint are both empty. A canonical rule with match_raw_location="" would ' +
           'silently capture all future empty-location events from this provider.',
    hint:  'Fix options: (1) improve the normalizer to recover city from event title, ' +
           '(2) mark as Provider bug if this provider consistently omits location.',
  },
  PROVIDER_PARSER_FAILURE: {
    title: 'Parser failure',
    body:  'The normalizer encountered a structured field it could not parse. This is a code bug, not an editorial conflict.',
    hint:  'Fix by updating the provider normalizer to handle this format.',
  },
  NO_LOCATION_SIGNAL: {
    title: 'No location signal',
    body:  'Location fields are present but carry placeholder content (e.g. "N/A", "—"). No geographic data is available.',
    hint:  'Add the pattern to the normalizer filter list.',
  },
  PROVIDER_NOISE: {
    title: 'Provider noise',
    body:  'raw_location matches a known non-geographic pattern (online, TBD, por confirmar, etc.).',
    hint:  'This is handled automatically by the conflict engine. No rule needed.',
  },
}

function NonActionableNotice({ conflictType }) {
  const n = NON_ACTIONABLE_NOTICES[conflictType] ?? {
    title: 'System failure',
    body:  'This conflict type is not editorially actionable.',
    hint:  '',
  }
  return (
    <div className="mb-6 rounded border border-gray-300 bg-gray-50 px-4 py-3">
      <p className="text-xs font-semibold text-gray-700 mb-1">{n.title}</p>
      <p className="text-xs text-gray-500">{n.body}</p>
      {n.hint && <p className="text-xs text-gray-400 mt-1.5">{n.hint}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Levenshtein similarity — rough name-mismatch detection
// ---------------------------------------------------------------------------

function stringSimilarity(a, b) {
  const s = a.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  const t = b.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  if (s === t) return 1
  const m = s.length, n = t.length
  if (m === 0 || n === 0) return 0
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = s[i-1] === t[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return 1 - dp[m][n] / Math.max(m, n)
}

// ---------------------------------------------------------------------------
// CandidateCard
// ---------------------------------------------------------------------------

function CandidateCard({ candidate, isSelected, onSelect }) {
  const band = confidenceBand(candidate.confidence)
  const bandColor = {
    high:    'border-green-300 bg-green-50',
    medium:  'border-yellow-300 bg-yellow-50',
    low:     'border-red-300 bg-red-50',
    unknown: 'border-gray-200 bg-white',
  }[band.band]
  const labelColor = {
    high:    'text-green-700',
    medium:  'text-yellow-700',
    low:     'text-red-700',
    unknown: 'text-gray-500',
  }[band.band]

  return (
    <button
      data-testid={`candidate-card-${candidate.id}`}
      aria-pressed={isSelected}
      onClick={() => onSelect(isSelected ? null : candidate.id)}
      className={[
        'w-full text-left px-3 py-2.5 rounded border-2 transition-colors',
        isSelected
          ? 'border-blue-500 bg-blue-50'
          : `${bandColor} hover:border-blue-300`,
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">{candidate.display_name}</span>
        <span className={`text-xs font-medium ${labelColor}`}>{band.label}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-xs text-gray-500">{candidate.level}</span>
        {candidate.source && (
          <span className="text-xs text-gray-400">· {candidate.source}</span>
        )}
        <span className="text-xs text-gray-400 ml-auto">{(candidate.confidence * 100).toFixed(0)}%</span>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// ConflictResolutionPanel
// ---------------------------------------------------------------------------

function ConflictResolutionPanel({
  cluster, candidates, selectedEntityId, setSelectedEntityId,
  scopeGlobal, setScopeGlobal, lowConfAcknowledged, setLowConfAcknowledged,
  opStatus, onCreateRule, apiFetchFn,
}) {
  const selectedCandidate = candidates.find(c => c.id === selectedEntityId) ?? null
  const isLowConf = selectedCandidate != null && selectedCandidate.confidence < 0.65
  const showNameMismatch = selectedCandidate != null && cluster.raw_value &&
    stringSimilarity(cluster.raw_value, selectedCandidate.display_name) < 0.4
  const canAct = !!selectedEntityId && (!isLowConf || lowConfAcknowledged) && opStatus !== 'loading'

  const primaryLabel = scopeGlobal
    ? COPY.createGlobalRule
    : COPY.confirmAndRemember(cluster.provider)

  return (
    <div className="mb-6" data-testid="conflict-resolution-panel">

      {/* State A: no candidates — search directly */}
      {candidates.length === 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 mb-1 font-semibold">{COPY.noCandidates}</p>
          <p className="text-xs text-gray-400 mb-2">{COPY.noCandidatesDetail}</p>
          <GeoEntityCombobox
            apiFetch={apiFetchFn}
            candidates={[]}
            value={selectedEntityId}
            onChange={setSelectedEntityId}
            disabled={opStatus === 'loading'}
            data-testid="geo-entity-combobox"
          />
        </div>
      )}

      {/* State B/C: 1+ candidates */}
      {candidates.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-400 uppercase tracking-widest mb-2">
            {candidates.length === 1 ? COPY.suggestedCandidate : COPY.multipleCandidates}
          </p>
          <div className="space-y-2" data-testid="candidate-list">
            {candidates.map(c => (
              <CandidateCard
                key={c.id}
                candidate={c}
                isSelected={selectedEntityId === c.id}
                onSelect={setSelectedEntityId}
              />
            ))}
          </div>

          {/* Search for a different entity */}
          <details className="mt-3">
            <summary className="text-xs text-blue-600 cursor-pointer select-none hover:underline">
              {COPY.searchOther}
            </summary>
            <div className="mt-2">
              <GeoEntityCombobox
                apiFetch={apiFetchFn}
                candidates={[]}
                value={selectedEntityId}
                onChange={setSelectedEntityId}
                disabled={opStatus === 'loading'}
                data-testid="geo-entity-combobox-alt"
              />
            </div>
          </details>

          {/* None of these */}
          {selectedEntityId && candidates.every(c => c.id !== selectedEntityId) && (
            <p className="mt-1 text-xs text-gray-400">Usando entidad seleccionada manualmente.</p>
          )}
        </div>
      )}

      {/* Low-confidence acknowledgment */}
      {isLowConf && !lowConfAcknowledged && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2" data-testid="low-conf-warning">
          <p className="text-xs text-red-700 mb-2">{COPY.lowConfAck}</p>
          <button
            onClick={() => setLowConfAcknowledged(true)}
            className="text-xs px-2 py-1 rounded border border-red-300 bg-white text-red-700 hover:bg-red-50"
          >
            Entendido — continuar
          </button>
        </div>
      )}

      {/* Name mismatch warning */}
      {showNameMismatch && (
        <div className="mb-3 rounded border border-orange-200 bg-orange-50 px-3 py-2" data-testid="name-mismatch-warning">
          <p className="text-xs text-orange-700">
            {COPY.nameMismatchWarning(cluster.raw_value, selectedCandidate.display_name)}
          </p>
        </div>
      )}

      {/* Consequence summary */}
      {selectedEntityId && (
        <div className="mb-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1" data-testid="consequence-summary">
          <p>
            {scopeGlobal
              ? COPY.consequenceGlobal(cluster.raw_value, selectedCandidate?.display_name ?? selectedEntityId)
              : COPY.consequenceProvider(cluster.raw_value, selectedCandidate?.display_name ?? selectedEntityId, cluster.provider)
            }
          </p>
          <p className="text-gray-400">{COPY.consequenceNoRewrite}</p>
        </div>
      )}

      {/* Scope: provider (default) vs global (advanced) */}
      <div className="mb-3">
        <label className="flex items-start gap-2 cursor-pointer mb-2">
          <input
            type="radio"
            name={`scope-${cluster.id}`}
            checked={!scopeGlobal}
            onChange={() => setScopeGlobal(false)}
            className="mt-0.5"
            data-testid="scope-provider"
          />
          <span className="text-xs text-gray-700">
            <span className="font-medium">{COPY.scopeProvider(cluster.provider)}</span>
            <span className="block text-gray-400 mt-0.5">{COPY.scopeProviderDetail(cluster.provider, cluster.raw_value)}</span>
          </span>
        </label>

        <details>
          <summary className="text-xs text-gray-500 cursor-pointer select-none hover:underline ml-1">
            Opciones avanzadas
          </summary>
          <label className="flex items-start gap-2 cursor-pointer mt-2 ml-1" data-testid="scope-global-label">
            <input
              type="radio"
              name={`scope-${cluster.id}`}
              checked={scopeGlobal}
              onChange={() => setScopeGlobal(true)}
              className="mt-0.5"
              data-testid="scope-global"
            />
            <span className="text-xs text-gray-700">
              <span className="font-medium">{COPY.scopeGlobal}</span>
              <span className="block text-gray-400 mt-0.5">{COPY.scopeGlobalDetail(cluster.raw_value)}</span>
            </span>
          </label>
          {scopeGlobal && (
            <p className="mt-1 ml-6 text-xs text-orange-600 font-medium" data-testid="global-scope-warning">
              {COPY.scopeGlobalWarning}
            </p>
          )}
        </details>
      </div>

      {/* Primary action */}
      <button
        data-testid="primary-action"
        onClick={onCreateRule}
        disabled={!canAct}
        className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
      >
        {opStatus === 'loading' ? COPY.loading : primaryLabel}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ClusterDetail — right panel
// ---------------------------------------------------------------------------

function ClusterDetail({ cluster, events, eventsLoading, geoEntities, ruleHistory, ruleHistoryLoading, onAction, onRefreshRuleHistory, apiFetchFn }) {
  const [selectedEntityId, setSelectedEntityId]   = useState(null)
  const [scopeGlobal, setScopeGlobal]             = useState(false)
  const [opStatus, setOpStatus]                   = useState(null)
  const [opMsg, setOpMsg]                         = useState('')
  const [lowConfAcknowledged, setLowConfAcknowledged] = useState(false)

  useEffect(() => {
    setSelectedEntityId(null)
    setScopeGlobal(false)
    setOpStatus(null)
    setOpMsg('')
    setLowConfAcknowledged(false)
  }, [cluster.id])

  const candidates    = cluster.candidate_entities ?? []
  const actionability = conflictActionability(cluster.conflict_type)
  const canCreateRule = actionability === 'actionable' && !!cluster.raw_value
  const isVenueWithoutGeo = cluster.conflict_type === 'VENUE_WITHOUT_GEO'
  const isGeoDiscovery    = cluster.conflict_type === 'GEO_ENTITY_DISCOVERY'
  const venueCandidate    = isVenueWithoutGeo ? (candidates[0] ?? null) : null
  // Stale state: venue was already resolved (geo_entity_id set on venue) but the pipeline
  // upsert overwrote conflict status back to resolution_failed. Detected when the conflict
  // row carries resolved_geo_entity_id — meaning the RPC ran successfully before — while
  // status is still open/in_review/resolution_failed. The operator should reconcile, not
  // repeat the geographic selection.
  const isVenueGeoAlreadyResolved = isVenueWithoutGeo &&
    !!cluster.resolved_geo_entity_id &&
    ['open', 'in_review', 'resolution_failed'].includes(cluster.status)

  async function handleCreateRule() {
    if (!selectedEntityId || !canCreateRule) return
    const providerScope = scopeGlobal ? '' : cluster.provider
    setOpStatus('loading')
    try {
      const json = await apiFetch(`conflicts/${cluster.id}/resolve-rule`, 'POST', {
        geo_entity_id:  selectedEntityId,
        provider_scope: providerScope,
      })
      // Handler returns { ok, conflict_id, result: { ok, status, rule_id, geo_entity_id } }
      const ruleId = json?.result?.rule_id ?? '—'
      const scope  = scopeGlobal ? 'global' : 'provider'
      setOpStatus('done')
      setOpMsg(COPY.ruleCreated(ruleId, scope, cluster.provider))
      onRefreshRuleHistory()
      setTimeout(() => onAction('refresh'), 1500)
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.code === 'wrong_conflict_type' ? 'this conflict type does not support rule creation'
             : err.code === 'no_rule_possible'    ? 'conflict has no raw_value'
             : err.code === 'not_found'           ? 'conflict or geo entity not found'
             : err.message)
    }
  }

  async function handleVenueGeoFix() {
    if (!selectedEntityId) return
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/resolve-venue-geo`, 'POST', {
        geo_entity_id: selectedEntityId,
      })
      setOpStatus('done')
      setOpMsg('La entidad geográfica quedó asociada al local.')
      setTimeout(() => onAction('refresh'), 1500)
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.code === 'venue_not_found' ? 'No se pudo identificar el local desde los datos del conflicto.'
             : err.code === 'not_found'       ? 'No se encontró el conflicto o la entidad geográfica.'
             : err.message)
    }
  }

  async function handleReconcile() {
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/reconcile`, 'POST', {})
      setOpStatus('done')
      setOpMsg('Conflicto sincronizado. El local ya tenía la entidad geográfica asignada.')
      setTimeout(() => onAction('refresh'), 1500)
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.code === 'venue_geo_not_yet_set' ? 'El local aún no tiene entidad geográfica asignada. Use la selección manual.'
             : err.code === 'venue_not_found'        ? 'No se pudo identificar el local desde los datos del conflicto.'
             : err.message)
    }
  }

  async function handleDiscoveryApprove() {
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/resolve-discovery`, 'POST', { action: 'approve' })
      setOpStatus('done')
      setOpMsg('candidate approved — create the geo entity in the registry to complete resolution')
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.code === 'no_discovery_candidate' ? 'no pending discovery candidate found'
             : err.message)
    }
  }

  async function handleDiscoveryReject() {
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/resolve-discovery`, 'POST', { action: 'reject' })
      setOpStatus('done')
      setOpMsg('candidate rejected and conflict dismissed')
      setTimeout(() => onAction('refresh'), 1000)
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.code === 'no_discovery_candidate' ? 'no pending discovery candidate found'
             : err.message)
    }
  }

  async function handleInReview() {
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/in-review`, 'POST')
      setOpStatus('done')
      setOpMsg('marked in review')
      setTimeout(() => onAction('refresh'), 1000)
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.code === 'invalid_transition' ? 'conflict is already in review' : err.message)
    }
  }

  async function handleProviderBug() {
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/provider-bug`, 'POST')
      setOpStatus('done')
      setOpMsg('marked provider bug')
      setTimeout(() => onAction('refresh'), 1000)
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.message)
    }
  }

  async function handleDismiss() {
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/dismiss`, 'POST')
      setOpStatus('done')
      setOpMsg('dismissed')
      setTimeout(() => onAction('refresh'), 1000)
    } catch (err) {
      setOpStatus('error')
      setOpMsg(err.message)
    }
  }

  return (
    <div className="p-6 max-w-2xl">

      {/* Header */}
      <div className="flex items-start gap-3 mb-6">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <h1 className="text-xl font-bold text-gray-900">
              {cluster.raw_value || <span className="italic text-gray-400 font-normal">(empty raw_value)</span>}
            </h1>
            {cluster.status === 'resolution_failed' && (
              <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-bold">
                RESOLUTION FAILED
              </span>
            )}
            {cluster.status === 'in_review' && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-300">
                in review
              </span>
            )}
            {cluster.conflict_type && (
              <span className={`text-xs px-2 py-0.5 rounded ${conflictBadgeStyle(cluster.conflict_type)}`}>
                {cluster.conflict_type === 'UNMATCHED'
                  ? unmatchedSubtype(cluster)
                  : cluster.conflict_type
                }
              </span>
            )}
            {actionability === 'non_actionable' && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-300">
                non-actionable
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500">
            {cluster.provider} · {cluster.affected_count} affected events · {cluster.resolution_mode}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="avg confidence" value={
          cluster.avg_confidence != null
            ? (cluster.avg_confidence * 100).toFixed(1) + '%'
            : '—'
        } />
        <Stat label="candidates" value={String(cluster.candidate_count ?? 0)} />
        <Stat label="last seen" value={cluster.last_seen ?? '—'} />
      </div>

      {/* Why — always shown */}
      <WhySection cluster={cluster} />

      {/* Non-actionable notice */}
      {isNonActionable(cluster.conflict_type) && (
        <NonActionableNotice conflictType={cluster.conflict_type} />
      )}

      {/* VENUE_WITHOUT_GEO — stale state: venue already resolved, conflict status out of sync */}
      {isVenueWithoutGeo && isVenueGeoAlreadyResolved && (
        <div className="mb-6 rounded border border-green-200 bg-green-50 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">
            Este conflicto ya está resuelto en el catálogo
          </h2>
          <p className="text-xs text-gray-600 mb-3">
            El local ya está asociado con{' '}
            <span className="font-medium">{cluster.resolved_geo_entity_id}</span>.
            El estado del conflicto quedó desactualizado por una re-evaluación del pipeline
            y puede sincronizarse sin volver a elegir una ciudad.
          </p>
          {cluster.resolved_by && (
            <p className="text-xs text-gray-400 mb-3">
              Resuelto originalmente por {cluster.resolved_by}
              {cluster.resolved_at ? ` el ${new Date(cluster.resolved_at).toLocaleString('es-AR')}` : ''}.
            </p>
          )}
          <button
            onClick={handleReconcile}
            disabled={opStatus === 'loading' || opStatus === 'done'}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
          >
            {opStatus === 'loading' ? '…' : 'Sincronizar estado del conflicto'}
          </button>
        </div>
      )}

      {/* VENUE_WITHOUT_GEO — normal state: attach geo entity to venue */}
      {isVenueWithoutGeo && !isVenueGeoAlreadyResolved && (
        <div className="mb-6 rounded border border-yellow-200 bg-yellow-50 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">
            Local sin ciudad canónica asociada
          </h2>
          <p className="text-xs text-gray-600 mb-3">
            Este local fue identificado, pero todavía no está vinculado a una entidad
            geográfica canónica. Las coordenadas y la ciudad escrita no reemplazan esta
            asociación. Al confirmar, se actualiza el catálogo de locales; los eventos
            existentes no se reescriben directamente, pero las próximas resoluciones del
            sistema usarán la entidad confirmada.
          </p>

          {venueCandidate && (
            <div className="mb-3 text-xs text-gray-700">
              <span className="text-gray-400 mr-1">Local:</span>
              <span className="font-medium">{venueCandidate.display_name}</span>
            </div>
          )}

          <label className="block text-xs text-gray-500 mb-1">
            Buscar ciudad o región
          </label>
          <GeoEntityCombobox
            apiFetch={apiFetchFn}
            candidates={[]}
            value={selectedEntityId}
            onChange={setSelectedEntityId}
            disabled={opStatus === 'loading'}
            data-testid="venue-without-geo-combobox"
          />

          <button
            onClick={handleVenueGeoFix}
            disabled={!selectedEntityId || opStatus === 'loading'}
            className="mt-3 px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
          >
            {opStatus === 'loading' ? '…' : 'Confirmar asociación geográfica'}
          </button>
        </div>
      )}

      {/* GEO_ENTITY_DISCOVERY — review and approve/reject proposed entity */}
      {isGeoDiscovery && (
        <div className="mb-6 rounded border border-teal-200 bg-teal-50 px-4 py-3">
          <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-2">Discovery context</h2>
          {cluster.discovery_hints && (
            <div className="space-y-1 mb-3">
              {cluster.discovery_hints.city_name && (
                <Row label="city" value={cluster.discovery_hints.city_name} />
              )}
              {cluster.discovery_hints.state_name && (
                <Row label="state" value={cluster.discovery_hints.state_name} />
              )}
              {cluster.discovery_hints.country_code && (
                <Row label="country"
                  value={`${cluster.discovery_hints.country_code.toUpperCase()} (${Math.round((cluster.discovery_hints.country_confidence ?? 0) * 100)}% confidence)`}
                />
              )}
            </div>
          )}
          <p className="text-xs text-gray-400 mb-3">
            Review the proposed entity. Approve to queue it for geo_entities creation, or reject to dismiss.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDiscoveryApprove}
              disabled={opStatus === 'loading'}
              className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white text-xs rounded transition-colors"
            >
              {opStatus === 'loading' ? '…' : 'Approve proposal'}
            </button>
            <button
              onClick={handleDiscoveryReject}
              disabled={opStatus === 'loading'}
              className="px-3 py-1.5 bg-white hover:bg-gray-50 disabled:opacity-40 text-gray-600 text-xs rounded border border-gray-300 transition-colors"
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Conflict resolution panel — only for actionable types */}
      {actionability === 'actionable' && canCreateRule && (
        <ConflictResolutionPanel
          cluster={cluster}
          candidates={candidates}
          selectedEntityId={selectedEntityId}
          setSelectedEntityId={setSelectedEntityId}
          scopeGlobal={scopeGlobal}
          setScopeGlobal={setScopeGlobal}
          lowConfAcknowledged={lowConfAcknowledged}
          setLowConfAcknowledged={setLowConfAcknowledged}
          opStatus={opStatus}
          onCreateRule={handleCreateRule}
          apiFetchFn={apiFetchFn}
        />
      )}

      {/* Sample events */}
      <div className="mb-6">
        <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-3">Sample events</h2>
        {eventsLoading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-gray-400">No sample events found.</p>
        ) : (
          <div className="space-y-2">
            {events.map((e, i) => (
              <div key={i} className="bg-white rounded px-3 py-2 border border-gray-200">
                <p className="text-sm text-gray-900">{e.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {e.venue_name}
                  {e.city ? <span className="text-gray-400"> · {e.city}</span> : null}
                  <span className="text-gray-300"> · conf {((e.geo_confidence ?? 0) * 100).toFixed(0)}%</span>
                  <span className="text-gray-300"> · {e.geo_source}</span>
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Secondary actions */}
      <div className="border-t border-gray-200 pt-4 mb-6">
        <div className="flex gap-2 flex-wrap">
          <button
            data-testid="action-in-review"
            onClick={handleInReview}
            disabled={opStatus === 'loading' || cluster.status === 'in_review'}
            className="px-3 py-1.5 bg-white hover:bg-blue-50 disabled:opacity-40 text-blue-600 text-xs rounded border border-blue-300 transition-colors"
          >
            {COPY.markInReview}
          </button>
          <button
            data-testid="action-provider-bug"
            onClick={handleProviderBug}
            disabled={opStatus === 'loading'}
            className="px-3 py-1.5 bg-white hover:bg-gray-50 disabled:opacity-40 text-gray-600 text-xs rounded border border-gray-300 transition-colors"
          >
            {COPY.providerBug}
          </button>
          <button
            data-testid="action-dismiss"
            onClick={handleDismiss}
            disabled={opStatus === 'loading'}
            className="px-3 py-1.5 bg-white hover:bg-gray-50 disabled:opacity-40 text-gray-600 text-xs rounded border border-gray-300 transition-colors"
          >
            {COPY.dismiss}
          </button>
        </div>

        {opMsg && (
          <p className={`mt-2 text-xs ${opStatus === 'error' ? 'text-red-600' : 'text-gray-500'}`} data-testid="op-message">
            {opMsg}
          </p>
        )}
      </div>

      {/* Rule history */}
      <div className="border-t border-gray-200 pt-4">
        <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-3">Rule history</h2>
        {ruleHistoryLoading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : ruleHistory.length === 0 ? (
          <p className="text-sm text-gray-400">
            No rules for "{cluster.raw_value || '(empty)'}".
          </p>
        ) : (
          <div className="space-y-2">
            {ruleHistory.map(r => (
              <div key={r.id} className="bg-white rounded px-3 py-2 border border-gray-200">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-gray-700">{r.geo_entity_id ?? '—'}</span>
                  <span className="text-xs text-gray-400">
                    {r.match_provider === '' ? 'global' : `provider=${r.match_provider}`}
                  </span>
                  <span className="text-xs text-gray-300">·</span>
                  <span className="text-xs text-gray-400">{r.type}</span>
                  <span className="ml-auto text-xs text-gray-300">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'}
                  </span>
                </div>
                {r.notes && <p className="text-xs text-gray-400 mt-0.5 italic">{r.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App({ session, onSignOut }) {
  const [activeSection, setActiveSection]           = useState('conflicts')
  const [conflicts, setConflicts]                   = useState([])
  const [selected, setSelected]                     = useState(null)
  const [sampleEvents, setSampleEvents]             = useState([])
  const [geoEntities, setGeoEntities]               = useState([])
  const [ruleHistory, setRuleHistory]               = useState([])
  const [loading, setLoading]                       = useState(true)
  const [refreshing, setRefreshing]                 = useState(false)
  const [eventsLoading, setEventsLoading]           = useState(false)
  const [ruleHistoryLoading, setRuleHistoryLoading] = useState(false)
  const [error, setError]                           = useState(null)

  // Derived counts for header
  const actionableCount    = conflicts.filter(c => isActionable(c.conflict_type)).length
  const discoveryCount     = conflicts.filter(c => isDiscovery(c.conflict_type)).length
  const nonActionableCount = conflicts.filter(c => isNonActionable(c.conflict_type)).length

  useEffect(() => {
    Promise.all([
      apiFetch('conflicts'),
      apiFetch('geo-entities'),
    ]).then(([conflictsRes, entitiesRes]) => {
      const rows = conflictsRes.rows ?? []
      const sorted = [...rows].sort((a, b) => editorialPriorityScore(b) - editorialPriorityScore(a))
      setConflicts(sorted)
      setGeoEntities(entitiesRes.entities ?? [])
      setLoading(false)
    }).catch(err => {
      setError(err.message)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!selected?.id) { setSampleEvents([]); return }
    setEventsLoading(true)
    apiFetch(`conflicts/${selected.id}/events`)
      .then(res => {
        setSampleEvents(res.events ?? [])
        setEventsLoading(false)
      })
      .catch(() => {
        setSampleEvents([])
        setEventsLoading(false)
      })
  }, [selected?.id])

  const loadRuleHistory = useCallback(async (conflictId) => {
    if (conflictId === undefined || conflictId === null) { setRuleHistory([]); return }
    setRuleHistoryLoading(true)
    try {
      const res = await apiFetch(`conflicts/${conflictId}/rules`)
      setRuleHistory(res.rules ?? [])
    } catch {
      setRuleHistory([])
    }
    setRuleHistoryLoading(false)
  }, [])

  useEffect(() => {
    if (selected) loadRuleHistory(selected.id)
    else setRuleHistory([])
  }, [selected?.id, loadRuleHistory])

  const refreshClusters = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await apiFetch('conflicts')
      const rows = res.rows ?? []
      const sorted = [...rows].sort((a, b) => editorialPriorityScore(b) - editorialPriorityScore(a))
      setConflicts(sorted)
      if (selected) {
        const still = sorted.find(c => c.id === selected.id)
        if (!still) setSelected(null)
      }
    } catch (err) {
      console.error('refresh failed:', err.message)
    }
    setRefreshing(false)
  }, [selected])

  const handleAction = useCallback((type) => {
    if (type === 'refresh') refreshClusters()
  }, [refreshClusters])

  const navigate = useCallback((dir) => {
    if (!conflicts.length) return
    const idx = selected ? conflicts.findIndex(c => c.id === selected.id) : -1
    const next = conflicts[Math.max(0, Math.min(conflicts.length - 1, idx + dir))]
    if (next) setSelected(next)
  }, [conflicts, selected])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigate(1) }
      if (e.key === 'ArrowUp')   { e.preventDefault(); navigate(-1) }
      if (e.key === 'Escape')    setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  if (loading) return (
    <div className="h-screen flex items-center justify-center text-gray-400 text-sm">
      loading conflicts…
    </div>
  )

  if (error) return (
    <div className="h-screen flex items-center justify-center text-red-600 text-sm">
      error: {error}
    </div>
  )

  // Non-conflicts sections render full-height without the conflict layout
  if (activeSection === 'venues' || activeSection === 'venues-catalog' || activeSection === 'discrepancies' || activeSection === 'crear-evento') {
    return (
      <div className="h-screen flex flex-col overflow-hidden text-sm">
        <div className="flex gap-1 px-3 py-2 border-b border-gray-200 bg-white flex-shrink-0">
          <TabButton label="Conflictos"       active={false}                                   onClick={() => setActiveSection('conflicts')} />
          <TabButton label="Venue Candidates" active={activeSection === 'venues'}              onClick={() => setActiveSection('venues')} />
          <TabButton label="Venues"           active={activeSection === 'venues-catalog'}      onClick={() => setActiveSection('venues-catalog')} />
          <TabButton label="Discrepancias"    active={activeSection === 'discrepancies'}       onClick={() => setActiveSection('discrepancies')} />
          <TabButton label="Crear Evento"     active={activeSection === 'crear-evento'}        onClick={() => setActiveSection('crear-evento')} />
          <div className="ml-auto flex items-center gap-2">
            {session?.user?.email && <span className="text-xs text-gray-400">{session.user.email}</span>}
            {onSignOut && <button onClick={onSignOut} className="text-xs text-gray-400 hover:text-gray-700">Sign out</button>}
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {activeSection === 'venues'          && <VenueCandidates />}
          {activeSection === 'venues-catalog'  && <VenueCatalog />}
          {activeSection === 'discrepancies'   && <VenueDiscrepancies />}
          {activeSection === 'crear-evento'    && (
            <div className="max-w-xl mx-auto h-full overflow-y-auto">
              <EventCreateForm />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden text-sm">
      {/* TOP: section tabs */}
      <div className="flex gap-1 px-3 py-2 border-b border-gray-200 bg-white flex-shrink-0">
        <TabButton label="Conflictos"       active={true}  onClick={() => setActiveSection('conflicts')} />
        <TabButton label="Venue Candidates" active={false} onClick={() => setActiveSection('venues')} />
        <TabButton label="Venues"           active={false} onClick={() => setActiveSection('venues-catalog')} />
        <TabButton label="Discrepancias"    active={false} onClick={() => setActiveSection('discrepancies')} />
        <TabButton label="Crear Evento"     active={false} onClick={() => setActiveSection('crear-evento')} />
        <div className="ml-auto flex items-center gap-2">
          {session?.user?.email && <span className="text-xs text-gray-400">{session.user.email}</span>}
          {onSignOut && <button onClick={onSignOut} className="text-xs text-gray-400 hover:text-gray-700">Sign out</button>}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">

      {/* LEFT: conflict list */}
      <div className="w-72 flex flex-col border-r border-gray-200 overflow-hidden flex-shrink-0 bg-white">
        <div className="px-4 py-3 border-b border-gray-200 text-xs text-gray-500 flex items-center gap-2">
          <span className="text-gray-900 font-semibold">Conflict Queue</span>
          <span
            className="ml-auto bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full text-xs"
            title={`${actionableCount} actionable, ${discoveryCount} discovery, ${nonActionableCount} non-actionable`}
          >
            {actionableCount}
          </span>
          {discoveryCount > 0 && (
            <span className="bg-teal-50 text-teal-600 px-2 py-0.5 rounded-full text-xs" title="discovery">
              +{discoveryCount} discovery
            </span>
          )}
          {nonActionableCount > 0 && (
            <span className="bg-gray-100 text-gray-400 px-2 py-0.5 rounded-full text-xs" title="non-actionable">
              +{nonActionableCount}
            </span>
          )}
          <button
            onClick={refreshClusters}
            disabled={refreshing}
            title="Refresh conflict queue"
            className="ml-1 text-gray-400 hover:text-gray-700 disabled:opacity-40 transition-colors text-base leading-none"
          >
            {refreshing ? '…' : '↻'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conflicts.length === 0 ? (
            <div className="px-4 py-6 text-xs text-gray-400 text-center">
              No open conflicts.
            </div>
          ) : conflicts.map(c => (
            <ClusterItem
              key={clusterKey(c)}
              cluster={c}
              isSelected={selected?.id === c.id}
              onClick={() => setSelected(c)}
            />
          ))}
        </div>
        <div className="px-4 py-2 border-t border-gray-200 text-xs text-gray-400">
          ↑↓ navigate · esc deselect
        </div>
      </div>

      {/* RIGHT: detail */}
      <div className="flex-1 overflow-y-auto bg-gray-50">
        {selected
          ? <ClusterDetail
              cluster={selected}
              events={sampleEvents}
              eventsLoading={eventsLoading}
              geoEntities={geoEntities}
              ruleHistory={ruleHistory}
              ruleHistoryLoading={ruleHistoryLoading}
              onAction={handleAction}
              apiFetchFn={apiFetch}
              onRefreshRuleHistory={() => loadRuleHistory(selected.id)}
            />
          : (
            <div className="h-full flex items-center justify-center text-gray-400 text-sm">
              select a conflict to review
            </div>
          )
        }
      </div>

      </div>  {/* flex-1 flex overflow-hidden */}
    </div>
  )
}

function TabButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-3 py-1 text-xs rounded',
        active
          ? 'bg-gray-900 text-white'
          : 'text-gray-600 hover:bg-gray-100',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
