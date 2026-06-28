// Workbench-side conflict classification, scoring, and explainability.
// Does NOT import from the pipeline — this module is loaded in the browser bundle.
// Mirrors ConflictType strings from pipeline/lib/conflict/conflict-types.js.

// ---------------------------------------------------------------------------
// Actionability classification
// ---------------------------------------------------------------------------

// NON_ACTIONABLE: system/normalizer failure — a canonical_rule cannot fix the root cause.
export const NON_ACTIONABLE_TYPES = new Set([
  'EXTRACTION_FAILURE',
  'PROVIDER_PARSER_FAILURE',
  'NO_LOCATION_SIGNAL',
  'PROVIDER_NOISE',
])

// ACTIONABLE: genuine editorial ambiguity — a canonical_rule resolves it.
// ORPHAN_CITY: city auto-matched by provider geo but no canonical rule exists yet.
// Resolving creates a provider-scoped rule confirming the existing auto_match candidate.
export const ACTIONABLE_TYPES = new Set([
  'UNMATCHED',
  'GEO_AMBIGUOUS',
  'VENUE_GEO_MISMATCH',
  'LOW_CONFIDENCE_GEO',
  'ORPHAN_CITY',
])

// DISCOVERY: geo entity does not exist yet — requires entity creation, not a rule.
export const DISCOVERY_TYPES = new Set([
  'GEO_ENTITY_DISCOVERY',
])

// Everything not in either set is INFORMATIONAL (observe, no rule creation).

export function isActionable(type)    { return ACTIONABLE_TYPES.has(type) }
export function isNonActionable(type) { return NON_ACTIONABLE_TYPES.has(type) }
export function isDiscovery(type)     { return DISCOVERY_TYPES.has(type) }

export function conflictActionability(type) {
  if (NON_ACTIONABLE_TYPES.has(type)) return 'non_actionable'
  if (ACTIONABLE_TYPES.has(type))     return 'actionable'
  if (DISCOVERY_TYPES.has(type))      return 'discovery'
  return 'informational'
}

// ---------------------------------------------------------------------------
// UNMATCHED subtype — purely internal classification, no DB column needed
// ---------------------------------------------------------------------------

export function unmatchedSubtype(cluster) {
  if (!cluster.raw_value)                return 'UNMATCHED_COUNTRY'
  if (cluster.entity_type === 'venue')   return 'UNMATCHED_VENUE'
  return 'UNMATCHED_CITY'
}

// ---------------------------------------------------------------------------
// Editorial priority score — deterministic, client-side only
//
// Formula: affected_count × recencyWeight × severityWeight × statusBoost
// Higher = surface first.
// NON_ACTIONABLE types score -1 so they sink to the bottom.
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHTS = {
  VENUE_GEO_MISMATCH:  1.5,
  UNMATCHED:           1.2,
  GEO_AMBIGUOUS:       1.2,
  ORPHAN_CITY:         1.0,
  LOW_CONFIDENCE_GEO:  0.8,
  VENUE_WITHOUT_GEO:   0.5,
}

export function editorialPriorityScore(cluster) {
  if (NON_ACTIONABLE_TYPES.has(cluster.conflict_type)) return -1

  const daysAgo = cluster.last_seen
    ? Math.max(0, (Date.now() - new Date(cluster.last_seen).getTime()) / 86_400_000)
    : 90
  // Full weight for last 7 days; linear decay to 0.2 by day 90.
  const recencyWeight = daysAgo <= 7
    ? 1.0
    : Math.max(0.2, 1 - (daysAgo - 7) / 83)

  const severityWeight = SEVERITY_WEIGHTS[cluster.conflict_type] ?? 1.0
  const statusBoost    = cluster.status === 'resolution_failed' ? 2.5 : 1.0

  return cluster.affected_count * recencyWeight * severityWeight * statusBoost
}

// ---------------------------------------------------------------------------
// Conflict explanation — "Why does this conflict exist?"
// ---------------------------------------------------------------------------

function fmtConf(cluster) {
  return cluster.avg_confidence != null
    ? (cluster.avg_confidence * 100).toFixed(0) + '%'
    : null
}

