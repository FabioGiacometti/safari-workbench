import { useState, useEffect, useCallback, useRef } from 'react'
import GeoEntityCombobox from './GeoEntityCombobox.jsx'

// ---------------------------------------------------------------------------
// Spanish copy
// ---------------------------------------------------------------------------

const COPY = {
  title:              'Reglas canónicas',
  searchPlaceholder:  'Buscar por valor reportado…',
  filterProvider:     'Proveedor',
  filterScope:        'Alcance',
  filterStatus:       'Estado',
  scopeAll:           'Todos',
  scopeProvider:      'Solo proveedor',
  scopeGlobal:        'Solo globales',
  statusAll:          'Todos',
  statusActive:       'Activas',
  statusDisabled:     'Desactivadas',
  allProviders:       'Todos los proveedores',
  globalBadge:        'Global',
  globalRisk:         'Esta regla afecta a todos los proveedores.',
  disabledBadge:      'Desactivada',
  activeBadge:        'Activa',
  noRules:            'No hay reglas que coincidan con los filtros seleccionados.',
  loading:            'Cargando reglas…',
  scopeLabel:         (provider) => provider ? `Solo ${provider}` : 'Todos los proveedores',
  effectProvider:     (provider, value, entity) =>
    `Cuando ${provider} envíe "${value}", el sistema utilizará ${entity}.`,
  effectGlobal:       (value, entity) =>
    `Cuando cualquier proveedor envíe "${value}", el sistema utilizará ${entity}.`,
  noRewrite:          'Los eventos existentes no se reescriben. Los próximos ingresos del pipeline usarán este cambio.',
  disableAction:      'Desactivar regla',
  enableAction:       'Reactivar regla',
  correctAction:      'Corregir asociación',
  cancelAction:       'Cancelar',
  confirmDisable:     'Confirmar desactivación',
  confirmEnable:      'Confirmar reactivación',
  confirmCorrect:     'Confirmar corrección',
  reasonLabel:        'Motivo',
  reasonRequired:     'Se requiere un motivo.',
  newEntityLabel:     'Nueva entidad geográfica',
  previousEntity:     'Entidad anterior',
  newEntity:          'Nueva entidad',
  disableWarning:     (value, entity, scope) =>
    `Vas a desactivar la regla para "${value}" → ${entity} (${scope}). El pipeline dejará de usar esta regla en futuras ingestas.`,
  enableWarning:      (value, entity) =>
    `Vas a reactivar la regla para "${value}" → ${entity}. El pipeline volverá a usarla en futuras ingestas.`,
  correctionSummary:  (value, prev, next) =>
    `Vas a cambiar "${value}" de ${prev} a ${next}.`,
  historyTitle:       'Historial de cambios',
  noHistory:          'Sin historial registrado.',
  disabledReason:     'Motivo de desactivación',
  updatedBy:          'Actualizado por',
  createdBy:          'Creado por',
  sourceWorkbench:    'Editorial',
  sourceLegacy:       'Legado',
  typGeoOverride:     'Geo override',
  back:               '← Volver a la lista',
  pagePrev:           '← Anterior',
  pageNext:           'Siguiente →',
}

const DISABLE_REASONS = [
  'Asociación incorrecta',
  'Regla demasiado amplia',
  'El proveedor corrigió el dato',
  'Entidad geográfica incorrecta',
  'Duplicada',
  'Otro',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}

function scopeLabel(rule) {
  return rule.scope === 'global' ? COPY.globalBadge : (rule.provider ?? '—')
}

function sourceLabel(src) {
  if (src === 'workbench') return COPY.sourceWorkbench
  if (src === 'legacy')    return COPY.sourceLegacy
  return src ?? '—'
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ status }) {
  if (status === 'disabled') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-300 font-semibold">
        {COPY.disabledBadge}
      </span>
    )
  }
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 border border-green-300">
      {COPY.activeBadge}
    </span>
  )
}

// ---------------------------------------------------------------------------
// GlobalWarningBadge
// ---------------------------------------------------------------------------

