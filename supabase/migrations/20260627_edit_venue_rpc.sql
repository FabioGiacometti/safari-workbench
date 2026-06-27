-- Migration: edit_venue RPC
-- Atomically edits a venue record and inserts audit log rows.
-- ROLLBACK: DROP FUNCTION IF EXISTS public.edit_venue(uuid, jsonb, text);

CREATE OR REPLACE FUNCTION public.edit_venue(
  p_venue_id uuid,
  p_fields   jsonb,
  p_actor    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v                    venues%ROWTYPE;
  v_key                text;
  v_val_raw            jsonb;

  v_canonical_name     text             := NULL;
  v_aliases            text[]           := NULL;
  v_city               text             := NULL;
  v_region             text             := NULL;
  v_lat                double precision := NULL;
  v_lng                double precision := NULL;
  v_address            text             := NULL;
  v_image_url          text             := NULL;
  v_description        text             := NULL;
  v_social_links       jsonb            := NULL;
  v_category           text             := NULL;
  v_capacity           integer          := NULL;
  v_accessibility      text             := NULL;

  v_has_canonical_name boolean := FALSE;
  v_has_aliases        boolean := FALSE;
  v_has_city           boolean := FALSE;
  v_has_region         boolean := FALSE;
  v_has_lat            boolean := FALSE;
  v_has_lng            boolean := FALSE;
  v_has_address        boolean := FALSE;
  v_has_image_url      boolean := FALSE;
  v_has_description    boolean := FALSE;
  v_has_social_links   boolean := FALSE;
  v_has_category       boolean := FALSE;
  v_has_capacity       boolean := FALSE;
  v_has_accessibility  boolean := FALSE;

  v_diff               jsonb    := '[]'::jsonb;
  v_changes            integer  := 0;
  v_mef                text[]   := '{}';
  v_city_warning       text     := NULL;

  v_canonical_city     canonical_cities%ROWTYPE;
  v_elem               jsonb;
  v_elem_text          text;
  v_seen               text[];
  v_result             text[];
  v_canon              text;
  v_cap_num            numeric;
  v_final_lat          double precision;
  v_final_lng          double precision;

  v_allowed_keys text[] := ARRAY[
    'canonical_name','aliases','city','region',
    'lat','lng','address','image_url','description',
    'social_links','category','capacity','accessibility'
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

  -- 3. Lock and fetch venue
  SELECT * INTO v FROM venues WHERE id = p_venue_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'venue not found:%', p_venue_id;
  END IF;

  -- 4. Reject merged venue
  IF v.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'venue is merged:%:merged into %', p_venue_id, v.merged_into;
  END IF;

  -- 5. Extract, validate, cast each field

  IF p_fields ? 'canonical_name' THEN
    v_has_canonical_name := TRUE;
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
      v_canon  := COALESCE(
        CASE WHEN v_has_canonical_name THEN v_canonical_name ELSE NULL END,
        v.canonical_name
      );
      v_seen   := '{}';
      v_result := '{}';
      FOR v_elem IN SELECT jsonb_array_elements(v_val_raw) LOOP
        IF jsonb_typeof(v_elem) != 'string' THEN
          RAISE EXCEPTION 'invalid_type:aliases:all elements must be strings, got %', jsonb_typeof(v_elem);
        END IF;
        v_elem_text := trim(v_elem #>> '{}');
        CONTINUE WHEN v_elem_text = '';
        IF length(v_elem_text) > 500 THEN
          RAISE EXCEPTION 'invalid_value:aliases:entry exceeds 500 characters: "%"',
            left(v_elem_text, 40) || '...';
        END IF;
        CONTINUE WHEN lower(v_elem_text) = ANY(v_seen);
        CONTINUE WHEN lower(v_elem_text) = lower(v_canon);
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

  -- Coordinate pair integrity: only when lat or lng is being touched
  IF v_has_lat OR v_has_lng THEN
    v_final_lat := CASE WHEN v_has_lat THEN v_lat ELSE v.lat END;
    v_final_lng := CASE WHEN v_has_lng THEN v_lng ELSE v.lng END;
    IF v_final_lat IS NULL OR v_final_lng IS NULL THEN
      RAISE EXCEPTION 'invalid_coordinates::lat and lng must both be valid numbers when setting coordinates; null removal not yet supported';
    END IF;
  END IF;

  IF p_fields ? 'address' THEN
    v_has_address := TRUE;
    v_val_raw     := p_fields -> 'address';
    IF v_val_raw = 'null'::jsonb THEN
      v_address := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN
        RAISE EXCEPTION 'invalid_type:address:expected string, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_address := trim(v_val_raw #>> '{}');
      IF v_address = '' THEN v_address := NULL; END IF;
      IF length(v_address) > 500 THEN
        RAISE EXCEPTION 'invalid_value:address:exceeds 500 characters';
      END IF;
    END IF;
  END IF;

  IF p_fields ? 'image_url' THEN
    v_has_image_url := TRUE;
    v_val_raw       := p_fields -> 'image_url';
    IF v_val_raw = 'null'::jsonb THEN
      v_image_url := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN
        RAISE EXCEPTION 'invalid_type:image_url:expected string, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_image_url := trim(v_val_raw #>> '{}');
      IF v_image_url = '' THEN v_image_url := NULL; END IF;
      IF length(v_image_url) > 2048 THEN
        RAISE EXCEPTION 'invalid_value:image_url:exceeds 2048 characters';
      END IF;
    END IF;
  END IF;

  IF p_fields ? 'description' THEN
    v_has_description := TRUE;
    v_val_raw         := p_fields -> 'description';
    IF v_val_raw = 'null'::jsonb THEN
      v_description := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN
        RAISE EXCEPTION 'invalid_type:description:expected string, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_description := v_val_raw #>> '{}';
      IF v_description = '' THEN v_description := NULL; END IF;
      IF length(v_description) > 5000 THEN
        RAISE EXCEPTION 'invalid_value:description:exceeds 5000 characters';
      END IF;
    END IF;
  END IF;

  IF p_fields ? 'social_links' THEN
    v_has_social_links := TRUE;
    v_val_raw          := p_fields -> 'social_links';
    IF v_val_raw = 'null'::jsonb THEN
      v_social_links := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'object' THEN
        RAISE EXCEPTION 'invalid_type:social_links:expected JSON object or null, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_social_links := v_val_raw;
    END IF;
  END IF;

  IF p_fields ? 'category' THEN
    v_has_category := TRUE;
    v_val_raw      := p_fields -> 'category';
    IF v_val_raw = 'null'::jsonb THEN
      v_category := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN
        RAISE EXCEPTION 'invalid_type:category:expected string, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_category := trim(v_val_raw #>> '{}');
      IF v_category = '' THEN v_category := NULL; END IF;
      IF length(v_category) > 200 THEN
        RAISE EXCEPTION 'invalid_value:category:exceeds 200 characters';
      END IF;
    END IF;
  END IF;

  IF p_fields ? 'capacity' THEN
    v_has_capacity := TRUE;
    v_val_raw      := p_fields -> 'capacity';
    IF v_val_raw = 'null'::jsonb THEN
      v_capacity := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'number' THEN
        RAISE EXCEPTION 'invalid_type:capacity:expected number, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_cap_num := (v_val_raw #>> '{}')::numeric;
      IF v_cap_num != floor(v_cap_num) THEN
        RAISE EXCEPTION 'invalid_value:capacity:must be an integer, got %', v_cap_num;
      END IF;
      IF v_cap_num < 0 THEN
        RAISE EXCEPTION 'invalid_value:capacity:must be non-negative';
      END IF;
      IF v_cap_num > 2000000 THEN
        RAISE EXCEPTION 'invalid_value:capacity:exceeds maximum of 2000000';
      END IF;
      v_capacity := v_cap_num::integer;
    END IF;
  END IF;

  IF p_fields ? 'accessibility' THEN
    v_has_accessibility := TRUE;
    v_val_raw           := p_fields -> 'accessibility';
    IF v_val_raw = 'null'::jsonb THEN
      v_accessibility := NULL;
    ELSE
      IF jsonb_typeof(v_val_raw) != 'string' THEN
        RAISE EXCEPTION 'invalid_type:accessibility:expected string, got %', jsonb_typeof(v_val_raw);
      END IF;
      v_accessibility := trim(v_val_raw #>> '{}');
      IF v_accessibility = '' THEN v_accessibility := NULL; END IF;
      IF length(v_accessibility) > 2000 THEN
        RAISE EXCEPTION 'invalid_value:accessibility:exceeds 2000 characters';
      END IF;
    END IF;
  END IF;

  -- 6. Compute diff
  v_mef := COALESCE(v.manually_edited_fields, '{}');

  IF v_has_canonical_name AND (v_canonical_name IS DISTINCT FROM v.canonical_name) THEN
    v_diff    := v_diff || jsonb_build_object('field','canonical_name','old',to_jsonb(v.canonical_name),'new',to_jsonb(v_canonical_name));
    v_changes := v_changes + 1;
    IF NOT ('canonical_name' = ANY(v_mef)) THEN v_mef := v_mef || 'canonical_name'; END IF;
  END IF;
  IF v_has_aliases AND (v_aliases IS DISTINCT FROM v.aliases) THEN
    v_diff    := v_diff || jsonb_build_object('field','aliases','old',to_jsonb(v.aliases),'new',to_jsonb(v_aliases));
    v_changes := v_changes + 1;
    IF NOT ('aliases' = ANY(v_mef)) THEN v_mef := v_mef || 'aliases'; END IF;
  END IF;
  IF v_has_city AND (v_city IS DISTINCT FROM v.city) THEN
    v_diff    := v_diff || jsonb_build_object('field','city','old',to_jsonb(v.city),'new',to_jsonb(v_city));
    v_changes := v_changes + 1;
    IF NOT ('city' = ANY(v_mef)) THEN v_mef := v_mef || 'city'; END IF;
  END IF;
  IF v_has_region AND (v_region IS DISTINCT FROM v.region) THEN
    v_diff    := v_diff || jsonb_build_object('field','region','old',to_jsonb(v.region),'new',to_jsonb(v_region));
    v_changes := v_changes + 1;
    IF NOT ('region' = ANY(v_mef)) THEN v_mef := v_mef || 'region'; END IF;
  END IF;
  IF v_has_lat AND (v_lat IS DISTINCT FROM v.lat) THEN
    v_diff    := v_diff || jsonb_build_object('field','lat','old',to_jsonb(v.lat),'new',to_jsonb(v_lat));
    v_changes := v_changes + 1;
    IF NOT ('lat' = ANY(v_mef)) THEN v_mef := v_mef || 'lat'; END IF;
  END IF;
  IF v_has_lng AND (v_lng IS DISTINCT FROM v.lng) THEN
    v_diff    := v_diff || jsonb_build_object('field','lng','old',to_jsonb(v.lng),'new',to_jsonb(v_lng));
    v_changes := v_changes + 1;
    IF NOT ('lng' = ANY(v_mef)) THEN v_mef := v_mef || 'lng'; END IF;
  END IF;
  IF v_has_address AND (v_address IS DISTINCT FROM v.address) THEN
    v_diff    := v_diff || jsonb_build_object('field','address','old',to_jsonb(v.address),'new',to_jsonb(v_address));
    v_changes := v_changes + 1;
  END IF;
  IF v_has_image_url AND (v_image_url IS DISTINCT FROM v.image_url) THEN
    v_diff    := v_diff || jsonb_build_object('field','image_url','old',to_jsonb(v.image_url),'new',to_jsonb(v_image_url));
    v_changes := v_changes + 1;
  END IF;
  IF v_has_description AND (v_description IS DISTINCT FROM v.description) THEN
    v_diff    := v_diff || jsonb_build_object('field','description','old',to_jsonb(v.description),'new',to_jsonb(v_description));
    v_changes := v_changes + 1;
  END IF;
  IF v_has_social_links AND (v_social_links IS DISTINCT FROM v.social_links) THEN
    v_diff    := v_diff || jsonb_build_object('field','social_links','old',to_jsonb(v.social_links),'new',to_jsonb(v_social_links));
    v_changes := v_changes + 1;
  END IF;
  IF v_has_category AND (v_category IS DISTINCT FROM v.category) THEN
    v_diff    := v_diff || jsonb_build_object('field','category','old',to_jsonb(v.category),'new',to_jsonb(v_category));
    v_changes := v_changes + 1;
  END IF;
  IF v_has_capacity AND (v_capacity IS DISTINCT FROM v.capacity) THEN
    v_diff    := v_diff || jsonb_build_object('field','capacity','old',to_jsonb(v.capacity),'new',to_jsonb(v_capacity));
    v_changes := v_changes + 1;
  END IF;
  IF v_has_accessibility AND (v_accessibility IS DISTINCT FROM v.accessibility) THEN
    v_diff    := v_diff || jsonb_build_object('field','accessibility','old',to_jsonb(v.accessibility),'new',to_jsonb(v_accessibility));
    v_changes := v_changes + 1;
  END IF;

  -- 7. Reject no-op
  IF v_changes = 0 THEN
    RAISE EXCEPTION 'no changes::all provided values are identical to current values';
  END IF;

  -- 8. City mismatch warning (fires only when canonical_city_id is populated in the future)
  IF v_has_city AND v_city IS NOT NULL AND v.canonical_city_id IS NOT NULL THEN
    SELECT * INTO v_canonical_city FROM canonical_cities WHERE id = v.canonical_city_id;
    IF FOUND AND NOT (
      lower(v_city) = lower(v_canonical_city.display_name) OR
      lower(v_city) = ANY(SELECT lower(f) FROM unnest(v_canonical_city.normalized_forms) f) OR
      lower(v_city) = ANY(SELECT lower(a) FROM unnest(v_canonical_city.aliases) a)
    ) THEN
      v_city_warning := 'city_text_contradicts_canonical';
    END IF;
  END IF;

  -- 9. UPDATE venues — explicit assignments, no dynamic SQL
  UPDATE venues SET
    canonical_name         = CASE WHEN v_has_canonical_name THEN v_canonical_name  ELSE canonical_name         END,
    aliases                = CASE WHEN v_has_aliases        THEN v_aliases          ELSE aliases                END,
    city                   = CASE WHEN v_has_city           THEN v_city             ELSE city                   END,
    region                 = CASE WHEN v_has_region         THEN v_region           ELSE region                 END,
    lat                    = CASE WHEN v_has_lat            THEN v_lat              ELSE lat                    END,
    lng                    = CASE WHEN v_has_lng            THEN v_lng              ELSE lng                    END,
    address                = CASE WHEN v_has_address        THEN v_address          ELSE address                END,
    image_url              = CASE WHEN v_has_image_url      THEN v_image_url        ELSE image_url              END,
    description            = CASE WHEN v_has_description    THEN v_description      ELSE description            END,
    social_links           = CASE WHEN v_has_social_links   THEN v_social_links     ELSE social_links           END,
    category               = CASE WHEN v_has_category       THEN v_category         ELSE category               END,
    capacity               = CASE WHEN v_has_capacity       THEN v_capacity         ELSE capacity               END,
    accessibility          = CASE WHEN v_has_accessibility  THEN v_accessibility    ELSE accessibility          END,
    manually_edited_fields = v_mef,
    updated_at             = now()
  WHERE id = p_venue_id;

  -- 10. INSERT audit rows — one per changed field
  -- Value format: {"value": <raw>} for non-null, SQL NULL for null (matches all existing rows)
  INSERT INTO venue_edit_log (venue_id, field_name, old_value, new_value, edited_by, source)
  SELECT
    p_venue_id,
    entry->>'field',
    CASE WHEN (entry->'old') = 'null'::jsonb OR (entry->'old') IS NULL THEN NULL
         ELSE jsonb_build_object('value', entry->'old') END,
    CASE WHEN (entry->'new') = 'null'::jsonb OR (entry->'new') IS NULL THEN NULL
         ELSE jsonb_build_object('value', entry->'new') END,
    p_actor,
    'workbench'
  FROM jsonb_array_elements(v_diff) AS entry;

  -- 11. Return
  RETURN jsonb_build_object(
    'ok',           TRUE,
    'changes',      v_changes,
    'diff',         v_diff,
    'city_warning', v_city_warning
  );

EXCEPTION
  WHEN OTHERS THEN RAISE;
END;
$$;

REVOKE ALL     ON FUNCTION public.edit_venue(uuid, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.edit_venue(uuid, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.edit_venue(uuid, jsonb, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.edit_venue(uuid, jsonb, text) TO service_role;
-- ROLLBACK: DROP FUNCTION IF EXISTS public.edit_venue(uuid, jsonb, text);
