import { useState, useEffect, useCallback } from 'react'
import { authClient } from './LoginForm.jsx'

const PAGE_SIZE = 50

const STATUS_BADGE = {
  pending:     'bg-yellow-100 text-yellow-700',
  approved:    'bg-blue-100 text-blue-700',
  rejected:    'bg-gray-100 text-gray-500',
  merged:      'bg-green-100 text-green-700',
  rolled_back: 'bg-orange-100 text-orange-700',
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function getToken() {
  const { data: { session } } = await authClient.auth.getSession()
  return session?.access_token ?? null
}

async function apiFetch(path, opts = {}) {
  const token = await getToken()
  const res = await fetch(`/api/admin/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : '',
      ...(opts.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = body?.error ?? `HTTP ${res.status}`
    throw Object.assign(new Error(msg), { status: res.status, body })
  }
  return body
}

async function fetchCandidates({ status, page }) {
  const qs = new URLSearchParams({ status, page: String(page) })
  return apiFetch(`venue-candidates?${qs}`)
}

async function fetchCandidateRow(id) {
  // Re-fetch a single row by listing with all statuses and filtering client-side.
  // (No GET /venue-candidates/:id route — full re-fetch is acceptably cheap.)
  const { rows } = await apiFetch(`venue-candidates?status=all&page=1`)
  return rows?.find(r => r.id === id) ?? null
}

// ---------------------------------------------------------------------------
// CandidateRow
// ---------------------------------------------------------------------------

function CandidateRow({ row, onApprove, onReject, onMerge, onRollback, opId, opStatus, opResult }) {
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
            <div className={`mb-3 text-xs px-3 py-2 rounded font-mono ${myResult.error ? 'bg-red-50 text-red-700' : 'bg-gray-900 text-green-400'}`}>
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
                {isWorking && opStatus === 'working' ? 'Guardando…' : 'Aprobar'}
              </button>
              <RejectButton id={row.id} onReject={onReject} disabled={isWorking} />
            </div>
          )}

          {row.status === 'approved' && (
            <div className="flex gap-2 items-center">
              <button
                onClick={() => onMerge(row.id)}
                disabled={isWorking}
                className="px-3 py-1.5 bg-green-700 text-white text-xs rounded hover:bg-green-800 disabled:opacity-50"
              >
                {isWorking && opStatus === 'working' ? 'Mergeando…' : '⚡ Ejecutar merge'}
              </button>
              <button
                onClick={() => onApprove(row.id, 'restore_pending')}
                disabled={isWorking}
                className="px-2 py-1 text-xs text-gray-500 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 ml-auto"
              >
                Desaprobar
              </button>
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
                  disabled={isWorking}
                  className="ml-auto px-3 py-1.5 bg-orange-100 text-orange-700 text-xs rounded hover:bg-orange-200 disabled:opacity-50"
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
            <div className="flex gap-2 items-center">
              <span className="text-xs text-gray-500">
                ✗ Rechazado{row.rejection_reason ? `: "${row.rejection_reason}"` : ''}
              </span>
              <button
                onClick={() => onApprove(row.id, 'restore_pending')}
                disabled={isWorking}
                className="ml-auto px-2 py-1 text-xs text-gray-500 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50"
              >
                Restaurar
              </button>
            </div>
          )}

          {row.status === 'rolled_back' && (
            <div className="text-xs text-orange-700">↩ Revertido</div>
          )}

          {isWorking && opStatus === 'error' && myResult && (
            <div className="text-xs text-red-600 mt-1">Error: {myResult.error}</div>
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
        placeholder="Motivo de rechazo"
        value={reason}
        onChange={e => setReason(e.target.value)}
        autoFocus
      />
      <button
        onClick={() => { if (reason.trim()) { onReject(id, reason); setOpen(false) } }}
        disabled={!reason.trim()}
        className="px-3 py-1.5 bg-red-100 text-red-700 text-xs rounded hover:bg-red-200 disabled:opacity-50"
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
  const [page, setPage]           = useState(1)
  const [pages, setPages]         = useState(1)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [opId, setOpId]           = useState(null)
  const [opStatus, setOpStatus]   = useState(null)
  const [opResult, setOpResult]   = useState(null)

  const load = useCallback(async (f, p) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchCandidates({ status: f, page: p })
      setRows(result.rows)
      setTotal(result.total)
      setPages(result.pages)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => { load(filter, page) }, [load, filter, page])

  const handleFilterChange = (f) => {
    setFilter(f)
    setPage(1)
  }

  // Shared: after any state-changing operation, re-fetch the row from server
  const refreshRow = useCallback(async (id) => {
    try {
      // Re-fetch current page to get the updated row in context
      const result = await fetchCandidates({ status: filter, page })
      setRows(result.rows)
      setTotal(result.total)
      setPages(result.pages)
    } catch (_) {
      // Silent — stale row is acceptable if refresh fails; user can reload
    }
  }, [filter, page])

  const handleApprove = useCallback(async (id, action = 'approve') => {
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      const endpoint = action === 'restore_pending' ? 'restore-pending' : 'approve'
      await apiFetch(`venue-candidates/${id}/${endpoint}`, { method: 'POST' })
      setOpStatus('done')
      await refreshRow(id)
    } catch (err) {
      setOpStatus('error')
      setOpResult({ error: err.message })
    }
    setOpId(null)
  }, [refreshRow])

  const handleReject = useCallback(async (id, reason) => {
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      await apiFetch(`venue-candidates/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
      setOpStatus('done')
      await refreshRow(id)
    } catch (err) {
      setOpStatus('error')
      setOpResult({ error: err.message })
    }
    setOpId(null)
  }, [refreshRow])

  const handleMerge = useCallback(async (id) => {
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      const result = await apiFetch(`venue-candidates/${id}/merge`, { method: 'POST' })
      setOpStatus('done')
      setOpResult(result.result?.merge ?? result)
      await refreshRow(id)
    } catch (err) {
      setOpStatus('error')
      setOpResult({ error: err.message })
    }
    // Keep opId briefly so result banner stays visible
    setTimeout(() => setOpId(null), 5000)
  }, [refreshRow])

  const handleRollback = useCallback(async (id) => {
    setOpId(id); setOpStatus('working'); setOpResult(null)
    try {
      const result = await apiFetch(`venue-candidates/${id}/rollback`, { method: 'POST' })
      setOpStatus('done')
      setOpResult(result.result?.rollback ?? result)
      await refreshRow(id)
    } catch (err) {
      setOpStatus('error')
      setOpResult({ error: err.message })
    }
    setTimeout(() => setOpId(null), 5000)
  }, [refreshRow])

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
        <div className="ml-auto flex items-center gap-2">
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

      {/* Stats bar */}
      <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 flex gap-4 flex-shrink-0">
        <span>{total} candidatos</span>
        <span className="ml-auto">
          Página {page} de {pages || 1}
          {pages > 1 && (
            <>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="ml-3 px-2 py-0.5 border border-gray-300 rounded text-xs disabled:opacity-40 hover:bg-gray-100"
              >
                ←
              </button>
              <button
                onClick={() => setPage(p => Math.min(pages, p + 1))}
                disabled={page >= pages}
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
