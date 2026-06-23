import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase.js'

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const ADMIN_EVENTS_URL = `${API_BASE}/api/admin/events`

const CATEGORIES = ['concert', 'festival', 'show', 'exhibit', 'sport']
const CURRENCIES = ['ARS', 'USD', 'EUR', 'BRL']
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

// ---------------------------------------------------------------------------
// VenuePicker
// ---------------------------------------------------------------------------

function VenuePicker({ value, onChange }) {
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState([])
  const [loading, setLoading]   = useState(false)
  const [open, setOpen]         = useState(false)
  const debounceRef             = useRef(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < 2) { setResults([]); return }

    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      const { data } = await supabase
        .from('venues')
        .select('id, canonical_name, city, region, lat, lng, fingerprint, address')
        .is('merged_into', null)
        .not('lat', 'is', null)
        .ilike('canonical_name', `%${q}%`)
        .order('canonical_name')
        .limit(10)
      setResults(data ?? [])
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
          <p className="text-gray-500">{value.city}{value.address ? ` · ${value.address}` : ''}</p>
          <p className="text-gray-400 font-mono">{value.lat?.toFixed(4)}, {value.lng?.toFixed(4)}</p>
        </div>
        <button
          onClick={clear}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0"
          title="Change venue"
        >
          ✕
        </button>
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
      {loading && (
        <span className="absolute right-2 top-1.5 text-[10px] text-gray-400">buscando…</span>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto">
          {results.map(v => (
            <button
              key={v.id}
              onClick={() => select(v)}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-100 last:border-0"
            >
              <p className="text-xs font-semibold text-gray-900">{v.canonical_name}</p>
              <p className="text-[10px] text-gray-500">{v.city}{v.address ? ` · ${v.address}` : ''}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// EventCreateForm
// ---------------------------------------------------------------------------

const EMPTY = {
  title:              '',
  category:           'concert',
  year:               '',
  month:              '',
  day:                '',
  start_time:         '',
  timezone:           'America/Argentina/Buenos_Aires',
  artist_name:        '',
  artist_profile_url: '',
  description:        '',
  image_url:          '',
  price_min:          '',
  currency:           'ARS',
  ticket_url:         '',
  created_by:         '',
}

export default function EventCreateForm({ onCreated }) {
  const [form, setForm]         = useState(EMPTY)
  const [venue, setVenue]       = useState(null)
  const [errors, setErrors]     = useState({})
  const [submitting, setSub]    = useState(false)
  const [result, setResult]     = useState(null)  // { ok, event } or { ok, error }

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }))
  }

  function validate() {
    const errs = {}
    if (!form.title.trim()) errs.title = 'Requerido'
    if (!venue)             errs.venue = 'Seleccioná un venue'
    if (!form.year || isNaN(parseInt(form.year)))   errs.year  = 'Año requerido'
    if (!form.month || isNaN(parseInt(form.month))) errs.month = 'Mes requerido'
    if (!form.day   || isNaN(parseInt(form.day)))   errs.day   = 'Día requerido'
    if (form.price_min && isNaN(parseFloat(form.price_min))) {
      errs.price_min = 'Número inválido'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!validate()) return
    setSub(true)
    setResult(null)

    try {
      const body = {
        title:              form.title.trim(),
        venue_id:           venue.id,
        year:               parseInt(form.year),
        month:              parseInt(form.month),
        day:                parseInt(form.day),
        start_time:         form.start_time  || undefined,
        timezone:           form.timezone    || undefined,
        artist_name:        form.artist_name.trim()        || undefined,
        artist_profile_url: form.artist_profile_url.trim() || undefined,
        description:        form.description.trim()        || undefined,
        image_url:          form.image_url.trim()          || undefined,
        price_min:          form.price_min ? parseFloat(form.price_min) : undefined,
        currency:           form.price_min ? form.currency : undefined,
        ticket_url:         form.ticket_url.trim()         || undefined,
        category:           form.category,
        created_by:         form.created_by.trim()         || undefined,
      }

      if (!ADMIN_EVENTS_URL.startsWith('http')) {
        setResult({ ok: false, error: 'VITE_API_BASE_URL no está configurada. Agregá la URL del Preview en workbench/.env.local y reiniciá el servidor.' })
        setSub(false)
        return
      }

      const res = await fetch(ADMIN_EVENTS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch {
        setResult({ ok: false, error: `HTTP ${res.status} — respuesta no-JSON del servidor. URL: ${ADMIN_EVENTS_URL}` })
        setSub(false)
        return
      }

      if (!res.ok || !json.ok) {
        setResult({ ok: false, error: json.error || `HTTP ${res.status}` })
      } else {
        setResult({ ok: true, event: json.event })
        if (onCreated) onCreated(json.event)
      }
    } catch (err) {
      setResult({ ok: false, error: err.message })
    } finally {
      setSub(false)
    }
  }

  function resetForm() {
    setForm(EMPTY)
    setVenue(null)
    setErrors({})
    setResult(null)
  }

  // ── Success state ──────────────────────────────────────────────────────────
  if (result?.ok) {
    const e = result.event
    const dateStr = `${e.year}-${String(e.month).padStart(2,'0')}-${String(e.day).padStart(2,'0')}`
    return (
      <div className="p-5 text-xs">
        <div className="rounded border border-green-300 bg-green-50 p-4 mb-4">
          <p className="font-bold text-green-800 mb-1">✓ Evento creado y publicado</p>
          <p className="text-green-700 font-mono mb-2">{e.id}</p>
          <div className="space-y-0.5 text-green-700">
            <p><strong>Título:</strong> {e.title}</p>
            <p><strong>Venue:</strong> {e.venue_name}</p>
            <p><strong>Fecha:</strong> {dateStr}{e.start_time ? ` ${e.start_time}` : ''}</p>
            <p><strong>Coords:</strong> {e.lat?.toFixed(4)}, {e.lng?.toFixed(4)}</p>
          </div>
        </div>
        <div className="space-y-1 text-gray-600 mb-4">
          <p>El evento aparecerá en el feed público en ≤5 min (TTL de caché).</p>
          <p>Para ver ahora: <code className="font-mono bg-gray-100 px-1">/api/events?provider=manual</code></p>
        </div>
        <button
          onClick={resetForm}
          className="text-xs px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Crear otro evento
        </button>
      </div>
    )
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <form onSubmit={handleSubmit} className="p-5 text-xs overflow-y-auto h-full">
      <h2 className="font-bold text-gray-900 text-sm mb-4">Crear evento manual</h2>

      {/* ── Identidad ── */}
      <Section title="Identidad">
        <Field label="Título *" error={errors.title}>
          <input
            type="text"
            value={form.title}
            onChange={e => set('title', e.target.value)}
            className={input(errors.title)}
            placeholder="Nombre del evento"
          />
        </Field>

        <Field label="Categoría" error={errors.category}>
          <select value={form.category} onChange={e => set('category', e.target.value)} className={input()}>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </Section>

      {/* ── Venue ── */}
      <Section title="Venue *">
        {errors.venue && <p className="text-red-500 text-[10px] mb-1">{errors.venue}</p>}
        <VenuePicker value={venue} onChange={setVenue} />
        <p className="text-[10px] text-gray-400 mt-1">
          Solo venues activos con coordenadas. Las coords del venue se copian al evento.
          Futuras ediciones de coords del venue se propagarán automáticamente vía trigger.
        </p>
      </Section>

      {/* ── Fecha y hora ── */}
      <Section title="Fecha y hora">
        <div className="grid grid-cols-3 gap-2 mb-2">
          <Field label="Año *" error={errors.year}>
            <input type="number" value={form.year} onChange={e => set('year', e.target.value)}
              className={input(errors.year)} placeholder="2026" min="2024" max="2030" />
          </Field>
          <Field label="Mes *" error={errors.month}>
            <input type="number" value={form.month} onChange={e => set('month', e.target.value)}
              className={input(errors.month)} placeholder="7" min="1" max="12" />
          </Field>
          <Field label="Día *" error={errors.day}>
            <input type="number" value={form.day} onChange={e => set('day', e.target.value)}
              className={input(errors.day)} placeholder="15" min="1" max="31" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Hora de inicio (HH:MM)">
            <input type="time" value={form.start_time} onChange={e => set('start_time', e.target.value)}
              className={input()} />
          </Field>
          <Field label="Timezone">
            <select value={form.timezone} onChange={e => set('timezone', e.target.value)} className={input()}>
              {AR_TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      {/* ── Artista ── */}
      <Section title="Artista / banda">
        <Field label="Nombre del artista o banda">
          <input type="text" value={form.artist_name} onChange={e => set('artist_name', e.target.value)}
            className={input()} placeholder="Coldplay" />
        </Field>
        <Field label="URL perfil artista">
          <input type="url" value={form.artist_profile_url}
            onChange={e => set('artist_profile_url', e.target.value)}
            className={input()} placeholder="https://..." />
        </Field>
      </Section>

      {/* ── Contenido ── */}
      <Section title="Contenido (opcional)">
        <Field label="Descripción">
          <textarea value={form.description} onChange={e => set('description', e.target.value)}
            className={input()} rows={3} placeholder="Descripción del evento…" />
        </Field>
        <Field label="URL imagen (externa)">
          <input type="url" value={form.image_url} onChange={e => set('image_url', e.target.value)}
            className={input()} placeholder="https://..." />
        </Field>
        {form.image_url && (
          <img src={form.image_url} alt="preview" className="mt-1 h-16 object-cover rounded border border-gray-200"
            onError={e => { e.target.style.display = 'none' }} />
        )}
      </Section>

      {/* ── Tickets ── */}
      <Section title="Tickets (opcional)">
        <div className="grid grid-cols-3 gap-2 mb-2">
          <Field label="Precio mín" error={errors.price_min}>
            <input type="number" value={form.price_min} onChange={e => set('price_min', e.target.value)}
              className={input(errors.price_min)} placeholder="0" min="0" step="any" />
          </Field>
          <Field label="Moneda">
            <select value={form.currency} onChange={e => set('currency', e.target.value)} className={input()}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="URL tickets">
          <input type="url" value={form.ticket_url} onChange={e => set('ticket_url', e.target.value)}
            className={input()} placeholder="https://..." />
        </Field>
      </Section>

      {/* ── Operador ── */}
      <Section title="Operador">
        <Field label="Tu nombre (para auditoría)">
          <input type="text" value={form.created_by} onChange={e => set('created_by', e.target.value)}
            className={input()} placeholder="Fabio" />
        </Field>
      </Section>

      {/* ── Error ── */}
      {result?.error && (
        <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded text-[10px] text-red-700">
          {result.error}
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex gap-2 pt-2 border-t border-gray-100 mt-2">
        <button
          type="submit"
          disabled={submitting}
          className="text-xs px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
        >
          {submitting ? 'Creando…' : 'Crear y publicar'}
        </button>
        <button
          type="button"
          onClick={resetForm}
          disabled={submitting}
          className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:border-gray-400 disabled:opacity-40"
        >
          Limpiar
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Section({ title, children }) {
  return (
    <div className="mb-5">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 border-b border-gray-100 pb-1">
        {title}
      </p>
      {children}
    </div>
  )
}

function Field({ label, error, children }) {
  return (
    <div className="mb-2.5">
      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-0.5">
        {label}
      </label>
      {children}
      {error && <p className="text-[10px] text-red-500 mt-0.5">{error}</p>}
    </div>
  )
}

function input(error) {
  return [
    'w-full text-xs border rounded px-2 py-1.5 focus:outline-none font-mono',
    error ? 'border-red-400 bg-red-50' : 'border-gray-300 focus:border-blue-400',
  ].join(' ')
}
