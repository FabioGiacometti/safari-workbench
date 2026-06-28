-- Migration: 20260628_reconcile_venue_without_geo.sql
--
-- Root cause proven from live data:
--   Conflict 51458 (VENUE_WITHOUT_GEO, edenentradas, córdoba) was operator-resolved at
--   2026-06-27T19:51:11 by fabiog.inbox@gmail.com. resolve_conflict_venue_geo RPC ran
--   atomically: set venues.geo_entity_id = 'geo::city::cordoba-ar' on ce7431a4, set
--   resolution_conflicts.status = 'resolved', wrote editorial_action 65.
--
--   The Safari pipeline re-ran at 2026-06-28T00:13:15 (4.4 hours later). The conflict
--   upsert ran again for the same (provider=edenentradas, raw_value='córdoba',
--   conflict_type=VENUE_WITHOUT_GEO) key and overwrote status = 'resolution_failed'
--   because the upsert uses ON CONFLICT DO UPDATE with a fixed status logic that does not
--   check whether the venue's geo_entity_id was already set by a prior resolution.
--   The venue itself remained correctly tagged (geo_entity_id = 'geo::city::cordoba-ar').
--   The pipeline upsert does not preserve 'resolved' status across re-runs.
--
-- This RPC provides the safe reconciliation path:
--   When a VENUE_WITHOUT_GEO conflict is open/in_review/resolution_failed and the venue
--   referenced by its sample_event_ids already has a valid active geo_entity_id, the
--   conflict state is inconsistent. This RPC transitions it to 'auto_resolved' and
--   records why, without repeating the operator's geo decision.
--
-- DOES NOT:
--   • Create a new editorial action of type 'conflict_resolved_venue_geo' (avoids duplicates)
--   • Modify venues.geo_entity_id (already correctly set)
--   • Close conflicts where the venue geo is genuinely missing
--   • Match on venue name or city text — only on the exact venue_id derived from events
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.reconcile_venue_without_geo(bigint, text);

CREATE OR REPLACE FUNCTION public.reconcile_venue_without_geo(
  p_conflict_id bigint,
  p_actor       text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conflict     resolution_conflicts%ROWTYPE;
  v_venue_id     uuid;
  v_geo_entity_id text;
BEGIN
  -- Lock the conflict row
  SELECT * INTO v_conflict
  FROM resolution_conflicts
  WHERE id = p_conflict_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::conflict % not found', p_conflict_id;
  END IF;

  IF v_conflict.conflict_type <> 'VENUE_WITHOUT_GEO' THEN
    RAISE EXCEPTION 'wrong_conflict_type::expected VENUE_WITHOUT_GEO, got %', v_conflict.conflict_type;
  END IF;

  -- Only reconcile actionable statuses — already-closed conflicts need no action
  IF v_conflict.status NOT IN ('open', 'in_review', 'resolution_failed') THEN
    RAISE EXCEPTION 'invalid_transition::conflict is % — already closed', v_conflict.status;
  END IF;

  -- Derive the exact venue from sample_event_ids (same logic as resolve_conflict_venue_geo)
  SELECT e.venue_id INTO v_venue_id
  FROM unnest(v_conflict.sample_event_ids) AS s(event_id)
  JOIN events e ON e.id = s.event_id
  WHERE e.venue_id IS NOT NULL
  LIMIT 1;

  IF v_venue_id IS NULL THEN
    RAISE EXCEPTION 'venue_not_found::no venue derivable from conflict % sample events', p_conflict_id;
  END IF;

  -- Read current geo_entity_id from the exact derived venue
  SELECT geo_entity_id INTO v_geo_entity_id
  FROM venues
  WHERE id = v_venue_id;

  -- Verify the geo entity is valid and active
  IF v_geo_entity_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM geo_entities WHERE id = v_geo_entity_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'not_satisfied::venue % geo_entity_id is null or inactive — conflict is genuine', v_venue_id;
  END IF;

  -- Transition to auto_resolved — the work was already done
  UPDATE resolution_conflicts SET
    status                 = 'auto_resolved',
    resolved_geo_entity_id = v_geo_entity_id,
    resolved_venue_id      = v_venue_id,
    editorial_updated_at   = now()
    -- resolved_at and resolved_by are intentionally NOT overwritten:
    -- they reflect the original operator resolution (editorial action 65, June 27)
  WHERE id = p_conflict_id;

  -- Audit: distinct action_type so it is clearly distinguishable from the original resolution
  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (
    p_actor,
    'conflict_auto_reconciled',
    'conflict',
    p_conflict_id::text,
    jsonb_build_object(
      'reason',          'venue_geo_already_set',
      'venue_id',        v_venue_id,
      'geo_entity_id',   v_geo_entity_id,
      'prior_status',    v_conflict.status
    )
  );

  RETURN jsonb_build_object(
    'ok',            true,
    'status',        'auto_resolved',
    'venue_id',      v_venue_id,
    'geo_entity_id', v_geo_entity_id
  );
END;
$$;

REVOKE ALL     ON FUNCTION public.reconcile_venue_without_geo(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reconcile_venue_without_geo(bigint, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reconcile_venue_without_geo(bigint, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_venue_without_geo(bigint, text) TO service_role;

-- Verification (run after applying, in a transaction you can roll back):
-- BEGIN;
-- SELECT * FROM resolution_conflicts WHERE id = 51458;
-- SELECT reconcile_venue_without_geo(51458, 'test@example.com');
-- SELECT id, status, resolved_geo_entity_id, editorial_updated_at FROM resolution_conflicts WHERE id = 51458;
-- SELECT * FROM editorial_actions WHERE entity_id = '51458' ORDER BY created_at;
-- ROLLBACK;
