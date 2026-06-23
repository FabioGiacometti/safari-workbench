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
VITE_SUPABASE_URL=...
VITE_SUPABASE_KEY=...     # service role key — full DB access
VITE_API_BASE_URL=...     # external event-creation API
```

Tailwind is loaded via CDN in `index.html`, not installed as a package.

## Architecture

Single-page React app (Vite + Supabase) for an internal editorial ops team. No routing library — tab state is managed in `App.jsx`. Deployed to Vercel with SPA rewrites (`vercel.json`).

### Key files

| File | Role |
|---|---|
| `src/App.jsx` | Shell: tab bar, conflict queue (left panel), conflict detail (right panel), keyboard nav |
| `src/conflict-meta.js` | Business logic: conflict type classification, priority scoring, badge styles, help text |
| `src/supabase.js` | Supabase client singleton (imported everywhere for DB access) |
| `src/VenueCandidates.jsx` | Venue deduplication workflow (approve/reject/merge candidate pairs) |
| `src/VenueCatalog.jsx` | Venue search, detail view, inline editing via `VenueEditForm` |
| `src/VenueDiscrepancies.jsx` | Manual-vs-provider field conflict review |
| `src/VenueEditForm.jsx` | Venue record editor; tracks `manually_edited_fields`, handles JSON/array fields |
| `src/EventCreateForm.jsx` | Manual event authoring; calls `VITE_API_BASE_URL` admin endpoint |

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
