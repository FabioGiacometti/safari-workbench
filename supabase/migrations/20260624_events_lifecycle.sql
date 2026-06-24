-- Migration: add lifecycle columns to events table
-- Apply in Supabase dashboard: SQL Editor → New Query → paste → Run
-- Safe to run multiple times (IF NOT EXISTS).
-- Does not touch existing columns or pipeline rows.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS price_max           numeric,
  ADD COLUMN IF NOT EXISTS updated_by          text,
  ADD COLUMN IF NOT EXISTS published_by        text,
  ADD COLUMN IF NOT EXISTS published_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by        text,
  ADD COLUMN IF NOT EXISTS cancelled_at        timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;
