-- Add 'incomplete' status to challenge_runs.
-- G4 (2026-08-09): an unlogged day makes the run incomplete, not failed.
-- A missing log is not evidence of failure — it's the honest version.
ALTER TYPE public.challenge_run_status ADD VALUE 'incomplete';