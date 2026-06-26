import { useState, useEffect, useRef } from 'react'
import { authClient } from './LoginForm.jsx'

// No supabase import — all privileged operations go through /api/admin/*

const CATEGORIES  = ['concert', 'festival', 'show', 'exhibit', 'sport']
const CURRENCIES  = ['ARS', 'USD', 'EUR', 'BRL']
const AR_TIMEZONES = [
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Cordoba',
  'America/Argentina/Salta',
  'America/Argentina/Mendoza',
  'America/Argentina/San_Juan',
  'America/Argentina/Tucuman',
  'America/Argentina/Jujuy',
  'America/Argentina/La_Rioja',
  'America/Argentina/San_Luis',
  'America/Argentina/Rio_Gallegos',
  'America/Argentina/Ushuaia',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Montevideo',
  'America/Asuncion',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/Madrid',
  'UTC',
]

// ─── API client ──────────────────────────────────────────────────────────────

async function adminFetch(path, options = {}) {
  const { data: { session } } = await authClient.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('No session — please sign in again')

  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  })
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  return { status: res.status, ...json }
}

// ─── VenuePicker ─────────────────────────────────────────────────────────────

function VenuePicker({ value, onChange }) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen]       = useState(false)
  const debounceRef           = useRef(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < 2) { setResults([]); return }

    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await adminFetch(`/venues/search?q=${encodeURIComponent(q)}&limit=10`)
        setResults(data.venues ?? [])
      } catch {
        setResults([])
      }
      setLoading(false)
    }, 250)
  }, [query])

  function select(venue) {
    onChange(venue)
    setOpen(false)
    setQuery('')
    setResults([])
  }

  function clear() {
    onChange(null)
    setQuery('')
  }

  if (value) {
    return (
      <div className="flex items-start gap-2 p-2.5 border border-green-300 bg-green-50 rounded text-xs">
        <div className="flex-1">
          <p className="font-semibold text-gray-900">{value.canonical_name}</p>
          <p className="text-gray-500">{value.city}</p>
          <p className="text-gray-400 font-mono">{value.lat?.toFixed(4)}, {value.lng?.toFixed(4)}</p>
        </div>
        <button onClick={clear} className="text-gray-400 hover:text-gray-600 flex-shrink-0" title="Change venue">✕</button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder="Buscar venue por nombre…"
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:border-blue-400"
      />
      {loading && <span className="absolute right-2 top-1.5 text-[10px] text-gray-400">buscando…</span>}
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto">
          {results.map(v => (
            <button key={v.id} onClick={() => select(v)}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-100 last:border-0">
              <p className="text-xs font-semibold text-gray-900">{v.canonical_name}</p>
              <p className="text-[10px] text-gray-500">{v.city}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── EventList ───────────────────────────────────────────────────────────────

function statusBadge(status) {
  if (status === 'draft')     return 'bg-yellow-100 text-yellow-800'
  if (status === 'published') return 'bg-green-100 text-green-800'
  if (status === 'cancelled') return 'bg-gray-100 text-gray-500'
  return 'bg-gray-100 text-gray-500'
}

function EventList({ onSelect, refreshKey }) {
  const [events, setEvents]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  useEffect(() => {
    setLoading(true)
    adminFetch('/events')
      .then(d => { setEvents(d.events ?? []); setError(null) })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [refreshKey])

  if (loading) return <p className="text-xs text-gray-400 p-4">Cargando eventos…</p>
  if (error)   return <p className="text-xs text-red-500 p-4">{error}</p>
  if (!events.length) return <p className="text-xs text-gray-400 p-4">No hay eventos manuales.</p>

  return (
    <div className="divide-y divide-gray-100">
      {events.map(e => (
        <button key={e.id} onClick={() => onSelect(e)}
          className="w-full text-left px-4 py-2.5 hover:bg-gray-50 text-xs">
          <div className="flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusBadge(e.status)}`}>
              {e.status ?? 'published'}
            </span>
            <span className="font-semibold text-gray-900 truncate">{e.title}</span>
          </div>
          <div className="text-gray-400 mt-0.5">
            {e.year}-{String(e.month).padStart(2,'0')}-{String(e.day).padStart(2,'0')}
            {e.venue_name ? ` · ${e.venue_name}` : ''}
          </div>
        </button>
      ))}
    </div>
  )
}

// ─── EventDetail ─────────────────────────────────────────────────────────────

function EventDetail({ eventSummary, onBack, onRefresh }) {
  const [event, setEvent]           = useState(null)
  const [audit, setAudit]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [editing, setEditing]       = useState(false)
  const [editFields, setEditFields] = useState({})
  const [cancelReason, setCancelReason] = useState('')
  const [busy, setBusy]             = useState(false)
  const [msg, setMsg]               = useState(null)

  useEffect(() => {
    Promise.all([
      adminFetch(`/${eventSummary.id}`),
      adminFetch(`/${eventSummary.id}/audit`),
    ]).then(([ed, ad]) => {
      setEvent(ed.event ?? null)
      setAudit(ad.entries ?? [])
    }).finally(() => setLoading(false))
  }, [eventSummary.id])

  async function doPublish() {
    setBusy(true); setMsg(null)
    const r = await adminFetch(`/${event.id}/publish`, { method: 'POST' })
    if (r.ok) { setEvent(r.event); setAudit(a => [...a, { action_type: 'event_published', actor: 'you', created_at: new Date().toISOString() }]); setMsg('Publicado.') }
    else setMsg(`Error: ${r.error}`)
    setBusy(false); onRefresh()
  }

  async function doCancel() {
    if (!cancelReason.trim()) { setMsg('Motivo de cancelación requerido'); return }
    setBusy(true); setMsg(null)
    const r = await adminFetch(`/${event.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: cancelReason }) })
    if (r.ok) { setEvent(r.event); setCancelReason(''); setMsg('Cancelado.') }
    else setMsg(`Error: ${r.error}`)
    setBusy(false); onRefresh()
  }

  async function doUpdate() {
    if (Object.keys(editFields).length === 0) { setEditing(false); return }
    setBusy(true); setMsg(null)
    const r = await adminFetch(`/${event.id}`, { method: 'PATCH', body: JSON.stringify(editFields) })
    if (r.ok) { setEvent(r.event); setEditing(false); setEditFields({}); setMsg('Actualizado.') }
    else setMsg(`Error: ${r.error}`)
    setBusy(false); onRefresh()
  }

  if (loading) return <div className="p-4 text-xs text-gray-400">Cargando…</div>
  if (!event)  return <div className="p-4 text-xs text-red-500">Evento no encontrado</div>

  const dateStr = `${event.year}-${String(event.month).padStart(2,'0')}-${String(event.day).padStart(2,'0')}`

  return (
    <div className="p-4 text-xs overflow-y-auto">
      <button onClick={onBack} className="text-blue-500 hover:text-blue-700 mb-3 text-[11px]">← Volver</button>

      <div className="flex items-center gap-2 mb-3">
        <span className={`px-2 py-0.5 rounded font-semibold text-[10px] ${statusBadge(event.status)}`}>{event.status}</span>
        <h2 className="font-bold text-gray-900">{event.title}</h2>
      </div>

      <div className="grid grid-cols-2 gap-1 text-[11px] text-gray-600 mb-4">
        <span><strong>ID:</strong> <span className="font-mono">{event.id}</span></span>
        <span><strong>Venue:</strong> {event.venue_name}</span>
        <span><strong>Fecha:</strong> {dateStr}{event.start_time ? ` ${event.start_time}` : ''}</span>
        <span><strong>Ciudad:</strong> {event.city}</span>
        <span><strong>Coords:</strong> {event.lat?.toFixed(4)}, {event.lng?.toFixed(4)}</span>
        <span><strong>Creado por:</strong> {event.created_by}</span>
        {event.published_by && <span><strong>Publicado por:</strong> {event.published_by}</span>}
        {event.cancelled_by && <span><strong>Cancelado por:</strong> {event.cancelled_by}</span>}
      </div>

      {msg && <p className="mb-3 text-[11px] text-blue-700 bg-blue-50 px-2 py-1 rounded">{msg}</p>}

      {/* Actions */}
      <div className="flex flex-col gap-2 mb-4">
        {event.status === 'draft' && (
          <>
            <button onClick={doPublish} disabled={busy}
              className="px-3 py-1.5 bg-green-600 text-white rounded text-xs hover:bg-green-700 disabled:opacity-40 w-fit">
              {busy ? 'Publicando…' : 'Publicar'}
            </button>
            <button onClick={() => setEditing(v => !v)} disabled={busy}
              className="px-3 py-1.5 border border-gray-300 rounded text-xs hover:border-gray-400 w-fit">
              {editing ? 'Cancelar edición' : 'Editar borrador'}
            </button>
          </>
        )}
        {event.status === 'published' && (
          <div className="flex flex-col gap-1">
            <input
              type="text"
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="Motivo de cancelación (requerido)"
              className="border border-gray-300 rounded px-2 py-1 text-xs w-full"
            />
            <button onClick={doCancel} disabled={busy || !cancelReason.trim()}
              className="px-3 py-1.5 bg-red-600 text-white rounded text-xs hover:bg-red-700 disabled:opacity-40 w-fit">
              {busy ? 'Cancelando…' : 'Cancelar evento'}
            </button>
          </div>
        )}
      </div>

      {/* Inline edit form for drafts */}
      {editing && event.status === 'draft' && (
        <div className="mb-4 border border-yellow-200 bg-yellow-50 rounded p-3">
          <p className="text-[10px] font-semibold text-yellow-700 uppercase mb-2">Editar campos</p>
          {[
            ['Título', 'title', 'text'],
            ['Artista', 'artist_name', 'text'],
            ['Descripción', 'description', 'text'],
            ['Precio mín', 'price_min', 'number'],
            ['URL imagen', 'image_url', 'url'],
            ['URL tickets', 'ticket_url', 'url'],
          ].map(([label, key, type]) => (
            <div key={key} className="mb-2">
              <label className="block text-[10px] text-gray-500 mb-0.5">{label}</label>
              <input type={type}
                defaultValue={event[key] ?? ''}
                onChange={e => setEditFields(f => ({ ...f, [key]: type === 'number' ? parseFloat(e.target.value) || undefined : e.target.value || undefined }))}
                className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
            </div>
          ))}
          <button onClick={doUpdate} disabled={busy}
            className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-40">
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      )}

      {/* Audit trail */}
      {audit.length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] font-semibold text-gray-400 uppercase mb-2">Historial de auditoría</p>
          <div className="space-y-1">
            {audit.map((a, i) => (
              <div key={i} className="text-[10px] text-gray-600 border-l-2 border-gray-200 pl-2">
                <span className="font-semibold">{a.action_type}</span>
                {' · '}{a.actor}
                {' · '}{a.created_at ? new Date(a.created_at).toLocaleString() : ''}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CreateForm ───────────────────────────────────────────────────────────────

const EMPTY = {
  title: '', category: 'concert',
  year: '', month: '', day: '',
  start_time: '', timezone: 'America/Argentina/Buenos_Aires',
  artist_name: '', artist_profile_url: '',
  description: '', image_url: '',
  price_min: '', currency: 'ARS', ticket_url: '',
}

function CreateForm({ onCreated }) {
  const [form, setForm]     = useState(EMPTY)
  const [venue, setVenue]   = useState(null)
  const [errors, setErrors] = useState({})
  const [busy, setBusy]     = useState(false)
  const [msg, setMsg]       = useState(null)

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }))
  }

  function validate() {
    const errs = {}
    if (!form.title.trim()) errs.title = 'Requerido'
    if (!venue)             errs.venue = 'Seleccioná un venue'
    if (!form.year  || isNaN(+form.year))  errs.year  = 'Requerido'
    if (!form.month || isNaN(+form.month)) errs.month = 'Requerido'
    if (!form.day   || isNaN(+form.day))   errs.day   = 'Requerido'
    if (form.price_min && isNaN(parseFloat(form.price_min))) errs.price_min = 'Número inválido'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleSubmit(e, andPublish = false) {
    e.preventDefault()
    if (!validate()) return
    setBusy(true); setMsg(null)

    const body = {
      title:              form.title.trim(),
      venue_id:           venue.id,
      year:               parseInt(form.year),
      month:              parseInt(form.month),
      day:                parseInt(form.day),
      category:           form.category,
      ...(form.start_time         && { start_time:         form.start_time }),
      ...(form.timezone           && { timezone:           form.timezone }),
      ...(form.artist_name.trim() && { artist_name:        form.artist_name.trim() }),
      ...(form.artist_profile_url.trim() && { artist_profile_url: form.artist_profile_url.trim() }),
      ...(form.description.trim() && { description:        form.description.trim() }),
      ...(form.image_url.trim()   && { image_url:          form.image_url.trim() }),
      ...(form.price_min          && { price_min:          parseFloat(form.price_min), currency: form.currency }),
      ...(form.ticket_url.trim()  && { ticket_url:         form.ticket_url.trim() }),
    }

    const r = await adminFetch('/events', { method: 'POST', body: JSON.stringify(body) })
    if (!r.ok) { setBusy(false); setMsg(`Error: ${r.error}`); return }

    if (andPublish) {
      const p = await adminFetch(`/${r.event.id}/publish`, { method: 'POST' })
      setBusy(false)
      if (p.ok) { onCreated(p.event) }
      else      { setMsg(`Borrador creado pero no se pudo publicar: ${p.error}`); onCreated(r.event) }
    } else {
      setBusy(false)
      onCreated(r.event)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="p-5 text-xs">
      <h2 className="font-bold text-gray-900 text-sm mb-4">Crear borrador</h2>

      <Section title="Identidad">
        <Field label="Título *" error={errors.title}>
          <input type="text" value={form.title} onChange={e => set('title', e.target.value)}
            className={inp(errors.title)} placeholder="Nombre del evento" />
        </Field>
        <Field label="Categoría">
          <select value={form.category} onChange={e => set('category', e.target.value)} className={inp()}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </Field>
      </Section>

      <Section title="Venue *">
        {errors.venue && <p className="text-red-500 text-[10px] mb-1">{errors.venue}</p>}
        <VenuePicker value={venue} onChange={setVenue} />
      </Section>

      <Section title="Fecha y hora">
        <div className="grid grid-cols-3 gap-2 mb-2">
          <Field label="Día *" error={errors.day}>
            <input type="number" value={form.day} onChange={e => set('day', e.target.value)}
              className={inp(errors.day)} placeholder="15" />
          </Field>
          <Field label="Mes *" error={errors.month}>
            <input type="number" value={form.month} onChange={e => set('month', e.target.value)}
              className={inp(errors.month)} placeholder="7" />
          </Field>
          <Field label="Año *" error={errors.year}>
            <input type="number" value={form.year} onChange={e => set('year', e.target.value)}
              className={inp(errors.year)} placeholder="2026" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Hora (HH:MM)">
            <input type="time" value={form.start_time}
              onChange={e => set('start_time', e.target.value)}
              onBlur={e => {
                const v = e.target.value
                if (v && !v.includes(':')) set('start_time', v.padStart(2,'0') + ':00')
                else if (v && v.endsWith(':')) set('start_time', v + '00')
              }}
              className={inp()} />
          </Field>
          <Field label="Timezone">
            <select value={form.timezone} onChange={e => set('timezone', e.target.value)} className={inp()}>
              {AR_TIMEZONES.map(tz => <option key={tz}>{tz}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Artista">
        <Field label="Nombre">
          <input type="text" value={form.artist_name} onChange={e => set('artist_name', e.target.value)}
            className={inp()} placeholder="Coldplay" />
        </Field>
        <Field label="URL perfil">
          <input type="url" value={form.artist_profile_url}
            onChange={e => set('artist_profile_url', e.target.value)} className={inp()} placeholder="https://…" />
        </Field>
      </Section>

      <Section title="Contenido">
        <Field label="Descripción">
          <textarea value={form.description} onChange={e => set('description', e.target.value)}
            className={inp()} rows={2} />
        </Field>
        <Field label="URL imagen">
          <input type="url" value={form.image_url} onChange={e => set('image_url', e.target.value)}
            className={inp()} placeholder="https://…" />
        </Field>
      </Section>

      <Section title="Tickets">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Precio mín" error={errors.price_min}>
            <input type="number" value={form.price_min} onChange={e => set('price_min', e.target.value)}
              className={inp(errors.price_min)} />
          </Field>
          <Field label="Moneda">
            <select value={form.currency} onChange={e => set('currency', e.target.value)} className={inp()}>
              {CURRENCIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="URL tickets">
          <input type="url" value={form.ticket_url} onChange={e => set('ticket_url', e.target.value)}
            className={inp()} placeholder="https://…" />
        </Field>
      </Section>

      {msg && <p className="mb-3 text-[11px] text-red-600 bg-red-50 px-2 py-1 rounded">{msg}</p>}

      <div className="flex gap-2 pt-2 border-t border-gray-100">
        <button type="submit" disabled={busy}
          className="px-4 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-40">
          {busy ? 'Creando…' : 'Crear borrador'}
        </button>
        <button type="button" disabled={busy} onClick={e => handleSubmit(e, true)}
          className="px-4 py-1.5 bg-green-600 text-white rounded text-xs hover:bg-green-700 disabled:opacity-40">
          {busy ? 'Publicando…' : 'Crear y publicar'}
        </button>
      </div>
    </form>
  )
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function EventCreateForm() {
  const [view, setView]           = useState('list')   // 'list' | 'create' | 'detail'
  const [selectedEvent, setSelected] = useState(null)
  const [refreshKey, setRefreshKey]  = useState(0)

  function refresh() { setRefreshKey(k => k + 1) }

  if (view === 'create') {
    return (
      <div className="h-full overflow-y-auto">
        <div className="px-4 pt-4">
          <button onClick={() => setView('list')} className="text-blue-500 hover:text-blue-700 text-[11px]">← Volver a lista</button>
        </div>
        <CreateForm onCreated={event => { refresh(); setSelected(event); setView('detail') }} />
      </div>
    )
  }

  if (view === 'detail' && selectedEvent) {
    return (
      <div className="h-full overflow-y-auto">
        <EventDetail
          eventSummary={selectedEvent}
          onBack={() => setView('list')}
          onRefresh={refresh}
        />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
        <span className="text-xs font-semibold text-gray-900">Eventos manuales</span>
        <button onClick={() => setView('create')}
          className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700">
          + Nuevo borrador
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <EventList
          refreshKey={refreshKey}
          onSelect={e => { setSelected(e); setView('detail') }}
        />
      </div>
    </div>
  )
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 border-b border-gray-100 pb-1">{title}</p>
      {children}
    </div>
  )
}

function Field({ label, error, children }) {
  return (
    <div className="mb-2">
      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">{label}</label>
      {children}
      {error && <p className="text-[10px] text-red-500 mt-0.5">{error}</p>}
    </div>
  )
}

function inp(error) {
  return [
    'w-full text-xs border rounded px-2 py-1.5 focus:outline-none',
    error ? 'border-red-400 bg-red-50' : 'border-gray-300 focus:border-blue-400',
  ].join(' ')
}
