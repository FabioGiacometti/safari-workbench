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
// ClusterDetail — right panel
// ---------------------------------------------------------------------------

function ClusterDetail({ cluster, events, eventsLoading, geoEntities, ruleHistory, ruleHistoryLoading, onAction, onRefreshRuleHistory, apiFetchFn }) {
  const [selectedEntityId, setSelectedEntityId] = useState(null)
  const [scopeGlobal, setScopeGlobal]           = useState(false)
  const [opStatus, setOpStatus]                 = useState(null)
  const [opMsg, setOpMsg]                       = useState('')

  useEffect(() => {
    setSelectedEntityId(null)
    setScopeGlobal(false)
    setOpStatus(null)
    setOpMsg('')
  }, [cluster.id])

  const candidates    = cluster.candidate_entities ?? []
  const actionability = conflictActionability(cluster.conflict_type)
  const canCreateRule = actionability === 'actionable' && !!cluster.raw_value
  const isVenueWithoutGeo = cluster.conflict_type === 'VENUE_WITHOUT_GEO'
  const isGeoDiscovery    = cluster.conflict_type === 'GEO_ENTITY_DISCOVERY'
  const venueCandidate    = isVenueWithoutGeo ? (candidates[0] ?? null) : null

  // For ORPHAN_CITY: pre-select the existing candidate to guide the operator
  useEffect(() => {
    if (cluster.conflict_type === 'ORPHAN_CITY' && candidates.length === 1 && !selectedEntityId) {
      setSelectedEntityId(candidates[0].id)
    }
  }, [cluster.id, cluster.conflict_type, candidates, selectedEntityId])

  async function handleCreateRule() {
    if (!selectedEntityId || !canCreateRule) return
    const providerScope = scopeGlobal ? '' : cluster.provider
    setOpStatus('loading')
    try {
      await apiFetch(`conflicts/${cluster.id}/resolve-rule`, 'POST', {
        geo_entity_id:  selectedEntityId,
        provider_scope: providerScope,
      })
      setOpStatus('done')
      setOpMsg('rule created — re-run pipeline to confirm auto_resolved')
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

      {/* VENUE_WITHOUT_GEO — attach geo entity to venue */}
      {isVenueWithoutGeo && (
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

      {/* Candidate entity buttons — only for actionable types */}
      {actionability === 'actionable' && candidates.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-3">Candidates</h2>
          <div className="flex flex-wrap gap-2">
            {candidates.map(c => (
              <button
                key={c.id}
                onClick={() => setSelectedEntityId(prev => prev === c.id ? null : c.id)}
                className={[
                  'px-3 py-1.5 rounded border text-xs transition-colors',
                  selectedEntityId === c.id
                    ? 'bg-blue-600 border-blue-700 text-white'
                    : 'bg-white border-gray-300 text-gray-700 hover:border-blue-400',
                ].join(' ')}
              >
                <span className="font-medium">{c.display_name}</span>
                <span className="ml-1.5 opacity-70">{c.level}</span>
                <span className="ml-1.5 opacity-50">{(c.confidence * 100).toFixed(0)}%</span>
              </button>
            ))}
          </div>
          {selectedEntityId && (
            <p className="mt-2 text-xs text-gray-400 font-mono">{selectedEntityId}</p>
          )}
        </div>
      )}

      {/* Fallback picker — only for actionable with no candidates */}
      {actionability === 'actionable' && candidates.length === 0 && (
        <div className="mb-6">
          <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-3">
            No candidates — manual pick
          </h2>
          <select
            value={selectedEntityId ?? ''}
            onChange={e => setSelectedEntityId(e.target.value || null)}
            className="w-full bg-white border border-gray-300 text-gray-900 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
          >
            <option value="">— select geo entity —</option>
            {geoEntities.map(g => (
              <option key={g.id} value={g.id}>
                {g.display_name} ({g.level}{g.country_code ? `, ${g.country_code}` : ''})
              </option>
            ))}
          </select>
        </div>
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

      {/* Actions */}
      <div className="border-t border-gray-200 pt-4 mb-6">
        <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-3">Actions</h2>

        {/* Scope toggle + create rule — only for actionable types */}
        {canCreateRule && (
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setScopeGlobal(false)}
                className={[
                  'px-2.5 py-1 rounded text-xs border transition-colors',
                  !scopeGlobal
                    ? 'bg-gray-800 border-gray-900 text-white'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400',
                ].join(' ')}
              >
                Provider ({cluster.provider})
              </button>
              <button
                onClick={() => setScopeGlobal(true)}
                className={[
                  'px-2.5 py-1 rounded text-xs border transition-colors',
                  scopeGlobal
                    ? 'bg-gray-800 border-gray-900 text-white'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400',
                ].join(' ')}
              >
                Global (all providers)
              </button>
            </div>
            <button
              onClick={handleCreateRule}
              disabled={!selectedEntityId || opStatus === 'loading'}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
            >
              {opStatus === 'loading' ? '…' : 'Create rule →'}
            </button>
          </div>
        )}

        {/* Secondary actions — always available */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleInReview}
            disabled={opStatus === 'loading' || cluster.status === 'in_review'}
            className="px-3 py-1.5 bg-white hover:bg-blue-50 disabled:opacity-40 text-blue-600 text-xs rounded border border-blue-300 transition-colors"
          >
            Mark in review
          </button>
          <button
            onClick={handleProviderBug}
            disabled={opStatus === 'loading'}
            className="px-3 py-1.5 bg-white hover:bg-gray-50 disabled:opacity-40 text-gray-600 text-xs rounded border border-gray-300 transition-colors"
          >
            Provider bug
          </button>
          <button
            onClick={handleDismiss}
            disabled={opStatus === 'loading'}
            className="px-3 py-1.5 bg-white hover:bg-gray-50 disabled:opacity-40 text-gray-600 text-xs rounded border border-gray-300 transition-colors"
          >
            Dismiss
          </button>
        </div>

        {opMsg && (
          <p className={`mt-2 text-xs ${opStatus === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
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
