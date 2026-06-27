-- Migration: 20260627_venue_candidate_rpcs
-- Purpose:   Three new service-role-only RPCs for the serverized VenueCandidates tab:
--
--   1. review_venue_merge_candidate  — atomic approve / reject / restore_pending
--   2. workbench_merge_venue_candidate   — merge wrapper with editorial audit
--   3. workbench_rollback_venue_merge    — rollback wrapper with editorial audit
--
-- All three:
--   • Are SECURITY INVOKER (run as the calling role — service_role)
--   • Have EXECUTE revoked from PUBLIC / anon / authenticated
--   • Accept p_actor as the verified server-session email passed by the API layer
--
-- Rollback instructions (run in SQL Editor to revert):
--   DROP FUNCTION IF EXISTS public.review_venue_merge_candidate(uuid, text, text, text);
--   DROP FUNCTION IF EXISTS public.workbench_merge_venue_candidate(uuid, text);
--   DROP FUNCTION IF EXISTS public.workbench_rollback_venue_merge(uuid, text);

-- ── 1. review_venue_merge_candidate ──────────────────────────────────────────
--
-- Allowed actions and the transitions they enforce:
--   approve        : pending  → approved
--   reject         : pending  → rejected   (reason recorded)
--                    approved → rejected   (reason recorded)
--   restore_pending: approved → pending
--                    rejected → pending
--
-- Forbidden transitions (explicit guard):
--   any → merged         (only workbench_merge_venue_candidate may set merged)
--   any → rolled_back    (only rollback_venue_merge may set rolled_back)

CREATE OR REPLACE FUNCTION public.review_venue_merge_candidate(
  p_candidate_id uuid,
  p_action       text,   -- 'approve' | 'reject' | 'restore_pending'
  p_reason       text,   -- required for 'reject'; ignored otherwise
  p_actor        text    -- verified operator email from server session
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cand       venue_merge_candidates%ROWTYPE;
  new_status text;
  ea_action  text;
BEGIN
  -- ── Input validation ───────────────────────────────────────────────────────
  IF p_actor IS NULL OR trim(p_actor) = '' THEN
    RAISE EXCEPTION 'invalid_actor::actor must not be empty';
  END IF;

  IF p_action NOT IN ('approve', 'reject', 'restore_pending') THEN
    RAISE EXCEPTION 'invalid_action::allowed: approve, reject, restore_pending';
  END IF;

  IF p_action = 'reject' AND (p_reason IS NULL OR trim(p_reason) = '') THEN
    RAISE EXCEPTION 'missing_reason::rejection reason is required';
  END IF;

  -- ── Lock candidate row ─────────────────────────────────────────────────────
  SELECT * INTO cand
  FROM venue_merge_candidates
  WHERE id = p_candidate_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::candidate not found: %', p_candidate_id;
  END IF;

  -- ── Transition table ───────────────────────────────────────────────────────
  IF p_action = 'approve' THEN
    IF cand.status != 'pending' THEN
      RAISE EXCEPTION 'invalid_transition::approve requires pending (current: %)', cand.status;
    END IF;
    new_status := 'approved';
    ea_action  := 'candidate_approved';

  ELSIF p_action = 'reject' THEN
    IF cand.status NOT IN ('pending', 'approved') THEN
      RAISE EXCEPTION 'invalid_transition::reject requires pending or approved (current: %)', cand.status;
    END IF;
    new_status := 'rejected';
    ea_action  := 'candidate_rejected';

  ELSIF p_action = 'restore_pending' THEN
    IF cand.status NOT IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'invalid_transition::restore_pending requires approved or rejected (current: %)', cand.status;
    END IF;
    new_status := 'pending';
    ea_action  := 'candidate_restored_pending';
  END IF;

  -- ── Apply state change ─────────────────────────────────────────────────────
  UPDATE venue_merge_candidates
  SET
    status           = new_status,
    rejection_reason = CASE
                         WHEN p_action = 'reject'          THEN p_reason
                         WHEN p_action = 'restore_pending' THEN NULL
                         ELSE rejection_reason
                       END
  WHERE id = p_candidate_id;

  -- ── Atomic audit entry ─────────────────────────────────────────────────────
  INSERT INTO editorial_actions
    (actor, action_type, entity_type, entity_id, before_state, after_state, notes)
  VALUES (
    p_actor,
    ea_action,
    'venue_merge_candidate',
    p_candidate_id::text,
    jsonb_build_object('status', cand.status, 'rejection_reason', cand.rejection_reason),
    jsonb_build_object(
      'status', new_status,
      'rejection_reason', CASE WHEN p_action = 'reject' THEN p_reason ELSE NULL END
    ),
    CASE WHEN p_action = 'reject' THEN p_reason ELSE NULL END
  );

  -- ── Return authoritative state ─────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',               true,
    'candidate_id',     p_candidate_id,
    'action',           p_action,
    'previous_status',  cand.status,
    'new_status',       new_status
  );
END;
$$;

