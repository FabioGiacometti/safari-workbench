import { useState, useEffect } from 'react'
import { authClient } from './LoginForm.jsx'

async function adminFetch(path, options = {}) {
  const { data: { session } } = await authClient.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('No session — please sign in again')
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  })
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  return { status: res.status, ...json }
}

// Fields the pipeline may write — these get added to manually_edited_fields when edited.
const PIPELINE_WRITABLE = new Set([
  'canonical_name', 'aliases', 'city', 'region', 'lat', 'lng',
])

// Editorial-only fields — pipeline never writes these, but still log edits.
const EDITORIAL_FIELDS = new Set([
  'address', 'image_url', 'description', 'social_links', 'category',
  'capacity', 'accessibility',
])

const ALL_EDITABLE = [
  ...PIPELINE_WRITABLE,
  ...EDITORIAL_FIELDS,
]

// Fields the form must NOT expose
const READ_ONLY_FIELDS = new Set([
  'fingerprint', 'event_count', 'geo_confidence', 'resolution_confidence',
  'merged_into', 'created_at', 'updated_at', 'id', 'merged_at', 'merged_by',
  'manually_edited_fields', 'display_name', 'provider_count', 'first_seen_at',
  'last_seen_at', 'geo_entity_id', 'canonical_city_id', 'coords',
])

