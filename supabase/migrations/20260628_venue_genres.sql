-- Migration: 20260628_venue_genres.sql
--
-- Adds venue genre associations as the first editorially-curated genre source.
--
-- Schema:
--   genres        — controlled vocabulary (musical genres only)
--   venue_genres  — join table linking venues to genres (editorial-only)
--   set_venue_genres() RPC — atomic replace of a venue's genre set
--
-- PIPELINE INVARIANT: The scraping/sync pipeline must NEVER write to venue_genres.
-- Genre associations are manually curated editorial data owned by Workbench operators.
-- The pipeline upserts only into events and calls venue-merge/geo RPCs, none of which
-- reference this table.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.set_venue_genres(uuid, integer[], text);
--   DROP TABLE IF EXISTS public.venue_genres;
--   DROP TABLE IF EXISTS public.genres;

-- ---------------------------------------------------------------------------
-- genres: controlled vocabulary
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.genres (
  id            serial PRIMARY KEY,
  slug          text NOT NULL,
  name          text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS genres_slug_uq ON public.genres (lower(slug));

ALTER TABLE public.genres ENABLE ROW LEVEL SECURITY;
-- No RLS policies — service_role bypasses RLS entirely (same pattern as venues,
-- canonical_rules, editorial_actions).

-- Seed: initial controlled vocabulary.
-- Derived from live events.subgenre inventory (2026-06-28) and editorial judgment.
-- Musical genres only. Broad event formats (teatro, comedia, variedad) excluded.
-- 'cuarteto' included for Córdoba relevance despite absent from Ticketmaster data.
-- 'latin' retained (15 occurrences as TM subgenre; distinct from cumbia/reggaeton/tango).
-- Alphabetical tie-breaking within display_order groups.
INSERT INTO public.genres (slug, name, display_order) VALUES
  ('rock',          'Rock',          10),
  ('pop',           'Pop',           20),
  ('electronica',   'Electrónica',   30),
  ('jazz',          'Jazz',          40),
  ('clasica',       'Clásica',       50),
  ('folk-folklore', 'Folk / Folklore', 60),
  ('cumbia',        'Cumbia',        70),
  ('cuarteto',      'Cuarteto',      75),
  ('reggaeton',     'Reggaetón',     80),
  ('hip-hop',       'Hip-Hop / Rap', 90),
  ('metal',         'Metal',        100),
  ('blues',         'Blues',        110),
  ('funk-soul',     'Funk / Soul',  120),
  ('latin',         'Latin',        130),
  ('tango',         'Tango',        140),
  ('indie',         'Indie',        150)
ON CONFLICT (lower(slug)) DO NOTHING;

-- ---------------------------------------------------------------------------
-- venue_genres: editorial-only join table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.venue_genres (
  venue_id   uuid        NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  genre_id   integer     NOT NULL REFERENCES public.genres(id)  ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  PRIMARY KEY (venue_id, genre_id)
);

CREATE INDEX IF NOT EXISTS venue_genres_genre_id_idx ON public.venue_genres (genre_id);

ALTER TABLE public.venue_genres ENABLE ROW LEVEL SECURITY;
-- No RLS policies — service_role only.

-- ---------------------------------------------------------------------------
-- set_venue_genres RPC
-- Atomically replaces the genre set for a venue.
--
-- Guarantees:
--   1. Venue must exist and not be merged.
--   2. All requested genre IDs must be active.
--   3. Input IDs are deduplicated and sorted before comparison.
--   4. No-op (no write, no audit row) when old set == new set.
--   5. Atomic delete-then-insert when changed.
--   6. Records before_state and after_state in editorial_actions.
--   7. Actor is always derived server-side; never trusted from client payload.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_venue_genres(
  p_venue_id  uuid,
  p_genre_ids integer[],
  p_actor     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_venue  venues%ROWTYPE;
  v_old    integer[];
  v_new    integer[];
BEGIN
  -- 0. Validate actor (always server-derived, never client-supplied)
  IF p_actor IS NULL OR trim(p_actor) = '' THEN
    RAISE EXCEPTION 'invalid_actor::must not be empty';
  END IF;

  -- 1. Deduplicate and sort incoming IDs (stable canonical form for comparison)
  SELECT array_agg(DISTINCT gid ORDER BY gid)
    INTO v_new
    FROM unnest(COALESCE(p_genre_ids, ARRAY[]::integer[])) AS gid;
  v_new := COALESCE(v_new, ARRAY[]::integer[]);

  -- 2. Validate all requested genre IDs exist and are active
  IF array_length(v_new, 1) IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_new) AS gid
      WHERE NOT EXISTS (SELECT 1 FROM genres WHERE id = gid AND is_active = true)
    ) THEN
      RAISE EXCEPTION 'invalid_genre_id::one or more genre IDs not found or inactive';
    END IF;
  END IF;

  -- 3. Lock and validate venue
  SELECT * INTO v_venue FROM venues WHERE id = p_venue_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'venue_not_found::%', p_venue_id;
  END IF;
  IF v_venue.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'venue_is_merged::%', p_venue_id;
  END IF;

  -- 4. Snapshot current set (sorted for stable comparison)
  SELECT array_agg(genre_id ORDER BY genre_id)
    INTO v_old
    FROM venue_genres
    WHERE venue_id = p_venue_id;
  v_old := COALESCE(v_old, ARRAY[]::integer[]);

  -- 5. No-op: identical sets → no write, no audit row
  IF v_old = v_new THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'genre_ids', v_new);
  END IF;

  -- 6. Replace atomically
  DELETE FROM venue_genres WHERE venue_id = p_venue_id;
  IF array_length(v_new, 1) IS NOT NULL THEN
    INSERT INTO venue_genres (venue_id, genre_id, created_by)
    SELECT p_venue_id, gid, p_actor FROM unnest(v_new) AS gid;
  END IF;

  -- 7. Audit: before_state and after_state consistent with editorial_actions schema
  INSERT INTO editorial_actions (actor, action_type, entity_type, entity_id, before_state, after_state)
  VALUES (
    p_actor,
    'venue_genres_set',
    'venue',
    p_venue_id::text,
    jsonb_build_object('genre_ids', v_old),
    jsonb_build_object('genre_ids', v_new)
  );

  RETURN jsonb_build_object('ok', true, 'changed', true, 'genre_ids', v_new);
END;
$$;

REVOKE ALL     ON FUNCTION public.set_venue_genres(uuid, integer[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_venue_genres(uuid, integer[], text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_venue_genres(uuid, integer[], text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.set_venue_genres(uuid, integer[], text) TO service_role;

-- ---------------------------------------------------------------------------
-- Verification (run after applying, in a transaction you can roll back):
--
-- BEGIN;
-- SELECT id, slug, name FROM genres ORDER BY display_order;
-- -- Expect 16 rows
-- SELECT count(*) FROM venue_genres;
-- -- Expect 0 (no initial assignments)
-- SELECT set_venue_genres('<any-venue-uuid>', ARRAY[1,2], 'test@example.com');
-- SELECT set_venue_genres('<any-venue-uuid>', ARRAY[1,2], 'test@example.com');
-- -- Second call should return {ok:true,changed:false,...}
-- SELECT * FROM editorial_actions WHERE action_type = 'venue_genres_set';
-- -- Expect exactly 1 row (the second call was a no-op)
-- ROLLBACK;
-- ---------------------------------------------------------------------------