-- Acceptance-test cleanup: restore manually_edited_fields for test venue
-- Reason: acceptance testing wrote to aliases, lat, lng on venue cb099360-a384-493e-a8cf-2f9127bc35bf
-- and edit_venue correctly added those field names to manually_edited_fields (additive by design).
-- The field values themselves were restored via the API, but the ownership markers remain.
-- This narrowly-scoped UPDATE removes only the test residue from manually_edited_fields.
-- No editable value is changed. No other venue is affected. Audit log is preserved.
-- ROLLBACK: UPDATE venues SET manually_edited_fields = ARRAY['aliases','lat','lng'] WHERE id = 'cb099360-a384-493e-a8cf-2f9127bc35bf';

BEGIN;

DO $$
DECLARE
  v   venues%ROWTYPE;
  affected integer;
BEGIN
  -- 1. Verify the exact venue exists
  SELECT * INTO v FROM venues WHERE id = 'cb099360-a384-493e-a8cf-2f9127bc35bf';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ABORT: test venue cb099360 not found';
  END IF;

  -- 2. Verify field values match the restored operational snapshot
  IF v.canonical_name IS DISTINCT FROM 'Teatro del Libertador General San Martín' THEN
    RAISE EXCEPTION 'ABORT: canonical_name mismatch: %', v.canonical_name;
  END IF;
  IF v.city IS DISTINCT FROM 'córdoba' THEN
    RAISE EXCEPTION 'ABORT: city mismatch: %', v.city;
  END IF;
  IF v.aliases IS DISTINCT FROM ARRAY[]::text[] AND v.aliases IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: aliases not empty: %', v.aliases;
  END IF;
  IF abs(v.lat - (-31.4192134)) > 0.000001 THEN
    RAISE EXCEPTION 'ABORT: lat mismatch: %', v.lat;
  END IF;
  IF abs(v.lng - (-64.1879086)) > 0.000001 THEN
    RAISE EXCEPTION 'ABORT: lng mismatch: %', v.lng;
  END IF;
  IF v.description IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: description not null: %', v.description;
  END IF;
  IF v.address IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: address not null: %', v.address;
  END IF;
  IF v.capacity IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: capacity not null: %', v.capacity;
  END IF;

  -- 3. Verify current mef is exactly the expected test residue
  IF v.manually_edited_fields IS DISTINCT FROM ARRAY['aliases','lat','lng'] THEN
    RAISE EXCEPTION 'ABORT: manually_edited_fields is not the expected test residue: %',
      array_to_string(v.manually_edited_fields, ',');
  END IF;

  -- 4. Update only manually_edited_fields
  UPDATE venues
     SET manually_edited_fields = ARRAY[]::text[]
   WHERE id = 'cb099360-a384-493e-a8cf-2f9127bc35bf';

  GET DIAGNOSTICS affected = ROW_COUNT;

  -- 5. Verify exactly one row affected
  IF affected <> 1 THEN
    RAISE EXCEPTION 'ABORT: expected 1 row affected, got %', affected;
  END IF;

  RAISE NOTICE 'OK: manually_edited_fields reset to [] for venue cb099360';
END;
$$;

COMMIT;