function GlobalWarningBadge() {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-300 font-semibold"
      title={COPY.globalRisk}
    >
      {COPY.globalBadge} ⚠
    </span>
  )
}

// ---------------------------------------------------------------------------
// RuleRow — single list item
// ---------------------------------------------------------------------------

function RuleRow({ rule, isSelected, onClick }) {
  return (
    <button
      data-testid={`rule-row-${rule.id}`}
      onClick={onClick}
      className={[
        'w-full text-left px-4 py-3 border-b border-gray-200 hover:bg-gray-50 transition-colors',
        isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : 'border-l-2 border-l-transparent',
        rule.status === 'disabled' ? 'opacity-60' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-2 mb-1">
        <span className="text-gray-900 font-semibold truncate flex-1 text-xs">
          {rule.reported_value || <span className="italic text-gray-400">(vacío)</span>}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {rule.scope === 'global' && <GlobalWarningBadge />}
          <StatusBadge status={rule.status} />
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
        <span className="font-medium text-gray-700">{rule.entity_name ?? rule.entity_id ?? '—'}</span>
        {rule.entity_level && <span className="text-gray-400">· {rule.entity_level}</span>}
        {rule.entity_country && <span className="text-gray-400">{rule.entity_country}</span>}
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
        <span>{rule.scope === 'global' ? COPY.allProviders : (rule.provider ?? '—')}</span>
        <span>·</span>
        <span>{fmtDate(rule.updated_at)}</span>
        {rule.updated_by && <span>· {rule.updated_by}</span>}
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// DisablePanel
// ---------------------------------------------------------------------------

function DisablePanel({ rule, apiFetch, onDone, onCancel }) {
  const [reason, setReason]   = useState('')
  const [status, setStatus]   = useState(null)
  const [msg, setMsg]         = useState('')

  async function handleSubmit() {
    if (!reason) { setMsg(COPY.reasonRequired); return }
    setStatus('loading')
    try {
      await apiFetch(`rules/${rule.id}/disable`, 'POST', { reason })
      setStatus('done')
      setTimeout(() => onDone(), 1000)
    } catch (err) {
      setStatus('error')
      setMsg(err.message)
    }
  }

  const scopeText = rule.scope === 'global' ? COPY.allProviders : (rule.provider ?? '—')

  return (
    <div className="rounded border border-red-200 bg-red-50 px-4 py-4 mb-4" data-testid="disable-panel">
      <h3 className="text-sm font-semibold text-red-800 mb-3">{COPY.disableAction}</h3>
      <p className="text-xs text-red-700 mb-3">
        {COPY.disableWarning(rule.reported_value, rule.entity_name ?? rule.entity_id, scopeText)}
      </p>
      <p className="text-xs text-gray-500 mb-3">{COPY.noRewrite}</p>

      <label className="block text-xs text-gray-700 font-medium mb-1">{COPY.reasonLabel}</label>
      <select
        value={reason}
        onChange={e => { setReason(e.target.value); setMsg('') }}
        disabled={status === 'loading' || status === 'done'}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 mb-3 bg-white"
        data-testid="disable-reason-select"
      >
        <option value="">— elegir motivo —</option>
        {DISABLE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
      </select>

      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!reason || status === 'loading' || status === 'done'}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white text-xs rounded transition-colors"
          data-testid="disable-confirm-btn"
        >
          {status === 'loading' ? '…' : status === 'done' ? '✓' : COPY.confirmDisable}
        </button>
        <button
          onClick={onCancel}
          disabled={status === 'loading' || status === 'done'}
          className="px-3 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs rounded hover:bg-gray-50"
        >
          {COPY.cancelAction}
        </button>
      </div>
      {msg && <p className={`mt-2 text-xs ${status === 'error' ? 'text-red-600' : 'text-gray-500'}`}>{msg}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// EnablePanel
// ---------------------------------------------------------------------------

function EnablePanel({ rule, apiFetch, onDone, onCancel }) {
  const [status, setStatus] = useState(null)
  const [msg, setMsg]       = useState('')

  async function handleSubmit() {
    setStatus('loading')
    try {
      await apiFetch(`rules/${rule.id}/enable`, 'POST', {})
      setStatus('done')
      setTimeout(() => onDone(), 1000)
    } catch (err) {
      setStatus('error')
      setMsg(err.message)
    }
  }

  return (
    <div className="rounded border border-green-200 bg-green-50 px-4 py-4 mb-4" data-testid="enable-panel">
      <h3 className="text-sm font-semibold text-green-800 mb-3">{COPY.enableAction}</h3>
      <p className="text-xs text-green-700 mb-3">
        {COPY.enableWarning(rule.reported_value, rule.entity_name ?? rule.entity_id)}
      </p>
      <p className="text-xs text-gray-500 mb-3">{COPY.noRewrite}</p>
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={status === 'loading' || status === 'done'}
          className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-xs rounded"
          data-testid="enable-confirm-btn"
        >
          {status === 'loading' ? '…' : status === 'done' ? '✓' : COPY.confirmEnable}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs rounded hover:bg-gray-50">
          {COPY.cancelAction}
        </button>
      </div>
      {msg && <p className="mt-2 text-xs text-red-600">{msg}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CorrectPanel
// ---------------------------------------------------------------------------

function CorrectPanel({ rule, apiFetch, onDone, onCancel }) {
  const [newEntityId, setNewEntityId]     = useState(null)
  const [reason, setReason]               = useState('')
  const [status, setStatus]               = useState(null)
  const [msg, setMsg]                     = useState('')
  const [geoResults, setGeoResults]       = useState([])

  // Intercept apiFetch to capture geo-entity search results for name lookup
  const wrappedFetch = useCallback(async (path, method, body) => {
    const res = await apiFetch(path, method, body)
    if (path.startsWith('geo-entities') && res.entities) {
      setGeoResults(prev => {
        const ids = new Set(prev.map(e => e.id))
        const fresh = (res.entities ?? []).filter(e => !ids.has(e.id))
        return [...prev, ...fresh]
      })
    }
    return res
  }, [apiFetch])

  const newEntityName = newEntityId
    ? (geoResults.find(e => e.id === newEntityId)?.display_name ?? newEntityId)
    : null

  async function handleSubmit() {
    if (!newEntityId) { setMsg('Seleccione una nueva entidad geográfica.'); return }
    if (!reason)      { setMsg(COPY.reasonRequired); return }
    setStatus('loading')
    try {
      await apiFetch(`rules/${rule.id}/correct`, 'POST', {
        new_geo_entity_id: newEntityId,
        reason,
      })
      setStatus('done')
      setTimeout(() => onDone(), 1000)
    } catch (err) {
      setStatus('error')
      setMsg(err.code === 'no_change' ? 'La entidad seleccionada es la misma que la actual.' : err.message)
    }
  }

  const prevName = rule.entity_name ?? rule.entity_id ?? '—'

  return (
    <div className="rounded border border-blue-200 bg-blue-50 px-4 py-4 mb-4" data-testid="correct-panel">
      <h3 className="text-sm font-semibold text-blue-800 mb-3">{COPY.correctAction}</h3>

      <div className="mb-3 text-xs text-gray-700 space-y-1">
        <div>
          <span className="text-gray-500">{COPY.previousEntity}: </span>
          <span className="font-medium">{prevName}</span>
        </div>
        <div className="text-gray-500 text-xs">
          Alcance: {rule.scope === 'global' ? COPY.allProviders : (rule.provider ?? '—')}
          {rule.scope === 'global' && (
            <span className="ml-2 text-orange-600 font-medium">⚠ Regla global</span>
          )}
        </div>
      </div>

      <label className="block text-xs text-gray-700 font-medium mb-1">{COPY.newEntityLabel}</label>
      <GeoEntityCombobox
        apiFetch={wrappedFetch}
        candidates={[]}
        value={newEntityId}
        onChange={(id) => { setNewEntityId(id); setMsg('') }}
        disabled={status === 'loading' || status === 'done'}
        data-testid="correct-entity-combobox"
      />

      {newEntityId && newEntityId !== rule.entity_id && (
        <p className="mt-2 text-xs text-blue-700 bg-white rounded px-2 py-1.5 border border-blue-200" data-testid="correction-summary">
          {COPY.correctionSummary(rule.reported_value, prevName, newEntityName ?? newEntityId)}
        </p>
      )}

      <label className="block text-xs text-gray-700 font-medium mb-1 mt-3">{COPY.reasonLabel}</label>
      <select
        value={reason}
        onChange={e => { setReason(e.target.value); setMsg('') }}
        disabled={status === 'loading' || status === 'done'}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 mb-3 bg-white"
        data-testid="correct-reason-select"
      >
        <option value="">— elegir motivo —</option>
        {DISABLE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
      </select>

      <p className="text-xs text-gray-400 mb-3">{COPY.noRewrite}</p>

      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!newEntityId || !reason || status === 'loading' || status === 'done'}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs rounded"
          data-testid="correct-confirm-btn"
        >
          {status === 'loading' ? '…' : status === 'done' ? '✓' : COPY.confirmCorrect}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 bg-white border border-gray-300 text-gray-600 text-xs rounded hover:bg-gray-50">
          {COPY.cancelAction}
        </button>
      </div>
      {msg && <p className={`mt-2 text-xs ${status === 'error' ? 'text-red-600' : 'text-gray-500'}`}>{msg}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// RuleDetail — right panel
// ---------------------------------------------------------------------------

function RuleDetail({ ruleId, apiFetch, onBack, initialRule }) {
  const [rule, setRule]       = useState(initialRule ?? null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(!initialRule)
  const [action, setAction]   = useState(null)  // 'disable' | 'enable' | 'correct'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`rules/${ruleId}`)
      setRule(res.rule)
      setHistory(res.history ?? [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [ruleId, apiFetch])

  useEffect(() => { load() }, [load])

  function handleActionDone() {
    setAction(null)
    load()
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">{COPY.loading}</div>
  if (!rule)   return <div className="p-6 text-sm text-red-500">No se encontró la regla.</div>

  const isGlobal = rule.scope === 'global'
  const effectText = isGlobal
    ? COPY.effectGlobal(rule.reported_value, rule.entity_name ?? rule.entity_id)
    : COPY.effectProvider(rule.provider, rule.reported_value, rule.entity_name ?? rule.entity_id)

  return (
    <div className="p-6 max-w-2xl" data-testid="rule-detail">
      <button onClick={onBack} className="text-xs text-blue-600 hover:underline mb-4 block">{COPY.back}</button>

      {/* Header */}
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h1 className="text-xl font-bold text-gray-900">
              {rule.reported_value || <span className="italic text-gray-400">(vacío)</span>}
            </h1>
            {isGlobal && <GlobalWarningBadge />}
            <StatusBadge status={rule.status} />
          </div>
          <p className="text-sm text-gray-500">
            {rule.entity_name ?? rule.entity_id ?? '—'}
            {rule.entity_level && ` · ${rule.entity_level}`}
            {rule.entity_country && ` · ${rule.entity_country}`}
          </p>
        </div>
      </div>

      {/* Panels */}
      {action === 'disable' && (
        <DisablePanel rule={rule} apiFetch={apiFetch} onDone={handleActionDone} onCancel={() => setAction(null)} />
      )}
      {action === 'enable' && (
        <EnablePanel rule={rule} apiFetch={apiFetch} onDone={handleActionDone} onCancel={() => setAction(null)} />
      )}
      {action === 'correct' && (
        <CorrectPanel rule={rule} apiFetch={apiFetch} onDone={handleActionDone} onCancel={() => setAction(null)} />
      )}

      {/* Detail rows */}
      {!action && (
        <>
          <div className="bg-white rounded border border-gray-200 divide-y divide-gray-100 mb-4">
            <Row2 label="Valor reportado"     value={rule.reported_value || '(vacío)'} />
            <Row2 label="Entidad geográfica"  value={rule.entity_name ?? rule.entity_id ?? '—'} />
            <Row2 label="Alcance"             value={isGlobal ? COPY.allProviders : (rule.provider ?? '—')} />
            {rule.entity_region  && <Row2 label="Región"  value={rule.entity_region} />}
            {rule.entity_country && <Row2 label="País"    value={rule.entity_country} />}
            <Row2 label="Tipo"    value={rule.type === 'GEO_OVERRIDE' ? COPY.typGeoOverride : rule.type} />
            <Row2 label="Origen"  value={sourceLabel(rule.source)} />
            <Row2 label="Creado por"     value={rule.created_by  ?? '—'} />
            <Row2 label="Actualizado"    value={fmtDate(rule.updated_at)} />
            {rule.updated_by && <Row2 label={COPY.updatedBy} value={rule.updated_by} />}
            {rule.disabled_reason && <Row2 label={COPY.disabledReason} value={rule.disabled_reason} />}
            {rule.previous_entity_id && (
              <Row2 label="Entidad anterior" value={rule.previous_entity_id} />
            )}
          </div>

          {/* Future-behavior explanation */}
          <div className="mb-4 rounded border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
            <p className="font-medium text-gray-700 mb-1">Qué sucederá en futuras ingestas</p>
            {rule.status === 'disabled' ? (
              <p className="text-red-600">Esta regla está desactivada y no se aplicará en próximas ingestas.</p>
            ) : (
              <p>{effectText}</p>
            )}
            <p className="text-gray-400 mt-1">{COPY.noRewrite}</p>
          </div>

          {/* Actions */}
          {!action && (
            <div className="flex gap-2 flex-wrap mb-6">
              {rule.status === 'active' ? (
                <>
                  <button
                    onClick={() => setAction('correct')}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors"
                    data-testid="btn-correct"
                  >
                    {COPY.correctAction}
                  </button>
                  <button
                    onClick={() => setAction('disable')}
                    className="px-3 py-1.5 bg-white border border-red-300 text-red-600 text-xs rounded hover:bg-red-50 transition-colors"
                    data-testid="btn-disable"
                  >
                    {COPY.disableAction}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setAction('enable')}
                  className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded transition-colors"
                  data-testid="btn-enable"
                >
                  {COPY.enableAction}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* History */}
      <div className="border-t border-gray-200 pt-4" data-testid="rule-history">
        <h2 className="text-xs text-gray-400 uppercase tracking-widest mb-3">{COPY.historyTitle}</h2>
        {history.length === 0 ? (
          <p className="text-xs text-gray-400">{COPY.noHistory}</p>
        ) : (
          <div className="space-y-2">
            {history.map((h, i) => (
              <div key={i} className="bg-white rounded px-3 py-2 border border-gray-200 text-xs">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-gray-700">{h.action_type.replace('rule_', '')}</span>
                  <span className="text-gray-400">· {h.actor}</span>
                  <span className="ml-auto text-gray-300">{fmtDate(h.created_at)}</span>
                </div>
                {h.after_state?.reason && (
                  <p className="text-gray-400 italic">{h.after_state.reason}</p>
                )}
                {h.after_state?.new_geo_entity_id && (
                  <p className="text-gray-500">
                    {h.after_state.previous_geo_entity_id} → {h.after_state.new_geo_entity_id}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Row2({ label, value }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="text-xs text-gray-500 w-36 flex-shrink-0">{label}</span>
      <span className="text-xs text-gray-900 flex-1">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RulesScreen
// ---------------------------------------------------------------------------

export default function RulesScreen({ apiFetch, initialRuleId }) {
  const [rules, setRules]         = useState([])
  const [total, setTotal]         = useState(0)
  const [page, setPage]           = useState(0)
  const [loading, setLoading]     = useState(true)
  const [selectedId, setSelectedId] = useState(initialRuleId ?? null)
  const [selectedRule, setSelectedRule] = useState(null)

  // Filters
  const [q, setQ]               = useState('')
  const [provider, setProvider] = useState('')
  const [scope, setScope]       = useState('')
  const [status, setStatus]     = useState('active')

  const PAGE_SIZE = 50
  const debounceRef = useRef(null)

  const load = useCallback(async (params = {}) => {
    setLoading(true)
    const qs = new URLSearchParams()
    if (params.q        ?? q)        qs.set('q',        params.q        ?? q)
    if (params.provider ?? provider) qs.set('provider', params.provider ?? provider)
    if (params.scope    ?? scope)    qs.set('scope',    params.scope    ?? scope)
    const st = params.status !== undefined ? params.status : status
    if (st) qs.set('status', st)
    qs.set('page', String(params.page ?? page))
    try {
      const res = await apiFetch(`rules?${qs}`)
      setRules(res.rules ?? [])
      setTotal(res.total ?? 0)
    } catch { /* ignore */ }
    setLoading(false)
  }, [q, provider, scope, status, page, apiFetch])

  useEffect(() => { load() }, [])  // initial load

  function handleQChange(val) {
    setQ(val)
    setPage(0)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => load({ q: val, page: 0 }), 300)
  }

  function handleFilterChange(field, val) {
    if (field === 'provider') { setProvider(val); setPage(0); load({ provider: val, page: 0 }) }
    if (field === 'scope')    { setScope(val);    setPage(0); load({ scope: val,    page: 0 }) }
    if (field === 'status')   { setStatus(val);   setPage(0); load({ status: val,   page: 0 }) }
  }

  function handleSelectRule(rule) {
    setSelectedId(rule.id)
    setSelectedRule(rule)
  }

  if (selectedId) {
    return (
      <div className="h-full overflow-y-auto bg-gray-50">
        <RuleDetail
          ruleId={selectedId}
          apiFetch={apiFetch}
          initialRule={selectedRule}
          onBack={() => { setSelectedId(null); setSelectedRule(null); load() }}
        />
      </div>
    )
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Filters bar */}
      <div className="flex gap-2 px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0 flex-wrap">
        <input
          type="search"
          placeholder={COPY.searchPlaceholder}
          value={q}
          onChange={e => handleQChange(e.target.value)}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 w-52 focus:outline-none focus:border-blue-400"
          data-testid="rules-search"
        />
        <input
          type="text"
          placeholder={COPY.filterProvider}
          value={provider}
          onChange={e => handleFilterChange('provider', e.target.value)}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 w-36 focus:outline-none focus:border-blue-400"
          data-testid="rules-filter-provider"
        />
        <select
          value={scope}
          onChange={e => handleFilterChange('scope', e.target.value)}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
          data-testid="rules-filter-scope"
        >
          <option value="">{COPY.scopeAll}</option>
          <option value="provider">{COPY.scopeProvider}</option>
          <option value="global">{COPY.scopeGlobal}</option>
        </select>
        <select
          value={status}
          onChange={e => handleFilterChange('status', e.target.value)}
          className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
          data-testid="rules-filter-status"
        >
          <option value="">{COPY.statusAll}</option>
          <option value="active">{COPY.statusActive}</option>
          <option value="disabled">{COPY.statusDisabled}</option>
        </select>
        <span className="ml-auto text-xs text-gray-400 self-center" data-testid="rules-count">
          {total} regla{total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto bg-white">
        {loading ? (
          <div className="px-4 py-6 text-xs text-gray-400 text-center">{COPY.loading}</div>
        ) : rules.length === 0 ? (
          <div className="px-4 py-6 text-xs text-gray-400 text-center" data-testid="rules-empty">
            {COPY.noRules}
          </div>
        ) : (
          rules.map(r => (
            <RuleRow
              key={r.id}
              rule={r}
              isSelected={selectedId === r.id}
              onClick={() => handleSelectRule(r)}
            />
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-500 flex-shrink-0">
          <button
            onClick={() => { const p = page - 1; setPage(p); load({ page: p }) }}
            disabled={page === 0}
            className="disabled:opacity-40 hover:text-gray-700"
            data-testid="rules-page-prev"
          >
            {COPY.pagePrev}
          </button>
          <span>Página {page + 1} de {totalPages}</span>
          <button
            onClick={() => { const p = page + 1; setPage(p); load({ page: p }) }}
            disabled={page >= totalPages - 1}
            className="disabled:opacity-40 hover:text-gray-700"
            data-testid="rules-page-next"
          >
            {COPY.pageNext}
          </button>
        </div>
      )}
    </div>
  )
}
