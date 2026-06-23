import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabase.js'

const PAGE_SIZE = 50

const STATUS_BADGE = {
  pending:     'bg-yellow-100 text-yellow-700',
  approved:    'bg-blue-100 text-blue-700',
  rejected:    'bg-gray-100 text-gray-500',
  merged:      'bg-green-100 text-green-700',
  rolled_back: 'bg-orange-100 text-orange-700',
}

const ACTORS = ['fabio', 'admin']
const ACTOR_KEY = 'workbench:actor'

// ---------------------------------------------------------------------------
// ActorSelector
// ---------------------------------------------------------------------------

function ActorSelector({ actor, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">Actor:</span>
      {actor ? (
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-gray-900 bg-gray-100 px-2 py-0.5 rounded">
            {actor}
          </span>
          <button
            onClick={() => onChange(null)}
            className="text-xs text-gray-400 hover:text-gray-600"
            title="Cambiar actor"
          >
            ✕
          </button>
        </div>
      ) : (
        <select
          className="text-xs border border-orange-300 rounded px-2 py-0.5 bg-orange-50 text-gray-700"
          defaultValue=""
          onChange={e => e.target.value && onChange(e.target.value)}
        >
          <option value="" disabled>Seleccioná un actor…</option>
          {ACTORS.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchCandidates({ status, offset }) {
  let q = supabase
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
  if (error) throw new Error(error.message)
  return { rows: data ?? [], total: count ?? 0 }
}

async function updateStatus(id, status, rejectionReason = null) {
  const { error } = await supabase
    .from('venue_merge_candidates')
    .update({ status, ...(rejectionReason != null ? { rejection_reason: rejectionReason } : {}) })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

async function callMerge(candidateId, actor) {
  const { data, error } = await supabase.rpc('merge_venue_pair', {
    p_candidate_id: candidateId,
    p_actor: actor,
  })
  if (error) throw new Error(error.message)
  return data
}

async function callRollback(candidateId, actor) {
  const { data, error } = await supabase.rpc('rollback_venue_merge', {
    p_candidate_id: candidateId,
    p_actor: actor,
  })
  if (error) throw new Error(error.message)
  return data
}

// ---------------------------------------------------------------------------
// CandidateRow
// ---------------------------------------------------------------------------

function CandidateRow({ row, actor, onApprove, onReject, onMerge, onRollback, opId, opStatus, opResult }) {
  const [expanded, setExpanded] = useState(false)
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false)
  const isWorking = opId === row.id

  const keep = row.keep
  const drop = row.drop
  const totalEvents = (keep?.event_count ?? 0) + (drop?.event_count ?? 0)
  const myResult = opId === row.id ? opResult : null

  return (
    <div className={`border-b border-gray-200 ${expanded ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
      {/* Summary row */}
      <button
        className="w-full text-left px-4 py-3 flex items-center gap-3"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="text-gray-400 text-xs w-4">{expanded ? '▼' : '▶'}</span>
        <span className="font-medium text-gray-900 flex-1 truncate">
          {keep?.canonical_name ?? '(unknown)'}
        </span>
        <span className="text-xs text-gray-500 shrink-0">
          {keep?.city ?? <em className="text-orange-400">no city</em>}
        </span>
        <span className="text-xs text-gray-400 shrink-0">{totalEvents} events</span>
        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATUS_BADGE[row.status] ?? 'bg-gray-100 text-gray-500'}`}>
          {row.status}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <VenueCard label="KEEP" venue={keep} accent="border-green-400" />
            <VenueCard label="DROP (city=NULL)" venue={drop} accent="border-red-300" />
          </div>

          {/* Result banner */}
          {myResult && (
            <div className="mb-3 text-xs px-3 py-2 rounded bg-gray-900 text-green-400 font-mono">
              {JSON.stringify(myResult, null, 2)}
            </div>
          )}

          {/* Actions */}
          {row.status === 'pending' && (
            <div className="flex gap-2">
              <button
                onClick={() => onApprove(row.id)}
                disabled={isWorking}
                className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {isWorking && opStatus === 'working' ? 'Saving…' : 'Aprobar'}
              </button>
              <RejectButton id={row.id} onReject={onReject} disabled={isWorking} />
            </div>
          )}

          {row.status === 'approved' && (
            <div className="flex gap-2 items-center">
              <button
                onClick={() => onMerge(row.id)}
                disabled={isWorking || !actor}
                className="px-3 py-1.5 bg-green-700 text-white text-xs rounded hover:bg-green-800 disabled:opacity-50"
                title={!actor ? 'Seleccioná un actor primero' : undefined}
              >
                {isWorking && opStatus === 'working' ? 'Mergeando…' : '⚡ Ejecutar merge'}
              </button>
              <button
                onClick={() => onApprove(row.id, 'pending')}
                disabled={isWorking}
                className="px-2 py-1 text-xs text-gray-500 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 ml-auto"
              >
                Desaprobar
              </button>
              {!actor && (
                <span className="text-xs text-orange-500">⚠ Seleccioná un actor para mergear</span>
              )}
            </div>
          )}

          {row.status === 'merged' && (
            <div className="flex gap-2 items-center">
              <div className="text-xs text-green-700">
                ✓ Mergeado
                {row.rule_was_created != null && (
                  <span className="ml-2 text-gray-400">
                    · rule {row.rule_was_created ? 'creada' : 'preexistente preservada'}
                    {row.created_rule_id ? ` (#${row.created_rule_id})` : ''}
                  </span>
                )}
              </div>
              {!showRollbackConfirm ? (
                <button
                  onClick={() => setShowRollbackConfirm(true)}
                  disabled={isWorking || !actor}
                  className="ml-auto px-3 py-1.5 bg-orange-100 text-orange-700 text-xs rounded hover:bg-orange-200 disabled:opacity-50"
                  title={!actor ? 'Seleccioná un actor primero' : undefined}
                >
                  ↩ Rollback
                </button>
              ) : (
                <div className="ml-auto flex gap-2 items-center">
                  <span className="text-xs text-orange-600">¿Confirmar rollback?</span>
                  <button
                    onClick={() => { setShowRollbackConfirm(false); onRollback(row.id) }}
                    disabled={isWorking}
                    className="px-3 py-1.5 bg-orange-600 text-white text-xs rounded hover:bg-orange-700 disabled:opacity-50"
                  >
                    {isWorking && opStatus === 'working' ? 'Revirtiendo…' : 'Confirmar'}
                  </button>
                  <button
                    onClick={() => setShowRollbackConfirm(false)}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </div>
          )}

          {row.status === 'rejected' && (
            <div className="text-xs text-gray-500">
              ✗ Rechazado{row.rejection_reason ? `: "${row.rejection_reason}"` : ''}
            </div>
          )}

          {row.status === 'rolled_back' && (
            <div className="text-xs text-orange-700">↩ Revertido</div>
          )}

          {isWorking && opStatus === 'error' && (
            <div className="text-xs text-red-600 mt-1">Error al guardar</div>
          )}
        </div>
      )}
    </div>
  )
}

function VenueCard({ label, venue, accent }) {
  if (!venue) return <div className={`border-l-4 ${accent} pl-3 text-xs text-gray-400`}>(missing)</div>
  return (
    <div className={`border-l-4 ${accent} pl-3 text-xs space-y-0.5`}>
      <div className="font-semibold text-gray-700 uppercase tracking-wide text-[10px] mb-1">{label}</div>
      <div className="font-medium text-gray-900">{venue.canonical_name}</div>
      <div className="text-gray-500">city: <span className={venue.city ? 'text-gray-800' : 'text-orange-500 font-medium'}>{venue.city ?? 'NULL'}</span></div>
      <div className="text-gray-400 font-mono text-[10px] truncate">{venue.fingerprint}</div>
      {venue.lat != null && (
        <div className="text-gray-400">{venue.lat.toFixed(5)}, {venue.lng.toFixed(5)}</div>
      )}
      <div className="text-gray-500">{venue.event_count} eventos</div>
    </div>
  )
}

function RejectButton({ id, onReject, disabled }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="px-3 py-1.5 border border-gray-300 text-gray-700 text-xs rounded hover:bg-gray-100 disabled:opacity-50"
      >
        Rechazar
      </button>
    )
  }

  return (
    <div className="flex gap-2 items-center">
      <input
        className="text-xs border border-gray-300 rounded px-2 py-1 w-48"
        placeholder="Motivo (opcional)"
        value={reason}
        onChange={e => setReason(e.target.value)}
        autoFocus
      />
      <button
        onClick={() => { onReject(id, reason); setOpen(false) }}
        className="px-3 py-1.5 bg-red-100 text-red-700 text-xs rounded hover:bg-red-200"
      >
        Confirmar rechazo
      </button>
      <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-600">
        Cancelar
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// VenueCandidates — main component
// ---------------------------------------------------------------------------

export default function VenueCandidates() {
  const [filter, setFilter]       = useState('pending')
  const [rows, setRows]           = useState([])
  const [total, setTotal]         = useState(0)
  const [offset, setOffset]       = useState(0)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [opId, setOpId]           = useState(null)
  const [opStatus, setOpStatus]   = useState(null)
  const [opResult, setOpResult]   = useState(null)
  const [actor, setActor]         = useState(() => localStorage.getItem(ACTOR_KEY) ?? null)

  const handleActorChange = (a) => {
    setActor(a)
    if (a) localStorage.setItem(ACTOR_KEY, a)
    else localStorage.removeItem(ACTOR_KEY)
  }

  const load = useCallback(async (f, o) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchCandidates({ status: f, offset: o })
      setRows(result.rows)
      setTotal(result.total)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load(filter, offset) }, [load, filter, offset])

  const handleFilterChange = (f) => {
    setFilter(f)
    setOffset(0)
  }

  const handleApprove = useCallback(async (id, targetStatus = 'approved') => {
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      await updateStatus(id, targetStatus)
      setOpStatus('done')
      setRows(prev => prev.map(r => r.id === id ? { ...r, status: targetStatus } : r))
    } catch (err) {
      setOpStatus('error')
      console.error('approve failed:', err.message)
    }
    setOpId(null)
  }, [])

  const handleReject = useCallback(async (id, reason) => {
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      await updateStatus(id, 'rejected', reason || null)
      setOpStatus('done')
      setRows(prev => prev.map(r => r.id === id ? { ...r, status: 'rejected', rejection_reason: reason || null } : r))
    } catch (err) {
      setOpStatus('error')
      console.error('reject failed:', err.message)
    }
    setOpId(null)
  }, [])

  const handleMerge = useCallback(async (id) => {
    if (!actor) return
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      const result = await callMerge(id, actor)
      setOpStatus('done')
      setOpResult(result)
      // Refresh the row from DB to get updated status + rule fields
      const { data } = await supabase
        .from('venue_merge_candidates')
        .select(`
          id, candidate_type, confidence, status, rejection_reason, created_at,
          rule_was_created, created_rule_id,
          keep:venue_id_keep ( id, canonical_name, city, fingerprint, lat, lng, event_count ),
          drop:venue_id_drop ( id, canonical_name, city, fingerprint, lat, lng, event_count )
        `)
        .eq('id', id)
        .single()
      if (data) setRows(prev => prev.map(r => r.id === id ? data : r))
    } catch (err) {
      setOpStatus('error')
      setOpResult({ error: err.message })
      console.error('merge failed:', err.message)
    }
    // Keep opId set so result stays visible; clear after brief delay
    setTimeout(() => setOpId(null), 5000)
  }, [actor])

  const handleRollback = useCallback(async (id) => {
    if (!actor) return
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      const result = await callRollback(id, actor)
      setOpStatus('done')
      setOpResult(result)
      // Refresh the row
      const { data } = await supabase
        .from('venue_merge_candidates')
        .select(`
          id, candidate_type, confidence, status, rejection_reason, created_at,
          rule_was_created, created_rule_id,
          keep:venue_id_keep ( id, canonical_name, city, fingerprint, lat, lng, event_count ),
          drop:venue_id_drop ( id, canonical_name, city, fingerprint, lat, lng, event_count )
        `)
        .eq('id', id)
        .single()
      if (data) setRows(prev => prev.map(r => r.id === id ? data : r))
    } catch (err) {
      setOpStatus('error')
      setOpResult({ error: err.message })
      console.error('rollback failed:', err.message)
    }
    setTimeout(() => setOpId(null), 5000)
  }, [actor])

  const totalPages  = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 bg-white flex items-center gap-4 flex-shrink-0">
        <div>
          <div className="font-semibold text-gray-900 text-sm">Venue Merge Candidates</div>
          <div className="text-xs text-gray-400 mt-0.5">
            Venues con mismo nombre y coords idénticas — uno tiene city=NULL
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <ActorSelector actor={actor} onChange={handleActorChange} />
          <div className="flex gap-2">
            {['pending', 'approved', 'rejected', 'merged', 'rolled_back', 'all'].map(s => (
              <button
                key={s}
                onClick={() => handleFilterChange(s)}
                className={[
                  'px-3 py-1 text-xs rounded-full border',
                  filter === s
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400',
                ].join(' ')}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 flex gap-4 flex-shrink-0">
        <span>{total} candidatos</span>
        <span className="ml-auto">
          Página {currentPage} de {totalPages || 1}
          {totalPages > 1 && (
            <>
              <button
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                className="ml-3 px-2 py-0.5 border border-gray-300 rounded text-xs disabled:opacity-40 hover:bg-gray-100"
              >
                ←
              </button>
              <button
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className="ml-1 px-2 py-0.5 border border-gray-300 rounded text-xs disabled:opacity-40 hover:bg-gray-100"
              >
                →
              </button>
            </>
          )}
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto bg-white">
        {loading && (
          <div className="px-4 py-6 text-xs text-gray-400 text-center">Cargando…</div>
        )}
        {!loading && error && (
          <div className="px-4 py-6 text-xs text-red-600 text-center">Error: {error}</div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div className="px-4 py-6 text-xs text-gray-400 text-center">
            No hay candidatos con status "{filter}".
          </div>
        )}
        {!loading && !error && rows.map(row => (
          <CandidateRow
            key={row.id}
            row={row}
            actor={actor}
            onApprove={handleApprove}
            onReject={handleReject}
            onMerge={handleMerge}
            onRollback={handleRollback}
            opId={opId}
            opStatus={opStatus}
            opResult={opResult}
          />
        ))}
      </div>
    </div>
  )
}
