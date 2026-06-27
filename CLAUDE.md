# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # dev server on port 5174
npm run build     # production bundle → dist/
npm run preview   # preview the production build locally
```

No lint or test scripts are configured.

## Environment

Requires `.env.local` (not committed):
```
VITE_SUPABASE_URL=...          # Supabase project URL (safe to expose)
VITE_SUPABASE_ANON_KEY=...     # Anon key — used only by LoginForm for auth
# VITE_SUPABASE_KEY has been removed — all tabs migrated to /api/admin/*
#   Rotate the service-role key in Supabase dashboard (it was exposed in bundle until 2026-06-27)
# VITE_API_BASE_URL is retired — EventCreateForm now calls /api/admin/* directly
```

Server-only (set in Vercel dashboard, no VITE_ prefix):
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Tailwind is loaded via CDN in `index.html`, not installed as a package.

## Architecture

Single-page React app (Vite + Supabase) for an internal editorial ops team. No routing library — tab state is managed in `App.jsx`. Deployed to Vercel with SPA rewrites (`vercel.json`).

### Ownership boundary

**Workbench owns all manual event writes.** Safari owns the public read API.

- Workbench authenticated backend (`/api/admin/*`) is the only supported write path for `provider=manual` events.
- Safari `/api/events` is read-only and must not be modified for write access.
- Both repos share the same Supabase project (`zvtpamjbiqsfrmiuyidl`).
- `safari/api/admin/events.js` has been retired (removed 2026-06-26). Do not recreate it.

### Key files

| File | Role |
|---|---|
| `src/App.jsx` | Shell: tab bar, conflict queue (left panel), conflict detail (right panel), keyboard nav |
| `src/conflict-meta.js` | Business logic: conflict type classification, priority scoring, badge styles, help text |
| `src/LoginForm.jsx` | Browser auth gate; exports `authClient` (anon key only) |
| `src/EventCreateForm.jsx` | Manual event authoring and lifecycle — uses only `/api/admin/*`, no direct Supabase |
| `src/VenueCandidates.jsx` | Venue deduplication workflow — uses only `/api/admin/*`, no direct Supabase |
| `src/VenueCatalog.jsx` | Venue search, detail view, inline editing via `VenueEditForm` |
| `src/VenueDiscrepancies.jsx` | Manual-vs-provider field conflict review |
| `src/VenueEditForm.jsx` | Venue record editor; tracks `manually_edited_fields`, handles JSON/array fields |
| `src/api/auth.js` | Server: `requireOperator()` — validates Bearer token, checks OPERATOR_EMAILS |
| `src/api/router.js` | Server: dispatches by path segments + HTTP method |
| `src/api/handlers/events.js` | Server: create, update, publish, cancel, audit handlers |
| `src/api/handlers/venues.js` | Server: venue list, detail, update (PATCH via `edit_venue` RPC), search handlers |
| `src/api/handlers/candidates.js` | Server: venue-candidates list, approve, reject, restore-pending, merge, rollback |
| `src/api/handlers/conflicts.js` | Server: conflict queue reads + 6 resolution actions |
| `api/admin.js` | Vercel function entry point (1 of 2 functions) |
| `api/health.js` | GET /api/health → {ok:true} (2 of 2 functions) |

### Migration status

| Tab | Write path | Status |
|---|---|---|
| EventCreateForm | `/api/admin/*` server backend | ✅ Migrated (Step B) |
| Conflictos (App.jsx) | `/api/admin/*` server backend | ✅ Migrated (2026-06-27) — Step C complete |
| VenueCatalog + VenueEditForm | `/api/admin/*` server backend | ✅ Migrated (2026-06-27) |
| VenueCandidates | `/api/admin/*` server backend | ✅ Migrated (2026-06-27) |
| VenueDiscrepancies | `/api/admin/*` server backend | ✅ Migrated (prior session) |

**All tabs migrated.** `VITE_SUPABASE_KEY` removed from bundle. Rotate the service-role key in Supabase dashboard.

### Conflict types

Defined in `conflict-meta.js` and central to the app's purpose:

- **Actionable** (require editorial decision): `UNMATCHED`, `GEO_AMBIGUOUS`, `VENUE_GEO_MISMATCH`, `LOW_CONFIDENCE_GEO`, `ORPHAN_CITY`
- **Non-actionable** (pipeline bugs/noise): `EXTRACTION_FAILURE`, `PROVIDER_PARSER_FAILURE`, `NO_LOCATION_SIGNAL`, `PROVIDER_NOISE`
- **Discovery**: `GEO_ENTITY_DISCOVERY` (propose new geo entities)
- **Informational**: `VENUE_WITHOUT_GEO`

`ORPHAN_CITY`: city auto-matched by provider geo but not yet confirmed by a canonical rule. Resolution creates a provider-scoped `GEO_OVERRIDE` rule confirming the existing candidate.

### Conflict Queue API routes

All require Bearer token (operator auth). Actor always derived from `user.email` server-side.

```
GET  /api/admin/conflicts                         → active conflict list
GET  /api/admin/conflicts/:id/events              → sample events
GET  /api/admin/conflicts/:id/rules               → canonical rule history
GET  /api/admin/geo-entities                      → geo entity picker
POST /api/admin/conflicts/:id/in-review           → mark in review
POST /api/admin/conflicts/:id/dismiss             → dismiss conflict
POST /api/admin/conflicts/:id/provider-bug        → mark provider bug
POST /api/admin/conflicts/:id/resolve-rule        → create rule + resolve (UNMATCHED/GEO_AMBIGUOUS/VENUE_GEO_MISMATCH/LOW_CONFIDENCE_GEO/ORPHAN_CITY)
POST /api/admin/conflicts/:id/resolve-venue-geo   → attach geo entity to venue (VENUE_WITHOUT_GEO)
POST /api/admin/conflicts/:id/resolve-discovery   → approve/reject discovery candidate (GEO_ENTITY_DISCOVERY)
```

### Main database tables

- `resolution_conflicts` — conflict queue (statuses: `open`, `in_review`, `resolved`, `dismissed`, `provider_bug`, `resolution_failed`, `auto_resolved`)
- `canonical_rules` — location string → geo entity mappings
- `geo_entities` — cities/regions
- `venues` — venue master records
- `venue_merge_candidates` — dedup candidate pairs
- `venue_discrepancies` — manual vs. provider field mismatches
- `editorial_actions` — audit log of all ops actions
- `venues_catalog` (view) — denormalized venues with event counts
- `geo_entity_candidates` — proposed new geo entities from pipeline discovery
