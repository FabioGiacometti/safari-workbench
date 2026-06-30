-- Migration: 20260630_venues_catalog_add_provenance.sql
-- Adds origin and created_by to the venues_catalog view so the API
-- create response and detail panel can surface these fields.

CREATE OR REPLACE VIEW public.venues_catalog AS
 SELECT v.id,
    v.canonical_name,
    v.display_name,
    v.city,
    v.region,
    v.fingerprint,
    v.aliases,
    v.lat,
    v.lng,
    v.geo_confidence,
    v.resolution_confidence,
    v.event_count AS stored_event_count,
    count(e.id) AS real_event_count,
    v.merged_into,
    v.merged_at,
    v.merged_by,
    v.created_at,
    v.updated_at,
    v.geo_entity_id,
    v.canonical_city_id,
    v.manually_edited_fields,
    v.address,
    v.image_url,
    v.description,
    v.category,
    v.capacity,
    v.accessibility,
    v.social_links,
    (( SELECT count(*) AS count
           FROM venue_discrepancies d
          WHERE d.venue_id = v.id AND d.status = 'open'::text))::integer AS open_discrepancy_count,
    v.origin,
    v.created_by
   FROM venues v
     LEFT JOIN events e ON e.venue_id = v.id
  GROUP BY v.id;
