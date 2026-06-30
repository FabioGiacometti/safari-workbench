-- Migration: 20260630_create_manual_venue_fix_slug.sql
-- Replaces unaccent() (not installed) with translate() for Spanish/Latin accent handling
-- in fingerprint slug generation. All other logic identical to fix_required_cols.
-- This is the final version of create_manual_venue for Loop 1.

CREATE OR REPLACE FUNCTION public.create_manual_venue(
  p_fields          jsonb,
  p_actor           text,
  p_override_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canonical_name    text             := NULL;
  v_aliases           text[]           := NULL;
  v_city              text             := NULL;
  v_region            text             := NULL;
  v_lat               double precision := NULL;
  v_lng               double precision := NULL;
  v_address           text             := NULL;
  v_image_url         text             := NULL;
  v_description       text             := NULL;
  v_social_links      jsonb            := NULL;
  v_category          text             := NULL;
  v_capacity          integer          := NULL;
  v_accessibility     text             := NULL;
  v_geo_entity_id     text             := NULL;
  v_has_aliases       boolean := FALSE;
  v_has_city          boolean := FALSE;
  v_has_region        boolean := FALSE;
  v_has_lat           boolean := FALSE;
  v_has_lng           boolean := FALSE;
  v_has_address       boolean := FALSE;
  v_has_image_url     boolean := FALSE;
  v_has_description   boolean := FALSE;
  v_has_social_links  boolean := FALSE;
  v_has_category      boolean := FALSE;
  v_has_capacity      boolean := FALSE;
  v_has_accessibility boolean := FALSE;
  v_has_geo_entity_id boolean := FALSE;
  v_key          text;
  v_val_raw      jsonb;
  v_elem         jsonb;
  v_elem_text    text;
  v_seen         text[];
  v_result       text[];
  v_cap_num      numeric;
  v_mef          text[]  := '{}';
  v_new_id       uuid;
  v_fingerprint  text;
  v_fp_base      text;
  v_fp_counter   integer := 2;
  v_allowed_keys text[] := ARRAY[
    'canonical_name','aliases','city','region',
    'lat','lng','address','image_url','description',
    'social_links','category','capacity','accessibility',
    'geo_entity_id'
  ];
BEGIN
  -- 0. Validate actor
  IF p_actor IS NULL OR trim(p_actor) = '' THEN
    RAISE EXCEPTION 'invalid actor::must not be empty';
  END IF;

  -- 1. Validate input presence
  IF p_fields IS NULL OR p_fields = '{}'::jsonb THEN
    RAISE EXCEPTION 'empty fields::no fields provided';
  END IF;

  -- 2. Reject unknown keys
  FOR v_key IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN
      RAISE EXCEPTION 'unknown field:%:not in allowed list', v_key;
    END IF;
  END LOOP;

  -- 3. Require canonical_name
  IF NOT (p_fields ? 'canonical_name') THEN
    RAISE EXCEPTION 'required:canonical_name:canonical_name is required';
  END IF;

  -- 4. Extract and validate fields
  v_val_raw := p_fields -> 'canonical_name';
  IF v_val_raw = 'null'::jsonb THEN
    RAISE EXCEPTION 'invalid_value:canonical_name:must not be null';
  END IF;
  IF jsonb_typeof(v_val_raw) != 'string' THEN
    RAISE EXCEPTION 'invalid_type:canonical_name:expected string, got %', jsonb_typeof(v_val_raw);
  END IF;
  v_canonical_name := trim(v_val_raw #>> '{}');
  IF v_canonical_name = '' THEN
    RAISE EXCEPTION 'invalid_value:canonical_name:must not be empty';
  END IF;
  IF length(v_canonical_name) > 500 THEN
    RAISE EXCEPTION 'invalid_value:canonical_name:exceeds 500 characters';
  END IF;

  IF p_fields ? 'aliases' THEN
    v_has_aliases := TRUE;
    v_val_raw     := p_fields -> 'aliases';
    IF v_val_raw = 'null'::jsonb THEN
      v_aliases := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'array' THEN
        RAISE EXCEPTION 'invalid_type:aliases:expected array or null';
      END IF;
      v_seen   := '{}';
      v_result := '{}';
      FOR v_elem IN SELECT jsonb_array_elements(v_val_raw) LOOP
        IF jsonb_typeof(v_elem) != 'string' THEN
          RAISE EXCEPTION 'invalid_type:aliases:all elements must be strings, got %', jsonb_typeof(v_elem);
        END IF;
        v_elem_text := trim(v_elem #>> '{}');
        CONTINUE WHEN v_elem_text = '';
        IF length(v_elem_text) > 500 THEN
          RAISE EXCEPTION 'invalid_value:aliases:entry exceeds 500 characters: "%"', left(v_elem_text, 40) || '...';
        END IF;
        CONTINUE WHEN lower(v_elem_text) = ANY(v_seen);
        CONTINUE WHEN lower(v_elem_text) = lower(v_canonical_name);
        v_seen   := v_seen   || lower(v_elem_text);
        v_result := v_result || v_elem_text;
      END LOOP;
      IF array_length(v_result, 1) > 50 THEN
        RAISE EXCEPTION 'invalid_value:aliases:exceeds maximum of 50 normalized aliases';
      END IF;
      v_aliases := v_result;
    END IF;
  END IF;

  IF p_fields ? 'city' THEN
    v_has_city := TRUE;
    v_val_raw  := p_fields -> 'city';
    IF v_val_raw = 'null'::jsonb THEN
      v_city := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN
        RAISE EXCEPTION 'invalid_type:city:expected string, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_city := trim(v_val_raw #>> '{}');
      IF v_city = '' THEN v_city := NULL; END IF;
      IF length(v_city) > 200 THEN
        RAISE EXCEPTION 'invalid_value:city:exceeds 200 characters';
      END IF;
    END IF;
  END IF;

  IF p_fields ? 'region' THEN
    v_has_region := TRUE;
    v_val_raw    := p_fields -> 'region';
    IF v_val_raw = 'null'::jsonb THEN
      v_region := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN
        RAISE EXCEPTION 'invalid_type:region:expected string, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_region := trim(v_val_raw #>> '{}');
      IF v_region = '' THEN v_region := NULL; END IF;
      IF length(v_region) > 200 THEN
        RAISE EXCEPTION 'invalid_value:region:exceeds 200 characters';
      END IF;
    END IF;
  END IF;

  IF p_fields ? 'lat' THEN
    v_has_lat := TRUE;
    v_val_raw  := p_fields -> 'lat';
    IF v_val_raw = 'null'::jsonb THEN
      v_lat := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'number' THEN
        RAISE EXCEPTION 'invalid_type:lat:expected number, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_lat := (v_val_raw #>> '{}')::double precision;
      IF v_lat < -90 OR v_lat > 90 THEN
        RAISE EXCEPTION 'invalid_value:lat:must be between -90 and 90, got %', v_lat;
      END IF;
    END IF;
  END IF;

  IF p_fields ? 'lng' THEN
    v_has_lng := TRUE;
    v_val_raw  := p_fields -> 'lng';
    IF v_val_raw = 'null'::jsonb THEN
      v_lng := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'number' THEN
        RAISE EXCEPTION 'invalid_type:lng:expected number, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_lng := (v_val_raw #>> '{}')::double precision;
      IF v_lng < -180 OR v_lng > 180 THEN
        RAISE EXCEPTION 'invalid_value:lng:must be between -180 and 180, got %', v_lng;
      END IF;
    END IF;
  END IF;

  IF (v_has_lat AND NOT v_has_lng) OR (v_has_lng AND NOT v_has_lat) THEN
    RAISE EXCEPTION 'invalid_coordinates::lat and lng must both be provided together';
  END IF;
  IF v_has_lat AND v_has_lng AND (v_lat IS NULL OR v_lng IS NULL) THEN
    RAISE EXCEPTION 'invalid_coordinates::lat and lng must both be valid numbers when setting coordinates';
  END IF;

  IF p_fields ? 'address' THEN
    v_has_address := TRUE;
    v_val_raw := p_fields -> 'address';
    IF v_val_raw = 'null'::jsonb THEN v_address := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN RAISE EXCEPTION 'invalid_type:address:expected string, got %', jsonb_typeof(v_val_raw); END IF;
      v_address := trim(v_val_raw #>> '{}');
      IF v_address = '' THEN v_address := NULL; END IF;
      IF length(v_address) > 500 THEN RAISE EXCEPTION 'invalid_value:address:exceeds 500 characters'; END IF;
    END IF;
  END IF;

  IF p_fields ? 'image_url' THEN
    v_has_image_url := TRUE;
    v_val_raw := p_fields -> 'image_url';
    IF v_val_raw = 'null'::jsonb THEN v_image_url := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN RAISE EXCEPTION 'invalid_type:image_url:expected string, got %', jsonb_typeof(v_val_raw); END IF;
      v_image_url := trim(v_val_raw #>> '{}');
      IF v_image_url = '' THEN v_image_url := NULL; END IF;
      IF length(v_image_url) > 2048 THEN RAISE EXCEPTION 'invalid_value:image_url:exceeds 2048 characters'; END IF;
    END IF;
  END IF;

  IF p_fields ? 'description' THEN
    v_has_description := TRUE;
    v_val_raw := p_fields -> 'description';
    IF v_val_raw = 'null'::jsonb THEN v_description := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN RAISE EXCEPTION 'invalid_type:description:expected string, got %', jsonb_typeof(v_val_raw); END IF;
      v_description := v_val_raw #>> '{}';
      IF v_description = '' THEN v_description := NULL; END IF;
      IF length(v_description) > 5000 THEN RAISE EXCEPTION 'invalid_value:description:exceeds 5000 characters'; END IF;
    END IF;
  END IF;

  IF p_fields ? 'social_links' THEN
    v_has_social_links := TRUE;
    v_val_raw := p_fields -> 'social_links';
    IF v_val_raw = 'null'::jsonb THEN v_social_links := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'object' THEN RAISE EXCEPTION 'invalid_type:social_links:expected JSON object or null, got %', jsonb_typeof(v_val_raw); END IF;
      v_social_links := v_val_raw;
    END IF;
  END IF;

  IF p_fields ? 'category' THEN
    v_has_category := TRUE;
    v_val_raw := p_fields -> 'category';
    IF v_val_raw = 'null'::jsonb THEN v_category := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN RAISE EXCEPTION 'invalid_type:category:expected string, got %', jsonb_typeof(v_val_raw); END IF;
      v_category := trim(v_val_raw #>> '{}');
      IF v_category = '' THEN v_category := NULL; END IF;
      IF length(v_category) > 200 THEN RAISE EXCEPTION 'invalid_value:category:exceeds 200 characters'; END IF;
    END IF;
  END IF;

  IF p_fields ? 'capacity' THEN
    v_has_capacity := TRUE;
    v_val_raw := p_fields -> 'capacity';
    IF v_val_raw = 'null'::jsonb THEN v_capacity := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'number' THEN RAISE EXCEPTION 'invalid_type:capacity:expected number, got %', jsonb_typeof(v_val_raw); END IF;
      v_cap_num := (v_val_raw #>> '{}')::numeric;
      IF v_cap_num != floor(v_cap_num) THEN RAISE EXCEPTION 'invalid_value:capacity:must be an integer, got %', v_cap_num; END IF;
      IF v_cap_num < 0 THEN RAISE EXCEPTION 'invalid_value:capacity:must be non-negative'; END IF;
      IF v_cap_num > 2000000 THEN RAISE EXCEPTION 'invalid_value:capacity:exceeds maximum of 2000000'; END IF;
      v_capacity := v_cap_num::integer;
    END IF;
  END IF;

  IF p_fields ? 'accessibility' THEN
    v_has_accessibility := TRUE;
    v_val_raw := p_fields -> 'accessibility';
    IF v_val_raw = 'null'::jsonb THEN v_accessibility := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN RAISE EXCEPTION 'invalid_type:accessibility:expected string, got %', jsonb_typeof(v_val_raw); END IF;
      v_accessibility := trim(v_val_raw #>> '{}');
      IF v_accessibility = '' THEN v_accessibility := NULL; END IF;
      IF length(v_accessibility) > 2000 THEN RAISE EXCEPTION 'invalid_value:accessibility:exceeds 2000 characters'; END IF;
    END IF;
  END IF;

  IF p_fields ? 'geo_entity_id' THEN
    v_has_geo_entity_id := TRUE;
    v_val_raw := p_fields -> 'geo_entity_id';
    IF v_val_raw = 'null'::jsonb THEN v_geo_entity_id := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN RAISE EXCEPTION 'invalid_type:geo_entity_id:expected string or null, got %', jsonb_typeof(v_val_raw); END IF;
      v_geo_entity_id := trim(v_val_raw #>> '{}');
      IF v_geo_entity_id = '' THEN RAISE EXCEPTION 'invalid_value:geo_entity_id:must not be empty string; pass null to clear'; END IF;
      IF NOT EXISTS (SELECT 1 FROM geo_entities WHERE id = v_geo_entity_id AND status = 'active') THEN
        RAISE EXCEPTION 'invalid_value:geo_entity_id:entity % not found or not active', v_geo_entity_id;
      END IF;
    END IF;
  END IF;

  -- 5. Duplicate check
  IF EXISTS (
    SELECT 1 FROM venues
    WHERE merged_into IS NULL
      AND lower(trim(canonical_name)) = lower(v_canonical_name)
      AND ((v_city IS NULL AND city IS NULL) OR (v_city IS NOT NULL AND lower(city) = lower(v_city)))
  ) THEN
    IF p_override_reason IS NULL OR trim(p_override_reason) = '' THEN
      RAISE EXCEPTION 'duplicate_venue::an active venue with the same name and city already exists; supply override_reason to proceed';
    END IF;
  END IF;

  -- 6. Build manually_edited_fields
  v_mef := array_append(v_mef, 'canonical_name');
  IF v_has_aliases      AND v_aliases      IS NOT NULL THEN v_mef := array_append(v_mef, 'aliases');       END IF;
  IF v_has_city         AND v_city         IS NOT NULL THEN v_mef := array_append(v_mef, 'city');          END IF;
  IF v_has_region       AND v_region       IS NOT NULL THEN v_mef := array_append(v_mef, 'region');        END IF;
  IF v_has_lat          AND v_lat          IS NOT NULL THEN v_mef := array_append(v_mef, 'lat');           END IF;
  IF v_has_lng          AND v_lng          IS NOT NULL THEN v_mef := array_append(v_mef, 'lng');           END IF;
  IF v_has_address      AND v_address      IS NOT NULL THEN v_mef := array_append(v_mef, 'address');       END IF;
  IF v_has_image_url    AND v_image_url    IS NOT NULL THEN v_mef := array_append(v_mef, 'image_url');     END IF;
  IF v_has_description  AND v_description  IS NOT NULL THEN v_mef := array_append(v_mef, 'description');   END IF;
  IF v_has_social_links AND v_social_links IS NOT NULL THEN v_mef := array_append(v_mef, 'social_links');  END IF;
  IF v_has_category     AND v_category     IS NOT NULL THEN v_mef := array_append(v_mef, 'category');      END IF;
  IF v_has_capacity     AND v_capacity     IS NOT NULL THEN v_mef := array_append(v_mef, 'capacity');      END IF;
  IF v_has_accessibility AND v_accessibility IS NOT NULL THEN v_mef := array_append(v_mef, 'accessibility'); END IF;
  IF v_has_geo_entity_id AND v_geo_entity_id IS NOT NULL THEN v_mef := array_append(v_mef, 'geo_entity_id'); END IF;

  -- 7. Generate fingerprint and display_name
  -- translate() handles common Spanish/Latin accents (unaccent extension not installed).
  v_fp_base :=
    regexp_replace(
      regexp_replace(
        lower(translate(
          v_canonical_name,
          'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
          'aaaaeeeeiiiioooouuuuncAAAAEEEEIIIIOOOOUUUUNC'
        )),
        '[^a-z0-9]+', '-', 'g'
      ),
      '^-+|-+$', '', 'g'
    )
    || '::'
    || CASE
         WHEN v_city IS NOT NULL THEN
           regexp_replace(
             regexp_replace(
               lower(translate(
                 v_city,
                 'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
                 'aaaaeeeeiiiioooouuuuncAAAAEEEEIIIIOOOOUUUUNC'
               )),
               '[^a-z0-9]+', '-', 'g'
             ),
             '^-+|-+$', '', 'g'
           )
         ELSE 'manual'
       END;

  -- Ensure uniqueness by appending counter suffix if fingerprint already exists.
  v_fingerprint := v_fp_base;
  WHILE EXISTS (SELECT 1 FROM venues WHERE fingerprint = v_fingerprint) LOOP
    v_fingerprint := v_fp_base || '-' || v_fp_counter;
    v_fp_counter  := v_fp_counter + 1;
  END LOOP;

  -- 8. INSERT
  INSERT INTO venues (
    canonical_name, display_name, fingerprint, aliases,
    city, region, lat, lng, address, image_url, description,
    social_links, category, capacity, accessibility, geo_entity_id,
    manually_edited_fields, origin, created_by
  )
  VALUES (
    v_canonical_name, v_canonical_name, v_fingerprint, COALESCE(v_aliases, '{}'),
    v_city, v_region, v_lat, v_lng, v_address, v_image_url, v_description,
    v_social_links, v_category, v_capacity, v_accessibility, v_geo_entity_id,
    v_mef, 'workbench', p_actor
  )
  RETURNING id INTO v_new_id;

  -- 9. Audit
  INSERT INTO editorial_actions (actor, action_type, entity_type, entity_id, after_state, notes)
  VALUES (
    p_actor, 'venue_manually_created', 'venue', v_new_id::text,
    jsonb_build_object(
      'venue_id', v_new_id, 'canonical_name', v_canonical_name,
      'fingerprint', v_fingerprint, 'city', v_city, 'origin', 'workbench',
      'fields_provided', to_jsonb(v_mef)
    ),
    CASE WHEN p_override_reason IS NOT NULL AND trim(p_override_reason) != ''
         THEN 'override_reason: ' || trim(p_override_reason) ELSE NULL END
  );

  RETURN jsonb_build_object('ok', TRUE, 'venue_id', v_new_id, 'fingerprint', v_fingerprint);

EXCEPTION
  WHEN OTHERS THEN RAISE;
END;
$$;

REVOKE ALL     ON FUNCTION public.create_manual_venue(jsonb, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_manual_venue(jsonb, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_manual_venue(jsonb, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.create_manual_venue(jsonb, text, text) TO service_role;
