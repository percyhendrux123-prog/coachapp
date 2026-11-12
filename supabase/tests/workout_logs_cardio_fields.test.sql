-- The app selects workout_logs.duration_seconds and distance_meters on every set read
-- (client Train/History, coach client detail, MCP). Without them every such read fails
-- with 42703. A clean run prints one NOTICE per passed test; nothing persists.
begin;
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'workout_logs' and column_name = 'duration_seconds' and data_type = 'integer') then
    raise exception 'TEST FAILED: workout_logs.duration_seconds (integer) missing'; end if;
  raise notice 'ok 1 - workout_logs.duration_seconds';
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'workout_logs' and column_name = 'distance_meters' and data_type = 'numeric') then
    raise exception 'TEST FAILED: workout_logs.distance_meters (numeric) missing'; end if;
  raise notice 'ok 2 - workout_logs.distance_meters';
  perform weight, reps, duration_seconds, distance_meters, rpe, logged_at from public.workout_logs limit 1;
  raise notice 'ok 3 - the app''s set read parses';
end $$;
rollback;