export function conflictExplanation(cluster) {
  const type = cluster.conflict_type
  const conf = fmtConf(cluster)
  const sub  = type === 'UNMATCHED' ? unmatchedSubtype(cluster) : null

  switch (type) {
    case 'VENUE_GEO_MISMATCH':
      return {
        reason:  'Venue geo entity contradicts text-based geo resolution',
        detail:  'Stage 3 (venue cache) and Stage 2 (text match) resolved to different geo entities. ' +
                 'The pipeline cannot choose automatically — a canonical rule pins the correct entity.',
        signals: [
          conf ? `avg confidence: ${conf}` : null,
          `${cluster.candidate_count ?? 0} candidates`,
          `resolution: ${cluster.resolution_mode}`,
        ].filter(Boolean),
      }

    case 'UNMATCHED': {
      const reasons = {
        UNMATCHED_CITY:    'City/location string found in provider data but matched no geo entity',
        UNMATCHED_VENUE:   'Venue name found but matched no geo entity in the registry',
        UNMATCHED_COUNTRY: 'No location signal in any field (should have been EXTRACTION_FAILURE)',
      }
      return {
        reason:  reasons[sub] ?? 'No geo or venue candidates found',
        detail:  'Create a canonical rule mapping this raw_location value to the correct geo entity. ' +
                 'On the next pipeline run, matching events will resolve via manual_override.',
        signals: [
          '0 geo/venue candidates',
          `resolution: ${cluster.resolution_mode}`,
          conf ? `confidence: ${conf}` : null,
        ].filter(Boolean),
      }
    }

    case 'GEO_AMBIGUOUS':
      return {
        reason:  'Multiple geo candidates, none dominant',
        detail:  `Confidence ${conf ?? '—'} below threshold with ${cluster.candidate_count ?? 0} candidates. ` +
                 'Select the correct entity to create a canonical rule.',
        signals: [
          `${cluster.candidate_count ?? 0} candidates`,
          conf ? `confidence: ${conf}` : null,
        ].filter(Boolean),
      }

    case 'LOW_CONFIDENCE_GEO':
      return {
        reason:  'Single geo candidate but confidence too low to trust',
        detail:  `Confidence ${conf ?? '—'} is below the acceptance threshold. The match may be wrong. ` +
                 'Confirm the candidate or override with a rule.',
        signals: [
          conf ? `confidence: ${conf}` : null,
          '1 candidate',
        ].filter(Boolean),
      }

    case 'VENUE_WITHOUT_GEO':
      return {
        reason:  'Venue matched but has no geo entity link',
        detail:  'A venue was found in the cache but it has no geo_entity_id. ' +
                 'The venue match cannot be used for geo disambiguation. Fix by adding geo_entity_id to the venue cache entry.',
        signals: ['venue matched (no geo link)', conf ? `confidence: ${conf}` : null].filter(Boolean),
      }

    case 'GEO_ENTITY_DISCOVERY': {
      const hints = cluster.discovery_hints ?? {}
      const where = [hints.city_name, hints.state_name, hints.country_code?.toUpperCase()]
        .filter(Boolean).join(', ')
      const confPct = hints.country_confidence != null
        ? ` (country confidence: ${(hints.country_confidence * 100).toFixed(0)}%)`
        : ''
      return {
        reason:  `No geo entity found for "${cluster.raw_value}" — entity creation needed`,
        detail:  `This city does not exist in the geo registry yet. Review the proposed entity${confPct} and approve to add it, or reject if it is noise or a duplicate.`,
        signals: [
          where ? `location context: ${where}` : null,
          hints.discovery_confidence != null
            ? `discovery confidence: ${(hints.discovery_confidence * 100).toFixed(0)}%`
            : null,
        ].filter(Boolean),
      }
    }

    case 'ORPHAN_CITY': {
      const cand = cluster.candidate_entities?.[0]
      return {
        reason:  'City auto-matched by provider but not confirmed by a canonical rule',
        detail:  'The pipeline resolved this location via provider-supplied geo data (geo_source=provider). ' +
                 'Creating a canonical rule pins the match editorially and prevents future ambiguity if the provider data changes.',
        signals: [
          cand ? `suggested: ${cand.display_name} (${(cand.confidence * 100).toFixed(0)}%)` : null,
          conf ? `confidence: ${conf}` : null,
          `provider: ${cluster.provider}`,
        ].filter(Boolean),
      }
    }

    case 'EXTRACTION_FAILURE':
      return {
        reason:  'Provider/normalizer sent no location data',
        detail:  'raw_location and venue_hint are both empty. ' +
                 'A canonical rule with match_raw_location="" would silently capture all future empty-location events.',
        signals: ['raw_location: (empty)', 'venue_hint: (empty)', 'no lat/lng hints'],
      }

    case 'PROVIDER_PARSER_FAILURE':
      return {
        reason:  'Normalizer failed to parse a structured provider field',
        detail:  'A location field was present but in an unrecognised format. Fix the normalizer to handle this pattern.',
        signals: [conf ? `confidence: ${conf}` : null, `provider: ${cluster.provider}`].filter(Boolean),
      }

    case 'NO_LOCATION_SIGNAL':
      return {
        reason:  'Location fields present but carry no geographic signal',
        detail:  'Fields like "N/A", "—", or similar placeholders were found. These should be filtered by the normalizer.',
        signals: [conf ? `confidence: ${conf}` : null].filter(Boolean),
      }

    case 'PROVIDER_NOISE':
      return {
        reason:  'raw_location matches a known non-geographic noise pattern',
        detail:  'Strings like "online", "TBD", "por confirmar" are not geographic. Matched by NOISE_PATTERNS in the conflict engine.',
        signals: [`raw_value: "${cluster.raw_value}"`],
      }

    default:
      return {
        reason:  type ?? 'Unknown conflict type',
        detail:  '',
        signals: [conf ? `confidence: ${conf}` : null, `resolution: ${cluster.resolution_mode}`].filter(Boolean),
      }
  }
}

