-- Migration: 20260627_conflict_rpcs.sql
-- Creates four service-role-only atomic RPCs for Conflict Queue operations.
-- All RPCs are SECURITY INVOKER with explicit search_path.
-- Permissions: revoked from PUBLIC/anon/authenticated, granted to service_role only.
--
-- RPCs created:
--   transition_conflict(bigint, text, text)              -- in_review / dismiss / provider_bug
--   resolve_conflict_with_rule(bigint, text, text, text) -- rule creation + resolve
--   resolve_conflict_venue_geo(bigint, text, text)       -- VENUE_WITHOUT_GEO fix
--   resolve_conflict_discovery(bigint, text, text)       -- GEO_ENTITY_DISCOVERY approve/reject
--
-- Rollback: DROP FUNCTION for each. No data changes.
-- ============================================================

-- ── 1. transition_conflict ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transition_conflict(
  p_conflict_id bigint,
  p_action      text,
  p_actor       text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conflict   resolution_conflicts%ROWTYPE;
  v_new_status text;
  v_audit_type text;
BEGIN
  IF p_action NOT IN ('in_review', 'dismiss', 'provider_bug') THEN
    RAISE EXCEPTION 'invalid_action::action must be in_review, dismiss, or provider_bug';
  END IF;

  SELECT * INTO v_conflict
  FROM resolution_conflicts
  WHERE id = p_conflict_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::conflict % not found', p_conflict_id;
  END IF;

  IF v_conflict.status NOT IN ('open', 'in_review', 'resolution_failed') THEN
    RAISE EXCEPTION 'invalid_transition::conflict is % — only open/in_review/resolution_failed can be transitioned', v_conflict.status;
  END IF;

  IF p_action = 'in_review' AND v_conflict.status = 'in_review' THEN
    RAISE EXCEPTION 'invalid_transition::conflict is already in_review';
  END IF;

  v_new_status := CASE p_action
    WHEN 'in_review'    THEN 'in_review'
    WHEN 'dismiss'      THEN 'dismissed'
    WHEN 'provider_bug' THEN 'provider_bug'
  END;

  v_audit_type := CASE p_action
    WHEN 'in_review'    THEN 'conflict_in_review'
    WHEN 'dismiss'      THEN 'conflict_dismissed'
    WHEN 'provider_bug' THEN 'conflict_provider_bug'
  END;

  UPDATE resolution_conflicts SET
    status               = v_new_status,
    editorial_updated_at = now(),
    resolved_by = CASE WHEN p_action IN ('dismiss', 'provider_bug') THEN p_actor ELSE resolved_by END,
    resolved_at = CASE WHEN p_action IN ('dismiss', 'provider_bug') THEN now()    ELSE resolved_at END
  WHERE id = p_conflict_id;

  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (p_actor, v_audit_type, 'conflict', p_conflict_id::text,
          jsonb_build_object('new_status', v_new_status, 'conflict_id', p_conflict_id));

  RETURN jsonb_build_object('ok', true, 'status', v_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_conflict(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_conflict(bigint, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.transition_conflict(bigint, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.transition_conflict(bigint, text, text) TO service_role;

-- ── 2. resolve_conflict_with_rule ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_conflict_with_rule(
  p_conflict_id    bigint,
  p_geo_entity_id  text,
  p_provider_scope text,
  p_actor          text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conflict     resolution_conflicts%ROWTYPE;
  v_rule_id      integer;
BEGIN
  SELECT * INTO v_conflict
  FROM resolution_conflicts
  WHERE id = p_conflict_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::conflict % not found', p_conflict_id;
  END IF;

  IF v_conflict.conflict_type NOT IN (
      'UNMATCHED', 'GEO_AMBIGUOUS', 'VENUE_GEO_MISMATCH', 'LOW_CONFIDENCE_GEO', 'ORPHAN_CITY'
  ) THEN
    RAISE EXCEPTION 'wrong_conflict_type::conflict type % cannot be resolved with a canonical rule', v_conflict.conflict_type;
  END IF;

  IF v_conflict.raw_value IS NULL OR trim(v_conflict.raw_value) = '' THEN
    RAISE EXCEPTION 'no_rule_possible::conflict has no raw_value';
  END IF;

  IF v_conflict.status NOT IN ('open', 'in_review', 'resolution_failed') THEN
    RAISE EXCEPTION 'invalid_transition::conflict is % — cannot resolve', v_conflict.status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM geo_entities WHERE id = p_geo_entity_id AND status = 'active') THEN
    RAISE EXCEPTION 'not_found::geo_entity % not found or inactive', p_geo_entity_id;
  END IF;

  INSERT INTO canonical_rules(
    match_raw_location, match_provider, geo_entity_id,
    type, scope, confidence, source, resolution_mode,
    created_by, updated_at
  )
  VALUES (
    v_conflict.raw_value, p_provider_scope, p_geo_entity_id,
    'GEO_OVERRIDE', 'match_pattern', 1.0, 'workbench', 'manual_override',
    p_actor, now()
  )
  ON CONFLICT (match_raw_location, match_provider)
  DO UPDATE SET
    geo_entity_id = EXCLUDED.geo_entity_id,
    created_by    = EXCLUDED.created_by,
    updated_at    = now()
  RETURNING id INTO v_rule_id;

  UPDATE resolution_conflicts SET
    status                 = 'resolved',
    resolved_geo_entity_id = p_geo_entity_id,
    resolved_at            = now(),
    resolved_by            = p_actor,
    editorial_updated_at   = now()
  WHERE id = p_conflict_id;

  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (p_actor, 'conflict_resolved_rule', 'conflict', p_conflict_id::text,
          jsonb_build_object(
            'geo_entity_id',  p_geo_entity_id,
            'provider_scope', p_provider_scope,
            'rule_id',        v_rule_id,
            'conflict_type',  v_conflict.conflict_type
          ));

  RETURN jsonb_build_object(
    'ok',            true,
    'status',        'resolved',
    'rule_id',       v_rule_id,
    'geo_entity_id', p_geo_entity_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_conflict_with_rule(bigint, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_conflict_with_rule(bigint, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_conflict_with_rule(bigint, text, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_conflict_with_rule(bigint, text, text, text) TO service_role;

-- ── 3. resolve_conflict_venue_geo ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_conflict_venue_geo(
  p_conflict_id   bigint,
  p_geo_entity_id text,
  p_actor         text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conflict  resolution_conflicts%ROWTYPE;
  v_venue_id  uuid;
BEGIN
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

  IF v_conflict.status NOT IN ('open', 'in_review', 'resolution_failed') THEN
    RAISE EXCEPTION 'invalid_transition::conflict is % — cannot resolve', v_conflict.status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM geo_entities WHERE id = p_geo_entity_id AND status = 'active') THEN
    RAISE EXCEPTION 'not_found::geo_entity % not found or inactive', p_geo_entity_id;
  END IF;

  -- Derive venue UUID from first sample event that has a venue_id.
  -- The browser never supplies a venue ID; the conflict row is the sole authority.
  SELECT e.venue_id INTO v_venue_id
  FROM unnest(v_conflict.sample_event_ids) AS s(event_id)
  JOIN events e ON e.id = s.event_id
  WHERE e.venue_id IS NOT NULL
  LIMIT 1;

  IF v_venue_id IS NULL THEN
    RAISE EXCEPTION 'venue_not_found::no venue derivable from conflict % sample events', p_conflict_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM venues WHERE id = v_venue_id) THEN
    RAISE EXCEPTION 'venue_not_found::venue % not found', v_venue_id;
  END IF;

  UPDATE venues
  SET geo_entity_id = p_geo_entity_id
  WHERE id = v_venue_id;

  UPDATE resolution_conflicts SET
    status                 = 'resolved',
    resolved_geo_entity_id = p_geo_entity_id,
    resolved_venue_id      = v_venue_id,
    resolved_at            = now(),
    resolved_by            = p_actor,
    editorial_updated_at   = now()
  WHERE id = p_conflict_id;

  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (p_actor, 'conflict_resolved_venue_geo', 'conflict', p_conflict_id::text,
          jsonb_build_object(
            'venue_id',      v_venue_id,
            'geo_entity_id', p_geo_entity_id
          ));

  RETURN jsonb_build_object(
    'ok',            true,
    'status',        'resolved',
    'venue_id',      v_venue_id,
    'geo_entity_id', p_geo_entity_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_conflict_venue_geo(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_conflict_venue_geo(bigint, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_conflict_venue_geo(bigint, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_conflict_venue_geo(bigint, text, text) TO service_role;

-- ── 4. resolve_conflict_discovery ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_conflict_discovery(
  p_conflict_id bigint,
  p_action      text,
  p_actor       text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conflict         resolution_conflicts%ROWTYPE;
  v_city_name        text;
  v_norm_name        text;
  v_candidate_id     integer;
  v_new_cand_status  text;
  v_new_conf_status  text;
  v_audit_type       text;
BEGIN
  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'invalid_action::action must be approve or reject';
  END IF;

  SELECT * INTO v_conflict
  FROM resolution_conflicts
  WHERE id = p_conflict_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::conflict % not found', p_conflict_id;
  END IF;

  IF v_conflict.conflict_type <> 'GEO_ENTITY_DISCOVERY' THEN
    RAISE EXCEPTION 'wrong_conflict_type::expected GEO_ENTITY_DISCOVERY, got %', v_conflict.conflict_type;
  END IF;

  IF v_conflict.status NOT IN ('open', 'in_review', 'resolution_failed') THEN
    RAISE EXCEPTION 'invalid_transition::conflict is % — cannot act', v_conflict.status;
  END IF;

  -- Normalize city name the same way as the JS client:
  -- .toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  v_city_name := coalesce(v_conflict.discovery_hints->>'city_name', v_conflict.raw_value, '');
  v_norm_name := trim(lower(regexp_replace(v_city_name, '[^a-z0-9 ]', '', 'gi')));

  IF v_norm_name = '' THEN
    RAISE EXCEPTION 'no_discovery_candidate::no city name available in conflict %', p_conflict_id;
  END IF;

  SELECT id INTO v_candidate_id
  FROM geo_entity_candidates
  WHERE normalized_name = v_norm_name
    AND status = 'pending'
  LIMIT 1;

  IF v_candidate_id IS NULL THEN
    RAISE EXCEPTION 'no_discovery_candidate::no pending geo_entity_candidate for normalized_name="%"', v_norm_name;
  END IF;

  v_new_cand_status := CASE p_action WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
  v_new_conf_status := CASE p_action WHEN 'approve' THEN 'in_review' ELSE 'dismissed' END;
  v_audit_type      := CASE p_action WHEN 'approve' THEN 'conflict_discovery_approved' ELSE 'conflict_discovery_rejected' END;

  UPDATE geo_entity_candidates
  SET status = v_new_cand_status
  WHERE id = v_candidate_id;

  UPDATE resolution_conflicts SET
    status               = v_new_conf_status,
    editorial_updated_at = now(),
    resolved_by = CASE WHEN p_action = 'reject' THEN p_actor ELSE resolved_by END,
    resolved_at = CASE WHEN p_action = 'reject' THEN now()    ELSE resolved_at END
  WHERE id = p_conflict_id;

  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (p_actor, v_audit_type, 'conflict', p_conflict_id::text,
          jsonb_build_object(
            'candidate_id', v_candidate_id,
            'norm_name',    v_norm_name,
            'new_status',   v_new_conf_status
          ));

  RETURN jsonb_build_object(
    'ok',           true,
    'status',       v_new_conf_status,
    'candidate_id', v_candidate_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_conflict_discovery(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_conflict_discovery(bigint, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_conflict_discovery(bigint, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_conflict_discovery(bigint, text, text) TO service_role;

-- ── Verification ─────────────────────────────────────────────────────────────
-- Run this to confirm all four RPCs are service_role-only:
--
-- SELECT p.proname, a.grantee::text, a.privilege_type
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
-- WHERE n.nspname = 'public'
--   AND p.proname IN (
--     'transition_conflict',
--     'resolve_conflict_with_rule',
--     'resolve_conflict_venue_geo',
--     'resolve_conflict_discovery'
--   )
-- ORDER BY p.proname, a.grantee;
--
-- Expected: only postgres + service_role for each function.
