import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from './supabase.js'
import VenueEditForm from './VenueEditForm.jsx'

const ACTORS = ['fabio', 'admin']

const PAGE_SIZE = 100

// ---------------------------------------------------------------------------
// Data fetching — single query via venues_catalog view, no N+1
// ---------------------------------------------------------------------------

async function fetchVenues({ search, city, statusFilter, noCity, driftOnly, order, offset }) {
  let q = supabase
    .from('venues_catalog')
    .select('*', { count: 'exact' })
    .range(offset, offset + PAGE_SIZE - 1)

  if (search)      q = q.ilike('canonical_name', `%${search}%`)
  if (city)        q = q.ilike('city', `%${city}%`)
  if (noCity)      q = q.is('city', null)
  if (statusFilter === 'active')  q = q.is('merged_into', null)
  if (statusFilter === 'merged')  q = q.not('merged_into', 'is', null)

  if (order === 'name')   q = q.order('canonical_name', { ascending: true })
  if (order === 'events') q = q.order('real_event_count', { ascending: false })
  if (order === 'city')   q = q.order('city', { ascending: true, nullsFirst: false })

  const { data, error, count } = await q
  if (error) throw new Error(error.message)

  let rows = data ?? []

  // drift filter is client-side (no SQL column for it in the view filter)
  if (driftOnly) rows = rows.filter(r => Number(r.real_event_count) !== Number(r.stored_event_count))

  return { rows, total: count ?? 0 }
}

async function fetchVenueDetail(id) {
  const { data, error } = await supabase
    .from('venues_catalog')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function fetchVenueEvents(venueId) {
  const { data, error } = await supabase
    .from('events')
    .select('id, title, venue_name, city, year, month, day, provider, venue_fingerprint')
    .eq('venue_id', venueId)
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .order('day', { ascending: false })
    .limit(20)
  if (error) throw new Error(error.message)
  return data ?? []
}

async function fetchVenueMergeHistory(venueId) {
  const { data } = await supabase
    .from('venue_merge_event_log')
    .select('id, candidate_id, event_id, old_venue_id, new_venue_id, old_fingerprint, new_fingerprint, merged_at')
    .or(`old_venue_id.eq.${venueId},new_venue_id.eq.${venueId}`)
    .order('merged_at', { ascending: false })
    .limit(20)
  return data ?? []
}

async function fetchVenueMutations(venueId) {
  const { data } = await supabase
    .from('venue_mutations')
    .select('id, mutation_type, provider, occurred_at, old_value, new_value')
    .eq('venue_id', venueId)
    .order('occurred_at', { ascending: false })
    .limit(10)
  return data ?? []
}

async function fetchVenueRules(venueId, canonicalName) {
  const { data } = await supabase
    .from('canonical_rules')
    .select('id, match_raw_location, match_provider, type, scope, source, confidence, notes, created_by, created_at')
    .or(`venue_id.eq.${venueId},match_raw_location.eq.${canonicalName}`)
    .order('created_at', { ascending: false })
    .limit(10)
  return data ?? []
}

async function fetchVenueByIdMinimal(id) {
  const { data } = await supabase
    .from('venues')
    .select('id, canonical_name, city, fingerprint')
    .eq('id', id)
    .single()
  return data
}

async function fetchVenueDiscrepancies(venueId) {
  const { data } = await supabase
    .from('venue_discrepancies')
    .select('id, field_name, manual_value, provider_value, provider, detected_at, status, resolved_at, resolved_by, resolution')
    .eq('venue_id', venueId)
    .order('status',      { ascending: true })
    .order('detected_at', { ascending: false })
    .limit(50)
  return data ?? []
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(val) { return val ?? '—' }

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-AR', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtEventDate(y, m, d) {
  if (!y) return '—'
  return [y, String(m ?? 1).padStart(2, '0'), String(d ?? 1).padStart(2, '0')].join('-')
}

function DriftBadge({ stored, real }) {
  const s = Number(stored ?? 0)
  const r = Number(real ?? 0)
  if (s === r) return null
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-mono shrink-0"
          title={`stored=${s} real=${r}`}>
      drift {r}≠{s}
    </span>
  )
}