// ---------------------------------------------------------------------------
// Confidence bands
// ---------------------------------------------------------------------------

export function confidenceBand(score) {
  if (score == null) return { band: 'unknown', label: 'Sin dato', color: 'gray' }
  if (score >= 0.85) return { band: 'high',   label: 'Alta confianza', color: 'green' }
  if (score >= 0.65) return { band: 'medium', label: 'Confianza media — revisar', color: 'yellow' }
  return               { band: 'low',    label: 'Confianza baja — verificar manualmente', color: 'red' }
}

// ---------------------------------------------------------------------------
// Spanish UI copy — single source of truth for conflict resolution panel
// ---------------------------------------------------------------------------

export const COPY = {
  reportedValue:        'Valor reportado',
  systemInterpretation: 'Interpretación del sistema',
  noCandidates:         'Sin coincidencias sugeridas',
  noCandidatesDetail:   'El sistema no encontró una ciudad o región suficientemente confiable para este valor. Busque manualmente la entidad correcta.',
  suggestedCandidate:   'Candidato sugerido',
  multipleCandidates:   'Candidatos disponibles',
  searchOther:          'Buscar otra entidad',
  noneOfThese:          'Ninguna de estas opciones',
  scopeProvider:        (provider) => `Recordar para futuros eventos de ${provider}`,
  scopeProviderDetail:  (provider, raw) => `Cuando ${provider} vuelva a enviar "${raw}", el sistema usará esta entidad automáticamente.`,
  scopeGlobal:          'Aplicar a todos los proveedores',
  scopeGlobalDetail:    (raw) => `Cualquier proveedor que envíe "${raw}" usará esta entidad. Usar solo cuando el valor sea inequívoco.`,
  scopeGlobalWarning:   'Esta regla global afecta a todos los proveedores. Aplicar solo si el valor es inequívoco para cualquier fuente.',
  lowConfAck:           'Esta coincidencia tiene baja confianza. Verificar que la entidad sugerida sea correcta antes de continuar.',
  nameMismatchWarning:  (raw, name) => `El valor reportado "${raw}" y el candidato "${name}" son muy diferentes. Verificar que correspondan a la misma ubicación.`,
  // Primary action labels — reflect that a persistent rule is always created
  confirmAndRemember:   (provider) => `Confirmar y recordar para ${provider}`,
  createGlobalRule:     'Crear regla para todos los proveedores',
  // Consequence summary — shown before the operator commits
  consequenceProvider:  (raw, name, provider) => `Vas a asociar "${raw}" con ${name}. Esta regla se aplicará cuando ${provider} vuelva a enviar este valor.`,
  consequenceGlobal:    (raw, name) => `Vas a asociar "${raw}" con ${name} para cualquier proveedor que envíe este valor.`,
  consequenceNoRewrite: 'Los eventos existentes no se reescriben. Los próximos ingresos del pipeline usarán esta asociación.',
  // Success copy — states conflict closed, rule persisted, rule ID, no rewrite
  ruleCreated: (ruleId, scope, provider) => {
    const scopeDesc = scope === 'global'
      ? 'para todos los proveedores'
      : `para ${provider}`
    return `Conflicto cerrado. Regla persistente creada ${scopeDesc} (id: ${ruleId}). Los eventos existentes no se reescriben.`
  },
  markInReview:  'Marcar en revisión',
  providerBug:   'Error del proveedor',
  dismiss:       'Ignorar',
  loading:       '…',
  errorGeneric:  'Ocurrió un error. Intentar de nuevo.',
}

// ---------------------------------------------------------------------------
// Badge styling — duplicated here so App.jsx imports from one place
// ---------------------------------------------------------------------------

export function conflictBadgeStyle(type) {
  switch (type) {
    case 'VENUE_GEO_MISMATCH':     return 'bg-orange-100 text-orange-700 border border-orange-300'
    case 'VENUE_WITHOUT_GEO':      return 'bg-yellow-100 text-yellow-700 border border-yellow-300'
    case 'UNMATCHED':              return 'bg-red-100 text-red-700 border border-red-300'
    case 'GEO_AMBIGUOUS':          return 'bg-purple-100 text-purple-700 border border-purple-300'
    case 'LOW_CONFIDENCE_GEO':     return 'bg-blue-100 text-blue-700 border border-blue-300'
    case 'ORPHAN_CITY':             return 'bg-indigo-100 text-indigo-700 border border-indigo-300'
    case 'GEO_ENTITY_DISCOVERY':    return 'bg-teal-100 text-teal-700 border border-teal-300'
    case 'EXTRACTION_FAILURE':
    case 'PROVIDER_PARSER_FAILURE':
    case 'NO_LOCATION_SIGNAL':
    case 'PROVIDER_NOISE':         return 'bg-gray-200 text-gray-600 border border-gray-400'
    default:                       return 'bg-gray-100 text-gray-500 border border-gray-300'
  }
}
