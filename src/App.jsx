import { useState, useEffect, useCallback } from 'react'
// ⚠ SECURITY EXPOSURE: VITE_SUPABASE_KEY is a service-role key bundled into the
// browser bundle. This is an unresolved security issue. It will be removed once
// all tabs are migrated to the server-side API (Steps C–E). Do not add new uses.
import { supabase } from './supabase.js'
import VenueCandidates from './VenueCandidates.jsx'
import VenueCatalog from './VenueCatalog.jsx'
import VenueDiscrepancies from './VenueDiscrepancies.jsx'
import EventCreateForm from './EventCreateForm.jsx'
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

async function writeEditorialAction(supabaseClient, conflictId, actionType, metadata = {}) {
  try {
    await supabaseClient.from('editorial_actions').insert({
      conflict_id: conflictId,
      action_type: actionType,
      entity_type: 'conflict',
      entity_id:   String(conflictId),
      metadata,
    })
  } catch (_) {
    // Non-fatal — audit trail failure must not block the primary action.
  }
}

async function fetchConflicts() {
  const { data, error } = await supabase
    .from('resolution_conflicts')
    .select('*')
    .in('status', ['open', 'in_review', 'resolution_failed'])
    .order('affected_count', { ascending: false })
  if (error) throw new Error(error.message)
  const rows = data ?? []
  // Client-side sort by editorial priority (ACTIONABLE first, then score desc, NON_ACTIONABLE last)
  return [...rows].sort((a, b) => editorialPriorityScore(b) - editorialPriorityScore(a))
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

function ClusterDetail({ cluster, events, eventsLoading, geoEntities, ruleHistory, ruleHistoryLoading, onAction, onRefreshRuleHistory }) {
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

  async function handleCreateRule() {
    if (!selectedEntityId || !canCreateRule) return

    const matchProvider = scopeGlobal ? '' : cluster.provider

    const { data: existing } = await supabase
      .from('canonical_rules')
      .select('id, match_provider, geo_entity_id')
      .eq('match_raw_location', cluster.raw_value)
      .eq('match_provider', matchProvider)
      .maybeSingle()

    if (existing) {
      const scopeLabel = matchProvider === '' ? 'global' : `provider=${matchProvider}`
      const ok = window.confirm(
        `Rule already exists for "${cluster.raw_value}" (${scopeLabel}) → ${existing.geo_entity_id}.\n\nOverwrite with → ${selectedEntityId}?`
      )
      if (!ok) return
    }

    setOpStatus('loading')

    const { error: ruleErr } = await supabase
      .from('canonical_rules')
      .upsert({
        match_raw_location: cluster.raw_value,
        match_provider:     matchProvider,
        geo_entity_id:      selectedEntityId,
        type:               'GEO_OVERRIDE',
        scope:              'match_pattern',
        confidence:         1.0,
        source:             'workbench',
        resolution_mode:    'manual_override',
        created_by:         'operator',
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'match_raw_location,match_provider' })

    if (ruleErr) { setOpStatus('error'); setOpMsg(ruleErr.message); return }

    const { error: conflictErr } = await supabase
      .from('resolution_conflicts')
      .update({
        status:                 'resolved',
        resolved_geo_entity_id: selectedEntityId,
        resolved_at:            new Date().toISOString(),
        resolved_by:            'operator',
        editorial_updated_at:   new Date().toISOString(),
      })
      .eq('id', cluster.id)

    if (conflictErr) {
      setOpStatus('error')
      setOpMsg(`rule created but status update failed: ${conflictErr.message}`)
      return
    }

    setOpStatus('done')
    setOpMsg('rule created — re-run pipeline to confirm auto_resolved')
    await writeEditorialAction(supabase, cluster.id, 'create_rule', {
      geo_entity_id: selectedEntityId, scope: scopeGlobal ? 'global' : cluster.provider,
    })
    onRefreshRuleHistory()
    setTimeout(() => onAction('refresh'), 1500)
  }

  async function handleVenueGeoFix() {
    if (!selectedEntityId || !venueCandidate) return
    setOpStatus('loading')

    const { error: venueErr } = await supabase
      .from('venues')
      .update({ geo_entity_id: selectedEntityId })
      .eq('fingerprint', venueCandidate.id)

    if (venueErr) { setOpStatus('error'); setOpMsg(venueErr.message); return }

    const { error: conflictErr } = await supabase
      .from('resolution_conflicts')
      .update({ status: 'resolved', resolved_geo_entity_id: selectedEntityId,
                resolved_at: new Date().toISOString(), resolved_by: 'operator',
                editorial_updated_at: new Date().toISOString() })
      .eq('id', cluster.id)

    if (conflictErr) { setOpStatus('error'); setOpMsg(conflictErr.message); return }

    await writeEditorialAction(supabase, cluster.id, 'venue_geo_fix', {
      venue_fingerprint: venueCandidate.id, geo_entity_id: selectedEntityId,
    })
    setOpStatus('done')
    setOpMsg('venue geo entity attached — re-warm pipeline to activate')
    setTimeout(() => onAction('refresh'), 1500)
  }

  async function handleDiscoveryApprove() {
    setOpStatus('loading')
    const { error } = await supabase
      .from('geo_entity_candidates')
      .update({ status: 'approved' })
      .eq('normalized_name', (cluster.discovery_hints?.city_name ?? cluster.raw_value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim())
      .eq('status', 'pending')

    if (error) { setOpStatus('error'); setOpMsg(error.message); return }

    await supabase
      .from('resolution_conflicts')
      .update({ status: 'in_review', editorial_updated_at: new Date().toISOString() })
      .eq('id', cluster.id)

    await writeEditorialAction(supabase, cluster.id, 'discovery_approved', {
      city_name: cluster.discovery_hints?.city_name, country_code: cluster.discovery_hints?.country_code,
    })
    setOpStatus('done')
    setOpMsg('candidate approved — create the geo entity in the registry to complete resolution')
  }

  async function handleDiscoveryReject() {
    setOpStatus('loading')
    const { error: candidateErr } = await supabase
      .from('geo_entity_candidates')
      .update({ status: 'rejected' })
      .eq('normalized_name', (cluster.discovery_hints?.city_name ?? cluster.raw_value ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim())
      .eq('status', 'pending')

    if (candidateErr) { setOpStatus('error'); setOpMsg(candidateErr.message); return }

    const { error } = await supabase
      .from('resolution_conflicts')
      .update({ status: 'dismissed', editorial_updated_at: new Date().toISOString() })
      .eq('id', cluster.id)

    if (error) { setOpStatus('error'); setOpMsg(error.message); return }

    await writeEditorialAction(supabase, cluster.id, 'discovery_rejected', {
      city_name: cluster.discovery_hints?.city_name,
    })
    setOpStatus('done')
    setOpMsg('candidate rejected and conflict dismissed')
    setTimeout(() => onAction('refresh'), 1000)
  }

  async function handleInReview() {
    setOpStatus('loading')
    const { error } = await supabase
      .from('resolution_conflicts')
      .update({ status: 'in_review', editorial_updated_at: new Date().toISOString() })
      .eq('id', cluster.id)
    if (error) { setOpStatus('error'); setOpMsg(error.message); return }
    await writeEditorialAction(supabase, cluster.id, 'in_review', {})
    setOpStatus('done')
    setOpMsg('marked in review')
    setTimeout(() => onAction('refresh'), 1000)
  }

  async function handleProviderBug() {
    setOpStatus('loading')
    const { error } = await supabase
      .from('resolution_conflicts')
      .update({ status: 'provider_bug', editorial_updated_at: new Date().toISOString() })
      .eq('id', cluster.id)
    if (error) { setOpStatus('error'); setOpMsg(error.message); return }
    await writeEditorialAction(supabase, cluster.id, 'provider_bug', {})
    setOpStatus('done')
    setOpMsg('marked provider bug')
    setTimeout(() => onAction('refresh'), 1000)
  }

  async function handleDismiss() {
    setOpStatus('loading')
    const { error } = await supabase
      .from('resolution_conflicts')
      .update({ status: 'dismissed', editorial_updated_at: new Date().toISOString() })
      .eq('id', cluster.id)
    if (error) { setOpStatus('error'); setOpMsg(error.message); return }
    await writeEditorialAction(supabase, cluster.id, 'dismiss', {})
    setOpStatus('done')
    setOpMsg('dismissed')
    setTimeout(() => onAction('refresh'), 1000)
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

      {/* Non-actionable notice — shown before candidates/actions to communicate constraint early */}
      {isNonActionable(cluster.conflict_type) && (
        <NonActionableNotice conflictType={cluster.conflict_type} />
      )}

      {/* VENUE_WITHOUT_GEO — attach geo entity to venue */}
      {isVenueWithoutGeo && venueCandidate && (
        <div className="mb-6 rounded border border-yellow-200 bg-yellow-50 px-4 py-3">
          <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-2">Venue to fix</h2>
          <p className="text-xs text-gray-700 font-mono mb-3">
            {venueCandidate.display_name}
            <span className="text-gray-400 ml-1">({venueCandidate.id})</span>
          </p>
          <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-2">Assign geo entity</h2>
          <select
            value={selectedEntityId ?? ''}
            onChange={e => setSelectedEntityId(e.target.value || null)}
            className="w-full bg-white border border-gray-300 text-gray-900 text-xs rounded px-2 py-1.5 mb-3 focus:outline-none focus:border-blue-400"
          >
            <option value="">— select geo entity —</option>
            {geoEntities.map(g => (
              <option key={g.id} value={g.id}>
                {g.display_name} ({g.level}{g.country_code ? `, ${g.country_code}` : ''})
              </option>
            ))}
          </select>
          <button
            onClick={handleVenueGeoFix}
            disabled={!selectedEntityId || opStatus === 'loading'}
            className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 disabled:opacity-40 text-white text-xs rounded transition-colors"
          >
            {opStatus === 'loading' ? '…' : 'Attach geo entity →'}
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
      fetchConflicts(),
      supabase
        .from('geo_entities')
        .select('id, display_name, level, country_code')
        .eq('status', 'active')
        .order('display_name'),
    ]).then(([conflictsData, entitiesRes]) => {
      if (entitiesRes.data) setGeoEntities(entitiesRes.data)
      setConflicts(conflictsData)
      setLoading(false)
    }).catch(err => {
      setError(err.message)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!selected?.sample_event_ids?.length) { setSampleEvents([]); return }
    setEventsLoading(true)
    supabase
      .from('events')
      .select('title, venue_name, city, geo_confidence, geo_source')
      .in('id', selected.sample_event_ids)
      .then(({ data }) => {
        setSampleEvents(data ?? [])
        setEventsLoading(false)
      })
  }, [selected?.id])

  const loadRuleHistory = useCallback(async (rawValue) => {
    if (rawValue === undefined || rawValue === null) { setRuleHistory([]); return }
    setRuleHistoryLoading(true)
    const { data } = await supabase
      .from('canonical_rules')
      .select('id, match_provider, geo_entity_id, type, scope, source, notes, created_at')
      .eq('match_raw_location', rawValue)
      .order('created_at', { ascending: false })
    setRuleHistory(data ?? [])
    setRuleHistoryLoading(false)
  }, [])

  useEffect(() => {
    if (selected) loadRuleHistory(selected.raw_value)
    else setRuleHistory([])
  }, [selected?.id, loadRuleHistory])

  const refreshClusters = useCallback(async () => {
    setRefreshing(true)
    try {
      const fresh = await fetchConflicts()
      setConflicts(fresh)
      if (selected) {
        const still = fresh.find(c => c.id === selected.id)
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
              onRefreshRuleHistory={() => loadRuleHistory(selected.raw_value)}
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
