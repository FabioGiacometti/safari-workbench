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
VITE_SUPABASE_KEY=...          # ⚠ service-role key — exposed in browser bundle
                               #   required by legacy tabs until Steps C–E complete
                               #   DO NOT add new uses; will be rotated after full migration
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
| `src/supabase.js` | Supabase client singleton (legacy tabs only — do not add new uses) |
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
| `api/admin.js` | Vercel function entry point (1 of 2 functions) |
| `api/health.js` | GET /api/health → {ok:true} (2 of 2 functions) |

### Migration status

| Tab | Write path | Status |
|---|---|---|
| EventCreateForm | `/api/admin/*` server backend | ✅ Migrated (Step B) |
| Conflictos (App.jsx) | `VITE_SUPABASE_KEY` direct | ⏳ Pending (Step C) |
| VenueCatalog + VenueEditForm | `/api/admin/*` server backend | ✅ Migrated (2026-06-27) |
| VenueCandidates | `/api/admin/*` server backend | ✅ Migrated (2026-06-27) |
| VenueDiscrepancies | `/api/admin/*` server backend | ✅ Migrated (prior session) |

`VITE_SUPABASE_KEY` (service-role) **cannot be rotated** until Conflictos (App.jsx) is migrated.

### Conflict types

Defined in `conflict-meta.js` and central to the app's purpose:

- **Actionable** (require editorial decision): `UNMATCHED`, `GEO_AMBIGUOUS`, `VENUE_GEO_MISMATCH`, `LOW_CONFIDENCE_GEO`
- **Non-actionable** (pipeline bugs/noise): `EXTRACTION_FAILURE`, `PROVIDER_PARSER_FAILURE`, `NO_LOCATION_SIGNAL`, `PROVIDER_NOISE`
- **Discovery**: `GEO_ENTITY_DISCOVERY` (propose new geo entities)
- **Informational**: `VENUE_WITHOUT_GEO`

### Main database tables

- `resolution_conflicts` — conflict queue (statuses: `open`, `in_review`, `resolved`, `dismissed`, `provider_bug`, `resolution_failed`)
- `canonical_rules` — location string → geo entity mappings
- `geo_entities` — cities/regions
- `venues` — venue master records
- `venue_merge_candidates` — dedup candidate pairs
- `venue_discrepancies` — manual vs. provider field mismatches
- `editorial_actions` — audit log of all ops actions
- `venues_catalog` (view) — denormalized venues with event counts
