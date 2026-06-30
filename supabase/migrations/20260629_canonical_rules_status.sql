-- Migration: 20260629_canonical_rules_status.sql
-- Adds lifecycle management to canonical_rules.
--
-- Changes:
--   canonical_rules:
--     + status           text  NOT NULL DEFAULT 'active'  CHECK ('active','disabled')
--     + updated_by       text  (actor who last mutated the rule, server-derived)
--     + disabled_reason  text  (required when status → 'disabled')
--     + previous_geo_entity_id text (snapshot of geo_entity_id before a correction)
--
-- New RPCs (service_role only):
--   disable_rule(p_rule_id bigint, p_reason text, p_actor text) → jsonb
--   enable_rule(p_rule_id  bigint, p_actor text)                → jsonb
--   correct_rule(p_rule_id bigint, p_new_geo_entity_id text, p_reason text, p_actor text) → jsonb
--
-- Safari pipeline must add .neq('status','disabled') to fetchRules() query
-- after this migration is applied (see rule-registry.js change).
--
-- Rollback: ALTER TABLE DROP COLUMN for each added column; DROP FUNCTION for each RPC.
-- ============================================================

-- ── 1. Schema additions ──────────────────────────────────────────────────────

ALTER TABLE canonical_rules
  ADD COLUMN IF NOT EXISTS status               text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS updated_by           text,
  ADD COLUMN IF NOT EXISTS disabled_reason      text,
  ADD COLUMN IF NOT EXISTS previous_geo_entity_id text REFERENCES geo_entities(id);

ALTER TABLE canonical_rules
  DROP CONSTRAINT IF EXISTS canonical_rules_status_check;

ALTER TABLE canonical_rules
  ADD CONSTRAINT canonical_rules_status_check
    CHECK (status IN ('active', 'disabled'));

-- Index for efficient filtering of active rules (the hot path)
CREATE INDEX IF NOT EXISTS canonical_rules_status_idx ON canonical_rules(status)
  WHERE status = 'active';

-- ── 2. disable_rule ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.disable_rule(
  p_rule_id bigint,
  p_reason  text,
  p_actor   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rule canonical_rules%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'missing_reason::a reason is required to disable a rule';
  END IF;

  SELECT * INTO v_rule
  FROM canonical_rules
  WHERE id = p_rule_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::rule % not found', p_rule_id;
  END IF;

  IF v_rule.status = 'disabled' THEN
    RAISE EXCEPTION 'already_disabled::rule % is already disabled', p_rule_id;
  END IF;

  UPDATE canonical_rules SET
    status          = 'disabled',
    disabled_reason = p_reason,
    updated_by      = p_actor,
    updated_at      = now()
  WHERE id = p_rule_id;

  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (p_actor, 'rule_disabled', 'canonical_rule', p_rule_id::text,
          jsonb_build_object(
            'rule_id',          p_rule_id,
            'prior_status',     v_rule.status,
            'reason',           p_reason,
            'match_raw_location', v_rule.match_raw_location,
            'match_provider',   v_rule.match_provider,
            'geo_entity_id',    v_rule.geo_entity_id
          ));

  RETURN jsonb_build_object(
    'ok',        true,
    'rule_id',   p_rule_id,
    'status',    'disabled'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.disable_rule(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.disable_rule(bigint, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.disable_rule(bigint, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.disable_rule(bigint, text, text) TO service_role;

-- ── 3. enable_rule ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enable_rule(
  p_rule_id bigint,
  p_actor   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rule canonical_rules%ROWTYPE;
BEGIN
  SELECT * INTO v_rule
  FROM canonical_rules
  WHERE id = p_rule_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::rule % not found', p_rule_id;
  END IF;

  IF v_rule.status = 'active' THEN
    RAISE EXCEPTION 'already_active::rule % is already active', p_rule_id;
  END IF;

  UPDATE canonical_rules SET
    status          = 'active',
    disabled_reason = NULL,
    updated_by      = p_actor,
    updated_at      = now()
  WHERE id = p_rule_id;

  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (p_actor, 'rule_enabled', 'canonical_rule', p_rule_id::text,
          jsonb_build_object(
            'rule_id',          p_rule_id,
            'prior_status',     v_rule.status,
            'match_raw_location', v_rule.match_raw_location,
            'match_provider',   v_rule.match_provider,
            'geo_entity_id',    v_rule.geo_entity_id
          ));

  RETURN jsonb_build_object(
    'ok',      true,
    'rule_id', p_rule_id,
    'status',  'active'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enable_rule(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enable_rule(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.enable_rule(bigint, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.enable_rule(bigint, text) TO service_role;

-- ── 4. correct_rule ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.correct_rule(
  p_rule_id           bigint,
  p_new_geo_entity_id text,
  p_reason            text,
  p_actor             text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rule canonical_rules%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'missing_reason::a reason is required to correct a rule';
  END IF;

  IF p_new_geo_entity_id IS NULL OR trim(p_new_geo_entity_id) = '' THEN
    RAISE EXCEPTION 'missing_geo_entity_id::new geo_entity_id is required';
  END IF;

  SELECT * INTO v_rule
  FROM canonical_rules
  WHERE id = p_rule_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found::rule % not found', p_rule_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM geo_entities WHERE id = p_new_geo_entity_id AND status = 'active') THEN
    RAISE EXCEPTION 'not_found::geo_entity % not found or inactive', p_new_geo_entity_id;
  END IF;

  IF v_rule.geo_entity_id = p_new_geo_entity_id THEN
    RAISE EXCEPTION 'no_change::new geo_entity_id is the same as current';
  END IF;

  UPDATE canonical_rules SET
    previous_geo_entity_id = v_rule.geo_entity_id,
    geo_entity_id          = p_new_geo_entity_id,
    status                 = 'active',
    updated_by             = p_actor,
    updated_at             = now(),
    version                = version + 1
  WHERE id = p_rule_id;

  INSERT INTO editorial_actions(actor, action_type, entity_type, entity_id, after_state)
  VALUES (p_actor, 'rule_corrected', 'canonical_rule', p_rule_id::text,
          jsonb_build_object(
            'rule_id',             p_rule_id,
            'previous_geo_entity_id', v_rule.geo_entity_id,
            'new_geo_entity_id',   p_new_geo_entity_id,
            'reason',              p_reason,
            'match_raw_location',  v_rule.match_raw_location,
            'match_provider',      v_rule.match_provider
          ));

  RETURN jsonb_build_object(
    'ok',                      true,
    'rule_id',                 p_rule_id,
    'previous_geo_entity_id',  v_rule.geo_entity_id,
    'geo_entity_id',           p_new_geo_entity_id,
    'status',                  'active'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.correct_rule(bigint, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.correct_rule(bigint, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.correct_rule(bigint, text, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.correct_rule(bigint, text, text, text) TO service_role;

-- ── Verification ─────────────────────────────────────────────────────────────
-- Check new columns exist:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'canonical_rules'
--   ORDER BY ordinal_position;
--
-- Check RPCs are service_role-only:
--   SELECT p.proname, a.grantee::text
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
--   WHERE n.nspname = 'public' AND p.proname IN ('disable_rule','enable_rule','correct_rule')
--   ORDER BY p.proname, a.grantee;