// JSON fields that need special handling
const JSON_FIELDS = new Set(['social_links'])
// Array fields
const ARRAY_FIELDS = new Set(['aliases'])
// Numeric fields
const NUMERIC_FIELDS = new Set(['lat', 'lng', 'capacity'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFieldValue(field, raw) {
  if (raw === '' || raw === null || raw === undefined) return null
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(raw)
    return isNaN(n) ? raw : n
  }
  if (JSON_FIELDS.has(field)) {
    try { return JSON.parse(raw) }
    catch { return raw } // keep raw string so validation catches it
  }
  if (ARRAY_FIELDS.has(field)) {
    if (Array.isArray(raw)) return raw
    // Parse comma-separated string
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }
  return raw
}

function displayFieldValue(field, value) {
  if (value === null || value === undefined) return ''
  if (ARRAY_FIELDS.has(field)) {
    return Array.isArray(value) ? value.join(', ') : String(value)
  }
  if (JSON_FIELDS.has(field)) {
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  }
  return String(value)
}

function normalizeAliases(raw, canonicalName) {
  if (!raw) return []
  const arr = Array.isArray(raw)
    ? raw
    : raw.split(',').map(s => s.trim()).filter(Boolean)
  // Dedup and remove canonical_name if identical
  const seen = new Set()
  const result = []
  for (const a of arr) {
    const normalized = a.replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    if (normalized === canonicalName) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function valuesEqual(field, a, b) {
  let na = a === '' ? null : a
  let nb = b === '' ? null : b
  // Treat empty array same as null (no aliases = same as null aliases)
  if (ARRAY_FIELDS.has(field)) {
    if (Array.isArray(na) && na.length === 0) na = null
    if (Array.isArray(nb) && nb.length === 0) nb = null
  }
  if (na === null && nb === null) return true
  if (na === null || nb === null) return false
  if (ARRAY_FIELDS.has(field)) {
    const aa = Array.isArray(na) ? na : [na]
    const bb = Array.isArray(nb) ? nb : [nb]
    return aa.length === bb.length && aa.every((v, i) => v === bb[i])
  }
  if (NUMERIC_FIELDS.has(field)) {
    return Number(na) === Number(nb)
  }
  return String(na) === String(nb)
}

function validateField(field, value) {
  if (JSON_FIELDS.has(field) && value !== null && value !== '') {
    try {
      if (typeof value === 'string') JSON.parse(value)
    } catch {
      return `${field} debe ser JSON válido`
    }
  }
  if (field === 'lat' && value !== null && value !== '') {
    const n = Number(value)
    if (isNaN(n) || n < -90 || n > 90) return 'lat debe ser un número entre -90 y 90'
  }
  if (field === 'lng' && value !== null && value !== '') {
    const n = Number(value)
    if (isNaN(n) || n < -180 || n > 180) return 'lng debe ser un número entre -180 y 180'
  }
  if (field === 'capacity' && value !== null && value !== '') {
    const n = Number(value)
    if (isNaN(n) || n < 0 || !Number.isInteger(n)) return 'capacity debe ser un entero positivo'
  }
  return null
}

// ---------------------------------------------------------------------------
// saveVenueEdits — persists diff + logs
// ---------------------------------------------------------------------------

export async function saveVenueEdits(venue, formValues) {
  // Build the fields diff (only changed values). The server-side edit_venue RPC
  // performs the authoritative validation, normalization, audit log, and
  // manually_edited_fields bookkeeping atomically.
  const fields = {}
  for (const field of ALL_EDITABLE) {
    const incoming = parseFieldValue(field, formValues[field])
    const existing = venue[field] ?? null
    let normalizedIncoming = incoming
    if (field === 'aliases') {
      normalizedIncoming = normalizeAliases(incoming, venue.canonical_name)
    }
    if (!valuesEqual(field, existing, normalizedIncoming)) {
      fields[field] = normalizedIncoming
    }
  }

  if (Object.keys(fields).length === 0) return { ok: true, changes: 0 }

  const result = await adminFetch(`/venues/${venue.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  })
  if (!result.ok) throw new Error(result.error ?? result.message ?? 'Save failed')
  return { ok: true, changes: result.changes, diff: result.diff, venue: result.venue }
}

// ---------------------------------------------------------------------------
// Field input components
// ---------------------------------------------------------------------------

// Parses "lat, lng" from a Google Maps copy-paste like "-31.444490, -64.195631"
function parseLatLng(text) {
  const m = text.trim().match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/)
  if (!m) return null
  const lat = parseFloat(m[1]), lng = parseFloat(m[2])
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

function FieldInput({ field, value, onChange, onLatLngPaste, error }) {
  const isTextarea = ['description', 'social_links', 'accessibility'].includes(field)
  const isArray    = ARRAY_FIELDS.has(field)
  const isNumeric  = NUMERIC_FIELDS.has(field)

  const cls = [
    'w-full text-xs border rounded px-2 py-1.5 focus:outline-none font-mono',
    error ? 'border-red-400 bg-red-50' : 'border-gray-300 focus:border-blue-400',
  ].join(' ')

  function handlePaste(e) {
    if (field !== 'lat' || !onLatLngPaste) return
    const text = e.clipboardData.getData('text')
    const parsed = parseLatLng(text)
    if (!parsed) return
    e.preventDefault()
    onLatLngPaste(parsed.lat, parsed.lng)
  }

  if (isTextarea) {
    return (
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={field === 'description' ? 4 : 3}
        className={cls}
        placeholder={field === 'social_links' ? '{"instagram":"..."}' : ''}
      />
    )
  }

  return (
    <input
      type={isNumeric ? 'number' : 'text'}
      value={value}
      onChange={e => onChange(e.target.value)}
      onPaste={field === 'lat' ? handlePaste : undefined}
      step={isNumeric && !['capacity'].includes(field) ? 'any' : undefined}
      className={cls}
      placeholder={field === 'lat' ? 'lat  o pegar "-31.44, -64.19"' : isArray ? 'alias1, alias2, alias3' : undefined}
    />
  )
}

function FieldRow({ field, formValue, originalValue, onChange, onLatLngPaste, error }) {
  const changed = !valuesEqual(field, originalValue, parseFieldValue(field, formValue))
  const isPipelineWritable = PIPELINE_WRITABLE.has(field)

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-0.5">
        <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
          {field}
        </label>
        {field === 'lat' && (
          <span className="text-[10px] text-gray-400">· pegá "lat, lng" para llenar ambos</span>
        )}
        {changed && (
          <span className="text-[10px] px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">
            modificado
          </span>
        )}
        {changed && isPipelineWritable && (
          <span className="text-[10px] px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded"
                title="Este campo quedará protegido del pipeline al guardar">
            → protegido
          </span>
        )}
      </div>
      <FieldInput field={field} value={formValue} onChange={onChange} onLatLngPaste={onLatLngPaste} error={error} />
      {error && <p className="text-[10px] text-red-500 mt-0.5">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ChangeSummary — preview antes de guardar
// ---------------------------------------------------------------------------

function ChangeSummary({ venue, formValues }) {
  const changes = []
  for (const field of ALL_EDITABLE) {
    const incoming = field === 'aliases'
      ? normalizeAliases(formValues[field], venue.canonical_name)
      : parseFieldValue(field, formValues[field])
    const existing = venue[field] ?? null
    if (!valuesEqual(field, existing, incoming)) {
      changes.push({ field, from: existing, to: incoming })
    }
  }
  if (changes.length === 0) return null

  return (
    <div className="mb-4 border border-yellow-200 bg-yellow-50 rounded p-3">
      <p className="text-[10px] font-semibold text-yellow-700 mb-2">
        Cambios a guardar ({changes.length}):
      </p>
      <div className="space-y-1">
        {changes.map(({ field, from, to }) => (
          <div key={field} className="text-[10px]">
            <span className="font-semibold text-gray-700">{field}:</span>{' '}
            <span className="text-red-500 line-through font-mono">
              {from === null ? 'null' : JSON.stringify(from)}
            </span>
            {' → '}
            <span className="text-green-700 font-mono">
              {to === null ? 'null' : JSON.stringify(to)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// VenueEditForm — main component
// ---------------------------------------------------------------------------

export default function VenueEditForm({ venue, onSaved, onCancel }) {
  const [formValues, setFormValues] = useState({})
  const [errors, setErrors]         = useState({})
  const [saving, setSaving]         = useState(false)
  const [saveError, setSaveError]   = useState(null)
  const [showPreview, setShowPreview] = useState(false)

  // Initialize form from current venue values
  useEffect(() => {
    if (!venue) return
    const initial = {}
    for (const field of ALL_EDITABLE) {
      initial[field] = displayFieldValue(field, venue[field])
    }
    setFormValues(initial)
    setErrors({})
    setSaveError(null)
    setShowPreview(false)
  }, [venue?.id])

  if (!venue) return null

  // Venue merged — block edits, offer navigation
  if (venue.merged_into) {
    return (
      <div className="p-5">
        <div className="rounded border border-orange-200 bg-orange-50 p-4 mb-4">
          <p className="text-xs font-semibold text-orange-700 mb-1">
            Este venue fue absorbido por otro.
          </p>
          <p className="text-[10px] text-orange-600">
            No se puede editar directamente. Navegá al venue ganador para editarlo.
          </p>
        </div>
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:border-gray-400"
        >
          Volver
        </button>
      </div>
    )
  }

  function setField(field, value) {
    setFormValues(prev => ({ ...prev, [field]: value }))
    // Clear error on change
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }))
    setShowPreview(false)
  }

  function validate() {
    const errs = {}
    for (const field of ALL_EDITABLE) {
      const parsed = parseFieldValue(field, formValues[field])
      const err = validateField(field, parsed)
      if (err) errs[field] = err
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleSave() {
    if (!validate()) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await saveVenueEdits(venue, formValues)
      onSaved(result)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const FIELD_GROUPS = [
    {
      label: 'Identidad',
      fields: ['canonical_name', 'aliases', 'address', 'image_url'],
    },
    {
      label: 'Ubicación',
      fields: ['city', 'region', 'lat', 'lng'],
    },
    {
      label: 'Editorial',
      fields: ['description', 'category', 'capacity', 'accessibility', 'social_links'],
    },
  ]

  return (
    <div className="p-5 text-xs overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-gray-900 text-sm">Editar venue</h2>
      </div>

      <div className="mb-4 px-3 py-2 bg-gray-50 rounded border border-gray-200">
        <p className="text-[10px] text-gray-500">
          <span className="font-mono text-gray-700">{venue.fingerprint}</span>
          {' · '}
          <span className="text-gray-500">id: {venue.id.slice(0, 8)}…</span>
        </p>
      </div>

      {FIELD_GROUPS.map(group => (
        <div key={group.label} className="mb-5">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 border-b border-gray-100 pb-1">
            {group.label}
          </p>
          {group.fields.map(field => (
            <FieldRow
              key={field}
              field={field}
              formValue={formValues[field] ?? ''}
              originalValue={venue[field] ?? null}
              onChange={v => setField(field, v)}
              onLatLngPaste={(lat, lng) => {
                setField('lat', String(lat))
                setField('lng', String(lng))
              }}
              error={errors[field]}
            />
          ))}
        </div>
      ))}

      {showPreview && (
        <ChangeSummary venue={venue} formValues={formValues} />
      )}

      {saveError && (
        <div className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded text-[10px] text-red-700">
          {saveError}
        </div>
      )}

      <div className="flex gap-2 pt-2 border-t border-gray-100">
        <button
          onClick={() => { if (validate()) setShowPreview(true) }}
          disabled={saving}
          className="text-[10px] px-3 py-1.5 border border-gray-300 rounded hover:border-gray-400 disabled:opacity-40"
        >
          Vista previa
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-[10px] px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="text-[10px] px-3 py-1.5 border border-gray-300 rounded hover:border-gray-400 disabled:opacity-40"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}
