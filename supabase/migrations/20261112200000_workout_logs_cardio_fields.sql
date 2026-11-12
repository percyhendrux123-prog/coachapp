-- Cardio actuals on workout_logs: duration_seconds and distance_meters.
--
-- The app reads and writes these two columns everywhere a set is logged or shown (client
-- Train and History, coach client detail, the MCP log_workout_on_behalf tool), but no
-- migration ever created them; the original project added them outside the migration
-- files. On a fresh install every workout_logs read failed with 42703 "column
-- workout_logs.duration_seconds does not exist", so "last time" weights, history and the
-- coach's session view came back empty, and saving a set failed. Intensity reuses rpe.
alter table public.workout_logs add column if not exists duration_seconds integer;
alter table public.workout_logs add column if not exists distance_meters numeric;

comment on column public.workout_logs.duration_seconds is 'Cardio actual: duration in seconds. Null for strength sets.';
comment on column public.workout_logs.distance_meters  is 'Cardio actual: distance in meters. Null for strength sets.';
