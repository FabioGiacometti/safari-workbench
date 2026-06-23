import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabase.js'

const STATUS_LABELS = {
  open:            { label: 'Abierta',          cls: 'bg-red-100 text-red-700' },
  keep_manual:     { label: 'Conservar manual', cls: 'bg-blue-100 text-blue-700' },
  accept_provider: { label: 'Aceptado provider', cls: 'bg-green-100 text-green-700' },
  dismissed:       { label: 'Descartada',       cls: 'bg-gray-100 text-gray-500' },
}

function StatusBadge({ status }) {
  const { label, cls } = STATUS_LABELS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-500' }
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium ${cls}`}>
      {label}
    </span>
  )
}

function formatVal(raw) {
  if (raw === null || raw === undefined) return <span className="text-gray-300 italic">null</span>
  if (typeof raw === 'object' && 'value' in raw) {
    return <span className="font-mono">{String(raw.value)}</span>
  }
  return <span className="font-mono">{JSON.stringify(raw)}</span>
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// AcceptPreview — shown before confirming accept_provider
// ---------------------------------------------------------------------------

function AcceptPreview({ disc, onConfirm, onCancel, loading }) {
  const field = disc.field_name
  const manualVal = disc.manual_value
  const providerVal = disc.provider_value

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-5 max-w-md w-full mx-4">
        <h3 className="font-semibold text-sm text-gray-900 mb-3">
          Aceptar valor del provider
        </h3>
        <p className="text-[11px] text-gray-500 mb-4">
          Venue: <span className="font-semibold text-gray-700">{disc.venues?.canonical_name ?? disc.venue_id}</span>
          <br />
          Campo: <span className="font-mono text-gray-700">{field}</span>
          <br />
          Provider: <span className="text-gray-700">{disc.provider}</span>
        </p>

        <div className="space-y-2 mb-5">
          <div className="p-2 bg-red-50 border border-red-200 rounded">
            <p className="text-[10px] text-red-400 uppercase font-semibold mb-0.5">
              Valor manual actual (será reemplazado)
            </p>
            <div className="text-xs">{formatVal(manualVal)}</div>
          </div>
          <div className="p-2 bg-green-50 border border-green-200 rounded">
            <p className="text-[10px] text-green-600 uppercase font-semibold mb-0.5">
              Valor del provider (quedará en el venue)
            </p>
            <div className="text-xs">{formatVal(providerVal)}</div>
          </div>
          <div className="p-2 bg-yellow-50 border border-yellow-200 rounded text-[10px] text-yellow-700">
            El campo <span className="font-mono">{field}</span> será eliminado de{' '}
            <span className="font-mono">manually_edited_fields</span> y el pipeline podrá
            sobreescribirlo en el futuro.
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:border-gray-400 disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="text-xs px-4 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-40"
          >
            {loading ? 'Guardando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row — single discrepancy
// ---------------------------------------------------------------------------

function DiscrepancyRow({ disc, actor, onResolved, onRequestPreview, actionLoadingId, odd }) {
  const [error, setError] = useState(null)
  const loading = actionLoadingId === disc.id

  async function resolve(action) {
    if (!actor) {
      setError('Seleccioná un actor antes de resolver.')
      return
    }
    setError(null)
    try {
      const { data, error: rpcErr } = await supabase.rpc('resolve_venue_discrepancy', {
        p_discrepancy_id: disc.id,
        p_action: action,
        p_actor: actor,
      })
      if (rpcErr) throw new Error(rpcErr.message)
      if (data && data.ok === false) throw new Error(data.error ?? 'RPC returned ok=false')
      onResolved(disc.id, action)
    } catch (err) {
      setError(err.message)
    }
  }

  const isOpen    = disc.status === 'open'
  const venueName = disc.venues?.canonical_name ?? disc.venue_id
  const city      = disc.venues?.city ?? '—'

  return (
    <tr className={odd ? 'bg-gray-50' : 'bg-white'}>
      {/* Venue */}
      <td className="px-3 py-2 text-[11px]">
        <div className="font-medium text-gray-900 leading-tight">{venueName}</div>
        <div className="text-gray-400 font-mono text-[10px]">{disc.venues?.fingerprint ?? '—'}</div>
        <div className="text-gray-400 text-[10px]">{city}</div>
      </td>
      {/* Field */}
      <td className="px-3 py-2 text-[11px] font-mono text-gray-700">{disc.field_name}</td>
      {/* Manual value */}
      <td className="px-3 py-2 text-[11px] max-w-[140px]">
        <div className="truncate" title={JSON.stringify(disc.manual_value)}>
          {formatVal(disc.manual_value)}
        </div>
      </td>
      {/* Provider value */}
      <td className="px-3 py-2 text-[11px] max-w-[140px]">
        <div className="truncate" title={JSON.stringify(disc.provider_value)}>
          {formatVal(disc.provider_value)}
        </div>
      </td>
      {/* Provider */}
      <td className="px-3 py-2 text-[11px] text-gray-500">{disc.provider}</td>
      {/* Detected */}
      <td className="px-3 py-2 text-[10px] text-gray-400 whitespace-nowrap">
        {fmtDate(disc.detected_at)}
      </td>
      {/* Status */}
      <td className="px-3 py-2">
        <StatusBadge status={disc.status} />
        {disc.resolved_at && (
          <div className="text-[10px] text-gray-400 mt-0.5">
            {fmtDate(disc.resolved_at)}
            {disc.resolved_by && ` · ${disc.resolved_by}`}
          </div>
        )}
      </td>
      {/* Actions */}
      <td className="px-3 py-2">
        {isOpen ? (
          <div className="flex flex-col gap-1.5 min-w-[130px]">
            <button
              onClick={() => resolve('keep_manual')}
              disabled={loading}
              title="Conservar el valor manual; marcar como revisada"
              className="text-[10px] px-2 py-1 border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-40 text-left"
            >
              {loading ? '…' : 'Conservar manual'}
            </button>
            <button
              onClick={() => onRequestPreview(disc)}
              disabled={loading}
              title="Ver preview y luego aceptar el valor del provider"
              className="text-[10px] px-2 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-40 text-left"
            >
              Aceptar provider
            </button>
            <button
              onClick={() => resolve('dismissed')}
              disabled={loading}
              title="Descartar alerta sin cambiar nada"
              className="text-[10px] px-2 py-1 border border-gray-300 text-gray-500 rounded hover:bg-gray-50 disabled:opacity-40 text-left"
            >
              {loading ? '…' : 'Descartar'}
            </button>
            {error && (
              <p className="text-[10px] text-red-600 leading-tight">{error}</p>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-gray-400 italic">
            {disc.resolution ?? '—'}
          </div>
        )}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// VenueDiscrepancies — main component
// ---------------------------------------------------------------------------

const ACTORS = ['fabio', 'admin']

export default function VenueDiscrepancies() {
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  // Actor — shared via localStorage with other sections
  const [actor, setActor] = useState(() => localStorage.getItem('workbench:actor') || '')
  function handleActorChange(a) {
    setActor(a)
    localStorage.setItem('workbench:actor', a)
  }

  // Filters
  const [filterStatus,   setFilterStatus]   = useState('open')
  const [filterProvider, setFilterProvider] = useState('')
  const [filterField,    setFilterField]    = useState('')
  const [filterCity,     setFilterCity]     = useState('')
  const [filterSearch,   setFilterSearch]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let q = supabase
        .from('venue_discrepancies')
        .select(`
          id, venue_id, field_name, manual_value, provider_value, provider,
          detected_at, status, resolved_at, resolved_by, resolution,
          venues ( id, canonical_name, fingerprint, city )
        `)
        .order('status',       { ascending: true })   // open sorts before others lexically
        .order('detected_at',  { ascending: false })

      if (filterStatus)   q = q.eq('status',   filterStatus)
      if (filterProvider) q = q.eq('provider', filterProvider)
      if (filterField)    q = q.eq('field_name', filterField)

      const { data, error: err } = await q.limit(500)
      if (err) throw new Error(err.message)
      setRows(data ?? [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterProvider, filterField])

  useEffect(() => { load() }, [load])

  // Preview modal state — lives here so it's rendered outside the table
  const [previewDisc, setPreviewDisc]       = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  function handleResolved(discId, action) {
    setRows(prev => prev.map(r =>
      r.id === discId
        ? { ...r, status: action, resolved_at: new Date().toISOString(), resolved_by: actor }
        : r
    ))
  }

  async function handleConfirmAccept() {
    if (!previewDisc) return
    setPreviewLoading(true)
    try {
      const { data, error: rpcErr } = await supabase.rpc('resolve_venue_discrepancy', {
        p_discrepancy_id: previewDisc.id,
        p_action: 'accept_provider',
        p_actor: actor,
      })
      if (rpcErr) throw new Error(rpcErr.message)
      if (data && data.ok === false) throw new Error(data.error ?? 'RPC error')
      handleResolved(previewDisc.id, 'accept_provider')
      setPreviewDisc(null)
    } catch (err) {
      setError(err.message)
      setPreviewDisc(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  // Client-side city + search filters (applied after DB fetch)
  const visible = rows.filter(r => {
    if (filterCity) {
      const city = (r.venues?.city ?? '').toLowerCase()
      if (!city.includes(filterCity.toLowerCase())) return false
    }
    if (filterSearch) {
      const term = filterSearch.toLowerCase()
      const name = (r.venues?.canonical_name ?? '').toLowerCase()
      const fp   = (r.venues?.fingerprint ?? '').toLowerCase()
      if (!name.includes(term) && !fp.includes(term)) return false
    }
    return true
  })

  // Derive unique values for filter dropdowns from loaded data
  const providers  = [...new Set(rows.map(r => r.provider).filter(Boolean))].sort()
  const fields     = [...new Set(rows.map(r => r.field_name).filter(Boolean))].sort()

  const openCount  = rows.filter(r => r.status === 'open').length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">
            Discrepancias de venues
            {openCount > 0 && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-medium">
                {openCount} abiertas
              </span>
            )}
          </h2>
          <p className="text-[10px] text-gray-400 mt-0.5">
            Conflictos entre valores manuales y valores del pipeline
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-[10px] px-2 py-1 border border-gray-300 rounded hover:border-gray-400 disabled:opacity-40"
        >
          {loading ? '…' : 'Recargar'}
        </button>
      </div>

      {/* Filters */}
      <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap items-center gap-3 flex-shrink-0 bg-gray-50">
        {/* Status */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-gray-500 uppercase font-semibold">Estado</label>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="text-[10px] border border-gray-300 rounded px-1.5 py-0.5 bg-white"
          >
            <option value="">Todos</option>
            <option value="open">Abiertas</option>
            <option value="keep_manual">Conservar manual</option>
            <option value="accept_provider">Aceptado provider</option>
            <option value="dismissed">Descartadas</option>
          </select>
        </div>

        {/* Provider */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-gray-500 uppercase font-semibold">Provider</label>
          <select
            value={filterProvider}
            onChange={e => setFilterProvider(e.target.value)}
            className="text-[10px] border border-gray-300 rounded px-1.5 py-0.5 bg-white"
          >
            <option value="">Todos</option>
            {providers.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {/* Field */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-gray-500 uppercase font-semibold">Campo</label>
          <select
            value={filterField}
            onChange={e => setFilterField(e.target.value)}
            className="text-[10px] border border-gray-300 rounded px-1.5 py-0.5 bg-white"
          >
            <option value="">Todos</option>
            {fields.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* City */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-gray-500 uppercase font-semibold">Ciudad</label>
          <input
            type="text"
            value={filterCity}
            onChange={e => setFilterCity(e.target.value)}
            placeholder="filtrar…"
            className="text-[10px] border border-gray-300 rounded px-1.5 py-0.5 w-24"
          />
        </div>

        {/* Search */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-gray-500 uppercase font-semibold">Venue</label>
          <input
            type="text"
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            placeholder="buscar nombre…"
            className="text-[10px] border border-gray-300 rounded px-1.5 py-0.5 w-32"
          />
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          <label className="text-[10px] text-gray-500 uppercase font-semibold">Actor</label>
          <select
            value={actor}
            onChange={e => handleActorChange(e.target.value)}
            className="text-[10px] border border-gray-300 rounded px-1.5 py-0.5 bg-white"
          >
            <option value="">—</option>
            {ACTORS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          {!actor && (
            <span className="text-[10px] text-orange-500 italic">requerido para resolver</span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-[11px] text-red-700">
          Error: {error}
        </div>
      )}

      {/* Accept preview modal — rendered outside table to avoid DOM nesting error */}
      {previewDisc && (
        <AcceptPreview
          disc={previewDisc}
          onConfirm={handleConfirmAccept}
          onCancel={() => setPreviewDisc(null)}
          loading={previewLoading}
        />
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-xs text-gray-400">
            Cargando…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-xs text-gray-400">
            {rows.length === 0 ? 'Sin discrepancias.' : 'Ninguna coincide con los filtros.'}
          </div>
        ) : (
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-gray-200 bg-white sticky top-0 z-10">
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Venue</th>
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Campo</th>
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Valor manual</th>
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Valor provider</th>
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Provider</th>
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Detectada</th>
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Estado</th>
                <th className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((disc, i) => (
                <DiscrepancyRow
                  key={disc.id}
                  disc={disc}
                  actor={actor}
                  onResolved={handleResolved}
                  onRequestPreview={setPreviewDisc}
                  actionLoadingId={previewLoading ? previewDisc?.id : null}
                  odd={i % 2 === 1}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-100 text-[10px] text-gray-400 flex-shrink-0">
        {visible.length} de {rows.length} discrepancia{rows.length !== 1 ? 's' : ''}
        {(filterStatus || filterProvider || filterField || filterCity || filterSearch) &&
          ' (filtros activos)'}
      </div>
    </div>
  )
}