function StatusBadge({ mergedInto }) {
  if (!mergedInto) return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 shrink-0">active</span>
  )
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">merged</span>
  )
}

function Pill({ children, color = 'gray' }) {
  const cls = {
    gray:   'bg-gray-100 text-gray-600',
    blue:   'bg-blue-50 text-blue-700',
    orange: 'bg-orange-100 text-orange-700',
    green:  'bg-green-50 text-green-700',
  }[color] ?? 'bg-gray-100 text-gray-600'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{children}</span>
}

// ---------------------------------------------------------------------------
// VenueDetail — panel derecho
// ---------------------------------------------------------------------------

function VenueDetail({ venueId, onNavigateTo, onEditRequest, actor }) {
  const [venue, setVenue]               = useState(null)
  const [events, setEvents]             = useState([])
  const [mergeLog, setMergeLog]         = useState([])
  const [mutations, setMutations]       = useState([])
  const [rules, setRules]               = useState([])
  const [discrepancies, setDiscrepancies] = useState([])
  const [mergedIntoVenue, setMergedIntoVenue] = useState(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)
  const [discErr, setDiscErr]           = useState(null)

  useEffect(() => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    setDiscErr(null)
    setMergedIntoVenue(null)

    fetchVenueDetail(venueId)
      .then(async v => {
        setVenue(v)
        const [evts, log, muts, rls, discs] = await Promise.all([
          fetchVenueEvents(venueId),
          fetchVenueMergeHistory(venueId),
          fetchVenueMutations(venueId),
          fetchVenueRules(venueId, v.canonical_name),
          fetchVenueDiscrepancies(venueId),
        ])
        setEvents(evts)
        setMergeLog(log)
        setMutations(muts)
        setRules(rls)
        setDiscrepancies(discs)

        if (v.merged_into) {
          const target = await fetchVenueByIdMinimal(v.merged_into)
          setMergedIntoVenue(target)
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [venueId])

  async function resolveDisc(discId, action) {
    if (!actor) {
      setDiscErr('Seleccioná un actor antes de resolver.')
      return
    }
    setDiscErr(null)
    const { data, error: rpcErr } = await supabase.rpc('resolve_venue_discrepancy', {
      p_discrepancy_id: discId,
      p_action: action,
      p_actor: actor,
    })
    if (rpcErr) { setDiscErr(rpcErr.message); return }
    if (data && data.ok === false) { setDiscErr(data.error ?? 'RPC error'); return }
    setDiscrepancies(prev => prev.map(d =>
      d.id === discId
        ? { ...d, status: action, resolved_at: new Date().toISOString(), resolved_by: actor }
        : d
    ))
  }

  if (!venueId) return (
    <div className="h-full flex items-center justify-center text-gray-400 text-xs">
      Seleccioná un venue para ver su detalle
    </div>
  )

  if (loading) return (
    <div className="h-full flex items-center justify-center text-gray-400 text-xs">Cargando…</div>
  )

  if (error) return (
    <div className="h-full flex items-center justify-center text-red-500 text-xs">Error: {error}</div>
  )

  if (!venue) return null

  const hasDrift = Number(venue.real_event_count) !== Number(venue.stored_event_count)

  return (
    <div className="p-5 max-w-2xl text-xs overflow-y-auto h-full">

      {/* Merged banner */}
      {venue.merged_into && (
        <div className="mb-4 px-3 py-2 rounded border border-orange-200 bg-orange-50 flex items-center gap-2">
          <span className="text-orange-700">Este venue fue absorbido por:</span>
          {mergedIntoVenue ? (
            <button
              onClick={() => onNavigateTo(mergedIntoVenue.id)}
              className="text-orange-800 font-semibold underline hover:no-underline"
            >
              {mergedIntoVenue.canonical_name}
            </button>
          ) : (
            <span className="font-mono text-orange-600">{venue.merged_into}</span>
          )}
          <span className="text-orange-500 ml-auto">{fmtDate(venue.merged_at)} · {venue.merged_by}</span>
        </div>
      )}

      {/* Header */}
      <div className="mb-5">
        <div className="flex items-start justify-between gap-2 mb-1">
          <h1 className="text-lg font-bold text-gray-900">{venue.canonical_name}</h1>
          {onEditRequest && !venue.merged_into && (
            <button
              onClick={onEditRequest}
              className="shrink-0 text-[10px] px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              ✏ Editar
            </button>
          )}
          {onEditRequest && venue.merged_into && (
            <button
              onClick={onEditRequest}
              className="shrink-0 text-[10px] px-3 py-1.5 border border-gray-300 rounded text-gray-400 hover:border-gray-400"
              title="Venue merged — ver detalle"
            >
              ✏ Editar
            </button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap mb-1">
          <StatusBadge mergedInto={venue.merged_into} />
          {hasDrift && <DriftBadge stored={venue.stored_event_count} real={venue.real_event_count} />}
          {!venue.city && <Pill color="orange">sin ciudad</Pill>}
          {(venue.aliases?.length > 0) && <Pill color="blue">{venue.aliases.length} alias</Pill>}
          {(venue.manually_edited_fields?.length > 0) && (
            <Pill color="blue" title={venue.manually_edited_fields.join(', ')}>
              {venue.manually_edited_fields.length} protegido(s)
            </Pill>
          )}
          {discrepancies.filter(d => d.status === 'open').length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">
              {discrepancies.filter(d => d.status === 'open').length} discrepancia(s)
            </span>
          )}
        </div>
      </div>

      {/* Campos del venue */}
      <Section title="Campos del registro">
        <FieldGrid>
          <Field label="canonical_name"       value={fmt(venue.canonical_name)} />
          <Field label="display_name"         value={fmt(venue.display_name)} />
          <Field label="city"                 value={fmt(venue.city)} highlight={!venue.city} />
          <Field label="region"               value={fmt(venue.region)} />
          <Field label="fingerprint"          value={fmt(venue.fingerprint)} mono />
          <Field label="lat / lng"            value={venue.lat != null ? `${venue.lat.toFixed(5)}, ${venue.lng.toFixed(5)}` : '—'} mono />
          <Field label="geo_confidence"       value={venue.geo_confidence != null ? `${(venue.geo_confidence * 100).toFixed(1)}%` : '—'} />
          <Field label="resolution_conf."     value={venue.resolution_confidence != null ? `${(venue.resolution_confidence * 100).toFixed(1)}%` : '—'} />
          <Field label="real_event_count"     value={String(venue.real_event_count ?? 0)} highlight={hasDrift} />
          <Field label="stored_event_count"   value={String(venue.stored_event_count ?? 0)} highlight={hasDrift} />
          <Field label="geo_entity_id"        value={fmt(venue.geo_entity_id)} mono />
          <Field label="canonical_city_id"    value={fmt(venue.canonical_city_id)} mono />
          <Field label="created_at"           value={fmtDate(venue.created_at)} />
          <Field label="updated_at"           value={fmtDate(venue.updated_at)} />
        </FieldGrid>

        {venue.aliases?.length > 0 && (
          <div className="mt-3">
            <span className="text-gray-400">aliases:</span>{' '}
            {venue.aliases.map((a, i) => (
              <span key={i} className="inline-block mr-1 mb-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px]">{a}</span>
            ))}
          </div>
        )}
      </Section>

      {/* Eventos asociados */}
      <Section title={`Eventos asociados (${events.length} mostrados, real_count=${venue.real_event_count})`}>
        {events.length === 0 ? (
          <p className="text-gray-400">Sin eventos activos.</p>
        ) : (
          <div className="space-y-1">
            {events.map(e => (
              <div key={e.id} className="flex gap-2 items-baseline py-1 border-b border-gray-100 last:border-0">
                <span className="text-gray-400 w-20 shrink-0 font-mono">{fmtEventDate(e.year, e.month, e.day)}</span>
                <span className="text-gray-800 flex-1 truncate">{e.title}</span>
                <span className="text-gray-400 shrink-0">{e.provider}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Merge history */}
      <Section title={`Historial de merge (${mergeLog.length})`}>
        {mergeLog.length === 0 ? (
          <p className="text-gray-400">Sin historial de merge.</p>
        ) : (
          <div className="space-y-1">
            {mergeLog.map(l => (
              <div key={l.id} className="py-1 border-b border-gray-100 last:border-0">
                <div className="flex gap-2 items-center">
                  <span className="text-gray-400 font-mono text-[10px]">{fmtDate(l.merged_at)}</span>
                  <span className="text-gray-600">evento</span>
                  <span className="font-mono text-[10px] text-gray-700 truncate">{l.event_id}</span>
                </div>
                <div className="text-gray-400 font-mono text-[10px] mt-0.5">
                  {l.old_fingerprint} → {l.new_fingerprint}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Mutations */}
      <Section title={`venue_mutations (${mutations.length})`}>
        {mutations.length === 0 ? (
          <p className="text-gray-400">Sin mutaciones registradas.</p>
        ) : (
          <div className="space-y-1">
            {mutations.map(m => (
              <div key={m.id} className="flex gap-2 items-center py-1 border-b border-gray-100 last:border-0">
                <span className="text-gray-400 font-mono text-[10px]">{fmtDate(m.occurred_at)}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                  m.mutation_type === 'merge' ? 'bg-green-50 text-green-700' :
                  m.mutation_type === 'merge_rollback' ? 'bg-orange-50 text-orange-700' :
                  'bg-gray-100 text-gray-600'
                }`}>{m.mutation_type}</span>
                <span className="text-gray-400">{m.provider}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Canonical rules */}
      <Section title={`canonical_rules (${rules.length})`}>
        {rules.length === 0 ? (
          <p className="text-gray-400">Sin reglas asociadas.</p>
        ) : (
          <div className="space-y-1">
            {rules.map(r => (
              <div key={r.id} className="py-1 border-b border-gray-100 last:border-0">
                <div className="flex gap-2 items-center">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    r.type === 'VENUE_OVERRIDE' ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-blue-700'
                  }`}>{r.type}</span>
                  <span className="text-gray-600 truncate flex-1">{r.match_raw_location}</span>
                  <span className="text-gray-400 shrink-0">
                    {r.match_provider === '' ? 'global' : `prov=${r.match_provider}`}
                  </span>
                </div>
                {r.notes && (
                  <div className="text-gray-400 text-[10px] mt-0.5 italic truncate">{r.notes}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Discrepancias */}
      <Section title={`Discrepancias (${discrepancies.length})`}>
        {discErr && (
          <div className="mb-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[10px] text-red-700">
            {discErr}
          </div>
        )}
        {!actor && discrepancies.some(d => d.status === 'open') && (
          <div className="mb-2 px-2 py-1.5 bg-orange-50 border border-orange-200 rounded text-[10px] text-orange-700">
            Seleccioná un actor para resolver discrepancias.
          </div>
        )}
        {discrepancies.length === 0 ? (
          <p className="text-gray-400">Sin discrepancias.</p>
        ) : (
          <div className="space-y-2">
            {discrepancies.map(d => (
              <DiscrepancyInline
                key={d.id}
                disc={d}
                actor={actor}
                onResolve={resolveDisc}
              />
            ))}
          </div>
        )}
      </Section>

    </div>
  )
}

// ---------------------------------------------------------------------------
// DiscrepancyInline — compact discrepancy card for VenueDetail
// ---------------------------------------------------------------------------

const DISC_STATUS_LABELS = {
  open:            { label: 'Abierta',          cls: 'bg-red-100 text-red-700' },
  keep_manual:     { label: 'Conservar manual', cls: 'bg-blue-100 text-blue-700' },
  accept_provider: { label: 'Aceptado provider', cls: 'bg-green-100 text-green-700' },
  dismissed:       { label: 'Descartada',       cls: 'bg-gray-100 text-gray-500' },
}

function fmtDiscVal(raw) {
  if (raw === null || raw === undefined) return <span className="text-gray-300 italic">null</span>
  if (typeof raw === 'object' && 'value' in raw) return <span className="font-mono">{String(raw.value)}</span>
  return <span className="font-mono">{JSON.stringify(raw)}</span>
}

function DiscrepancyInline({ disc, actor, onResolve }) {
  const [actionLoading, setActionLoading] = useState(null)
  const [showPreview, setShowPreview]     = useState(false)
  const { label, cls } = DISC_STATUS_LABELS[disc.status] ?? { label: disc.status, cls: 'bg-gray-100 text-gray-500' }
  const isOpen = disc.status === 'open'

  async function handle(action) {
    setActionLoading(action)
    await onResolve(disc.id, action)
    setActionLoading(null)
    setShowPreview(false)
  }

  return (
    <div className={`border rounded p-2.5 text-[11px] ${isOpen ? 'border-red-200 bg-red-50' : 'border-gray-100 bg-white'}`}>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="font-mono text-gray-700">{disc.field_name}</span>
        <span className="text-gray-400">·</span>
        <span className="text-gray-500">{disc.provider}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ml-auto ${cls}`}>{label}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mb-1.5">
        <div>
          <div className="text-[10px] text-gray-400 mb-0.5">Valor manual</div>
          <div className="truncate">{fmtDiscVal(disc.manual_value)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400 mb-0.5">Valor provider</div>
          <div className="truncate">{fmtDiscVal(disc.provider_value)}</div>
        </div>
      </div>

      <div className="text-[10px] text-gray-400 mb-1.5">
        Detectada: {new Date(disc.detected_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
        {disc.resolved_at && ` · resuelta: ${new Date(disc.resolved_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })} por ${disc.resolved_by}`}
      </div>

      {isOpen && !showPreview && (
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => handle('keep_manual')}
            disabled={!!actionLoading}
            className="text-[10px] px-2 py-1 border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-40"
          >
            {actionLoading === 'keep_manual' ? '…' : 'Conservar manual'}
          </button>
          <button
            onClick={() => setShowPreview(true)}
            disabled={!!actionLoading}
            className="text-[10px] px-2 py-1 border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-40"
          >
            Aceptar provider
          </button>
          <button
            onClick={() => handle('dismissed')}
            disabled={!!actionLoading}
            className="text-[10px] px-2 py-1 border border-gray-300 text-gray-500 rounded hover:bg-gray-50 disabled:opacity-40"
          >
            {actionLoading === 'dismissed' ? '…' : 'Descartar'}
          </button>
        </div>
      )}

      {isOpen && showPreview && (
        <div className="border border-yellow-200 bg-yellow-50 rounded p-2 mt-1.5">
          <p className="text-[10px] font-semibold text-yellow-700 mb-1.5">
            Confirmá: aceptar valor del provider
          </p>
          <div className="text-[10px] text-yellow-700 mb-2">
            El campo <span className="font-mono">{disc.field_name}</span> se actualizará a{' '}
            <span className="font-semibold">{typeof disc.provider_value === 'object' && disc.provider_value !== null && 'value' in disc.provider_value ? String(disc.provider_value.value) : JSON.stringify(disc.provider_value)}</span>
            {' '}y será removido de <span className="font-mono">manually_edited_fields</span>.
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => handle('accept_provider')}
              disabled={!!actionLoading}
              className="text-[10px] px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-40"
            >
              {actionLoading === 'accept_provider' ? '…' : 'Confirmar'}
            </button>
            <button
              onClick={() => setShowPreview(false)}
              disabled={!!actionLoading}
              className="text-[10px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-40"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {!isOpen && disc.resolution && (
        <div className="text-[10px] text-gray-400 italic">{disc.resolution}</div>
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="mb-5">
      <h2 className="text-[10px] uppercase tracking-widest text-gray-400 mb-2">{title}</h2>
      {children}
    </div>
  )
}

function FieldGrid({ children }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-1">{children}</div>
}

function Field({ label, value, mono, highlight }) {
  return (
    <div className="flex gap-1 items-baseline py-0.5">
      <span className="text-gray-400 w-36 shrink-0">{label}</span>
      <span className={`${mono ? 'font-mono text-[10px]' : ''} ${highlight ? 'text-orange-600 font-semibold' : 'text-gray-800'} truncate`}>
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EditPanel — fetches full venue then renders VenueEditForm
// ---------------------------------------------------------------------------

function EditPanel({ venueId, actor, onSaved, onCancel }) {
  const [venue, setVenue]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  useEffect(() => {
    if (!venueId) return
    setLoading(true)
    fetchVenueDetail(venueId)
      .then(v => { setVenue(v); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [venueId])

  if (loading) return (
    <div className="h-full flex items-center justify-center text-gray-400 text-xs">Cargando…</div>
  )
  if (error) return (
    <div className="h-full flex items-center justify-center text-red-500 text-xs">Error: {error}</div>
  )
  if (!venue) return null

  return (
    <VenueEditForm
      venue={venue}
      actor={actor}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  )
}

// ---------------------------------------------------------------------------
// VenueRow — fila en la lista
// ---------------------------------------------------------------------------

function VenueRow({ venue, isSelected, onClick }) {
  const hasDrift    = Number(venue.real_event_count) !== Number(venue.stored_event_count)
  const hasAliases  = venue.aliases?.length > 0
  const isMerged    = !!venue.merged_into

  return (
    <button
      className={[
        'w-full text-left px-4 py-2.5 border-b border-gray-100 flex items-center gap-3',
        'hover:bg-gray-50 transition-colors',
        isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent',
        isMerged ? 'opacity-50' : '',
      ].join(' ')}
      onClick={onClick}
    >
      {/* Name */}
      <span className={`flex-1 truncate text-xs ${isMerged ? 'line-through text-gray-400' : 'text-gray-900'}`}>
        {venue.canonical_name}
      </span>

      {/* City */}
      <span className="text-[10px] text-gray-500 shrink-0 w-24 truncate text-right">
        {venue.city ?? <em className="text-orange-400 not-italic">sin ciudad</em>}
      </span>

      {/* Event count */}
      <span className="text-[10px] text-gray-400 shrink-0 w-10 text-right font-mono">
        {venue.real_event_count}
      </span>

      {/* Badges */}
      <div className="flex gap-1 shrink-0 w-28 justify-end">
        {hasDrift    && <DriftBadge stored={venue.stored_event_count} real={venue.real_event_count} />}
        {isMerged    && <Pill color="gray">merged</Pill>}
        {hasAliases  && <Pill color="blue">{venue.aliases.length}a</Pill>}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// VenueCatalog — componente principal
// ---------------------------------------------------------------------------

export default function VenueCatalog() {
  // List state
  const [rows, setRows]           = useState([])
  const [total, setTotal]         = useState(0)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [offset, setOffset]       = useState(0)

  // Filters
  const [search, setSearch]       = useState('')
  const [city, setCity]           = useState('')
  const [statusFilter, setStatus] = useState('active')
  const [noCity, setNoCity]       = useState(false)
  const [driftOnly, setDriftOnly] = useState(false)
  const [order, setOrder]         = useState('events')

  // Detail + edit mode
  const [selectedId, setSelectedId] = useState(null)
  const [editMode, setEditMode]     = useState(false)
  const [saveResult, setSaveResult] = useState(null)

  // Actor (shared with VenueCandidates via localStorage)
  const [actor, setActor] = useState(() => localStorage.getItem('workbench:actor') || '')
  function handleActorChange(a) {
    setActor(a)
    localStorage.setItem('workbench:actor', a)
  }

  // Debounce search
  const searchTimer = useRef(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [debouncedCity, setDebouncedCity]     = useState('')

  useEffect(() => {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(search)
      setDebouncedCity(city)
      setOffset(0)
    }, 300)
  }, [search, city])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const t0 = performance.now()
    try {
      const result = await fetchVenues({
        search: debouncedSearch,
        city:   debouncedCity,
        statusFilter,
        noCity,
        driftOnly,
        order,
        offset,
      })
      setRows(result.rows)
      setTotal(result.total)
      if (import.meta.env.DEV) {
        console.log(`[venue-catalog:load] ${result.rows.length} rows in ${(performance.now() - t0).toFixed(0)}ms`)
      }
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }, [debouncedSearch, debouncedCity, statusFilter, noCity, driftOnly, order, offset])

  useEffect(() => { load() }, [load])

  const handleFilterChange = (setter) => (val) => {
    setter(val)
    setOffset(0)
  }

  function handleSelectVenue(id) {
    setSelectedId(id)
    setEditMode(false)
    setSaveResult(null)
  }

  function handleSaved(result) {
    setSaveResult(result)
    setEditMode(false)
    // Reload list row + detail by toggling selectedId
    const id = selectedId
    setSelectedId(null)
    setTimeout(() => setSelectedId(id), 50)
    // Also refresh list to reflect canonical_name/city changes
    load()
  }

  const totalPages  = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="h-full flex overflow-hidden">

      {/* LEFT: list */}
      <div className="w-[420px] flex flex-col border-r border-gray-200 overflow-hidden flex-shrink-0 bg-white">

        {/* Header + filters */}
        <div className="px-3 py-2 border-b border-gray-200 flex-shrink-0 space-y-2">
          {/* Search */}
          <input
            type="text"
            placeholder="Buscar venue…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
          />

          {/* City + quick Córdoba */}
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="Filtrar ciudad…"
              value={city}
              onChange={e => handleFilterChange(setCity)(e.target.value)}
              className="flex-1 text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
            />
            <button
              onClick={() => { handleFilterChange(setCity)('Córdoba') }}
              className={[
                'text-[10px] px-2 py-1.5 rounded border shrink-0',
                city.toLowerCase() === 'córdoba' || city.toLowerCase() === 'cordoba'
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'border-gray-300 text-gray-600 hover:border-gray-400',
              ].join(' ')}
            >
              Córdoba
            </button>
            {city && (
              <button
                onClick={() => handleFilterChange(setCity)('')}
                className="text-[10px] px-2 py-1.5 rounded border border-gray-200 text-gray-400 hover:border-gray-400"
              >
                ✕
              </button>
            )}
          </div>

          {/* Toggles row */}
          <div className="flex gap-1 flex-wrap">
            {/* Status */}
            {['active', 'merged', 'all'].map(s => (
              <button
                key={s}
                onClick={() => handleFilterChange(setStatus)(s)}
                className={[
                  'text-[10px] px-2 py-0.5 rounded border',
                  statusFilter === s
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'border-gray-300 text-gray-500 hover:border-gray-400',
                ].join(' ')}
              >
                {s}
              </button>
            ))}

            <div className="h-3 w-px bg-gray-200 self-center mx-0.5" />

            <button
              onClick={() => { setNoCity(v => !v); setOffset(0) }}
              className={[
                'text-[10px] px-2 py-0.5 rounded border',
                noCity
                  ? 'bg-orange-500 text-white border-orange-500'
                  : 'border-gray-300 text-gray-500 hover:border-gray-400',
              ].join(' ')}
            >
              sin ciudad
            </button>

            <button
              onClick={() => { setDriftOnly(v => !v); setOffset(0) }}
              className={[
                'text-[10px] px-2 py-0.5 rounded border',
                driftOnly
                  ? 'bg-orange-500 text-white border-orange-500'
                  : 'border-gray-300 text-gray-500 hover:border-gray-400',
              ].join(' ')}
            >
              drift
            </button>
          </div>

          {/* Sort + Actor */}
          <div className="flex gap-1 items-center flex-wrap">
            <span className="text-[10px] text-gray-400">Orden:</span>
            {[['events', 'eventos ↓'], ['name', 'nombre A-Z'], ['city', 'ciudad']].map(([val, label]) => (
              <button
                key={val}
                onClick={() => { setOrder(val); setOffset(0) }}
                className={[
                  'text-[10px] px-2 py-0.5 rounded border',
                  order === val
                    ? 'bg-gray-700 text-white border-gray-700'
                    : 'border-gray-300 text-gray-500 hover:border-gray-400',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1">
              <span className="text-[10px] text-gray-400">Actor:</span>
              <select
                value={actor}
                onChange={e => handleActorChange(e.target.value)}
                className="text-[10px] border border-gray-300 rounded px-1 py-0.5 bg-white"
              >
                <option value="">—</option>
                {ACTORS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-3 flex-shrink-0">
          <span className="text-[10px] text-gray-500">{total} venues</span>
          {driftOnly && <span className="text-[10px] text-orange-600">filtrado por drift</span>}
          <span className="ml-auto text-[10px] text-gray-400">
            p.{currentPage}/{totalPages || 1}
            {totalPages > 1 && (
              <>
                <button
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="ml-2 px-1.5 py-0.5 border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-100"
                >←</button>
                <button
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= total}
                  className="ml-1 px-1.5 py-0.5 border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-100"
                >→</button>
              </>
            )}
          </span>
        </div>

        {/* Column headers */}
        <div className="px-4 py-1 border-b border-gray-200 flex gap-3 text-[10px] text-gray-400 flex-shrink-0">
          <span className="flex-1">venue</span>
          <span className="w-24 text-right">ciudad</span>
          <span className="w-10 text-right">evts</span>
          <span className="w-28 text-right">badges</span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-4 py-6 text-xs text-gray-400 text-center">Cargando…</div>
          )}
          {!loading && error && (
            <div className="px-4 py-6 text-xs text-red-600 text-center">Error: {error}</div>
          )}
          {!loading && !error && rows.length === 0 && (
            <div className="px-4 py-6 text-xs text-gray-400 text-center">Sin resultados.</div>
          )}
          {!loading && !error && rows.map(v => (
            <VenueRow
              key={v.id}
              venue={v}
              isSelected={selectedId === v.id}
              onClick={() => handleSelectVenue(v.id)}
            />
          ))}
        </div>
      </div>

      {/* RIGHT: detail or edit form */}
      <div className="flex-1 overflow-hidden bg-gray-50 flex flex-col">
        {editMode && selectedId ? (
          <EditPanel
            venueId={selectedId}
            actor={actor}
            onSaved={handleSaved}
            onCancel={() => { setEditMode(false); setSaveResult(null) }}
          />
        ) : (
          <>
            {saveResult && (
              <div className="px-4 py-2 bg-green-50 border-b border-green-200 text-[10px] text-green-700 flex-shrink-0">
                ✓ Guardado — {saveResult.changes} campo(s) modificado(s)
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              <VenueDetail
                venueId={selectedId}
                onNavigateTo={(id) => handleSelectVenue(id)}
                onEditRequest={() => { setSaveResult(null); setEditMode(true) }}
                actor={actor}
              />
            </div>
          </>
        )}
      </div>

    </div>
  )
}