REVOKE ALL  ON FUNCTION public.review_venue_merge_candidate(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_venue_merge_candidate(uuid, text, text, text) TO service_role;


-- ── 2. workbench_merge_venue_candidate ───────────────────────────────────────
--
-- Wraps merge_venue_pair with an editorial_actions audit entry.
-- The inner RPC and the audit INSERT share the same transaction.
-- Any failure (including audit INSERT) rolls back the entire merge.

CREATE OR REPLACE FUNCTION public.workbench_merge_venue_candidate(
  p_candidate_id uuid,
  p_actor        text   -- verified operator email from server session
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cand        venue_merge_candidates%ROWTYPE;
  merge_result jsonb;
BEGIN
  -- ── Input validation ───────────────────────────────────────────────────────
  IF p_actor IS NULL OR trim(p_actor) = '' THEN
    RAISE EXCEPTION 'invalid_actor::actor must not be empty';
  END IF;

  -- ── Snapshot candidate before merge (for audit before_state) ──────────────
  SELECT * INTO cand
  FROM venue_merge_candidates
  WHERE id = p_candidate_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::candidate not found: %', p_candidate_id;
  END IF;

  -- Guard: must be approved (merge_venue_pair also checks, but fail early)
  IF cand.status != 'approved' THEN
    RAISE EXCEPTION 'invalid_status::merge requires approved (current: %)', cand.status;
  END IF;

  -- ── Call existing authoritative merge RPC ─────────────────────────────────
  -- merge_venue_pair acquires FOR UPDATE locks on candidate + both venues,
  -- reassigns events, updates venue_mutations, creates canonical_rule, sets
  -- candidate.status = 'merged'. All within this same transaction.
  SELECT public.merge_venue_pair(p_candidate_id, p_actor) INTO merge_result;

  -- ── Atomic editorial audit entry ──────────────────────────────────────────
  INSERT INTO editorial_actions
    (actor, action_type, entity_type, entity_id, before_state, after_state, notes)
  VALUES (
    p_actor,
    'venues_merged',
    'venue_merge_candidate',
    p_candidate_id::text,
    jsonb_build_object(
      'status',        cand.status,
      'venue_id_keep', cand.venue_id_keep,
      'venue_id_drop', cand.venue_id_drop
    ),
    jsonb_build_object(
      'status',           'merged',
      'affected_events',  merge_result->>'affected_events',
      'rule_id',          merge_result->>'rule_id',
      'rule_was_created', merge_result->>'rule_was_created'
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok',     true,
    'merge',  merge_result
  );
END;
$$;

REVOKE ALL  ON FUNCTION public.workbench_merge_venue_candidate(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workbench_merge_venue_candidate(uuid, text) TO service_role;


-- ── 3. workbench_rollback_venue_merge ────────────────────────────────────────
--
-- Wraps rollback_venue_merge with an editorial_actions audit entry.
-- The inner RPC and the audit INSERT share the same transaction.
-- Any failure (including audit INSERT) rolls back the entire rollback.

CREATE OR REPLACE FUNCTION public.workbench_rollback_venue_merge(
  p_candidate_id uuid,
  p_actor        text   -- verified operator email from server session
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cand            venue_merge_candidates%ROWTYPE;
  rollback_result jsonb;
BEGIN
  -- ── Input validation ───────────────────────────────────────────────────────
  IF p_actor IS NULL OR trim(p_actor) = '' THEN
    RAISE EXCEPTION 'invalid_actor::actor must not be empty';
  END IF;

  -- ── Snapshot candidate before rollback (for audit before_state) ───────────
  SELECT * INTO cand
  FROM venue_merge_candidates
  WHERE id = p_candidate_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::candidate not found: %', p_candidate_id;
  END IF;

  -- Guard: must be merged (rollback_venue_merge also checks, but fail early)
  IF cand.status != 'merged' THEN
    RAISE EXCEPTION 'invalid_status::rollback requires merged (current: %)', cand.status;
  END IF;

  -- ── Call existing authoritative rollback RPC ───────────────────────────────
  -- rollback_venue_merge restores events via venue_merge_event_log, clears
  -- merged_into/merged_at/merged_by on drop venue, optionally deletes rule,
  -- sets candidate.status = 'rolled_back'. All within this same transaction.
  SELECT public.rollback_venue_merge(p_candidate_id, p_actor) INTO rollback_result;

  -- ── Atomic editorial audit entry ──────────────────────────────────────────
  INSERT INTO editorial_actions
    (actor, action_type, entity_type, entity_id, before_state, after_state, notes)
  VALUES (
    p_actor,
    'venue_merge_rolled_back',
    'venue_merge_candidate',
    p_candidate_id::text,
    jsonb_build_object(
      'status',        'merged',
      'venue_id_keep', cand.venue_id_keep,
      'venue_id_drop', cand.venue_id_drop,
      'rule_id',       cand.created_rule_id
    ),
    jsonb_build_object(
      'status',           'rolled_back',
      'restored_events',  rollback_result->>'restored_events',
      'rule_deleted',     rollback_result->>'rule_deleted',
      'rollback_actor',   p_actor
    ),
    NULL
  );

  RETURN jsonb_build_object(
    'ok',       true,
    'rollback', rollback_result
  );
END;
$$;

REVOKE ALL  ON FUNCTION public.workbench_rollback_venue_merge(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workbench_rollback_venue_merge(uuid, text) TO service_role;
