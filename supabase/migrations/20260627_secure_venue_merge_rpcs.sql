-- Migration: 20260627_secure_venue_merge_rpcs
-- Purpose:   Close direct RPC execution of merge_venue_pair and rollback_venue_merge
--            from PUBLIC / anon / authenticated. Only service_role may call them.
--            The existing Workbench UI still works during transition because it
--            uses VITE_SUPABASE_KEY (service-role) directly in the browser.
--
-- Idempotent: REVOKE IF EXISTS is not a thing in PG, but REVOKE on a non-held
--             privilege is a no-op, so re-running is safe.
--
-- No data changes. No function body changes. Grants only.
--
-- Rollback instructions (run in SQL Editor to revert):
--   GRANT EXECUTE ON FUNCTION public.merge_venue_pair(uuid, text)      TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.rollback_venue_merge(uuid, text)  TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.merge_venue_pair(uuid, text)      TO anon;
--   GRANT EXECUTE ON FUNCTION public.rollback_venue_merge(uuid, text)  TO anon;
--   GRANT EXECUTE ON FUNCTION public.merge_venue_pair(uuid, text)      TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.rollback_venue_merge(uuid, text)  TO authenticated;

-- ── Revoke from PUBLIC (covers any role not explicitly granted) ──────────────
REVOKE EXECUTE ON FUNCTION public.merge_venue_pair(uuid, text)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rollback_venue_merge(uuid, text) FROM PUBLIC;

-- ── Revoke from anon (unauthenticated PostgREST role) ────────────────────────
REVOKE EXECUTE ON FUNCTION public.merge_venue_pair(uuid, text)     FROM anon;
REVOKE EXECUTE ON FUNCTION public.rollback_venue_merge(uuid, text) FROM anon;

-- ── Revoke from authenticated (logged-in PostgREST role) ─────────────────────
REVOKE EXECUTE ON FUNCTION public.merge_venue_pair(uuid, text)     FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rollback_venue_merge(uuid, text) FROM authenticated;

-- ── Ensure service_role retains EXECUTE ──────────────────────────────────────
-- (Already granted per information_schema.routine_privileges; belt-and-suspenders.)
GRANT EXECUTE ON FUNCTION public.merge_venue_pair(uuid, text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.rollback_venue_merge(uuid, text) TO service_role;

-- ── Verification queries (run after applying to confirm) ─────────────────────
-- Expected: only postgres (grantable) and service_role rows remain.
--
-- SELECT routine_name, grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_name IN ('merge_venue_pair', 'rollback_venue_merge')
--   AND routine_schema = 'public'
-- ORDER BY routine_name, grantee;
--
-- Expected result:
--   merge_venue_pair     | postgres     | EXECUTE
--   merge_venue_pair     | service_role | EXECUTE
--   rollback_venue_merge | postgres     | EXECUTE
--   rollback_venue_merge | service_role | EXECUTE
