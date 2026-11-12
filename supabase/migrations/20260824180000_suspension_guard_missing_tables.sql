-- ============================================================================
-- Attach the tenant suspension guard to the 23 tables it never reached.
--
-- 20260728234500_enforce_tenant_suspension.sql attached
-- trg_tenant_suspension_guard to every table with a tenant_id AT THE TIME IT
-- RAN. Every table created by a later migration was never touched — the loop
-- ran once, not on every future CREATE TABLE. Confirmed live against
-- production on 2026-08-24: 23 tenant-scoped tables carry no guard at all,
-- including coach_videos, video_assignments, video_assignment_responses,
-- client_meal_plans, and meal_adherence_logs — all five with live,
-- wired-up coach buttons today. A suspended, non-paying coach can use them
-- with zero exploit, just the ordinary app.
--
-- This migration is the identical trigger, already proven safe on the other
-- 32 tables, attached to the tables that were missed:
--   body_measurements, checkin_assessments, checkin_tag_corrections,
--   client_allergies, client_allergy_confirmations, client_checkin_schedule,
--   client_dietary_restrictions, client_meal_plan_slot_options,
--   client_meal_plan_slots, client_meal_plans, client_onboarding,
--   coach_videos, foods, history_client_consultations,
--   history_client_profile, history_workout_sessions,
--   history_workout_sets, intake_submissions, meal_adherence_logs, meals,
--   trainerize_staging, video_assignment_responses, video_assignments.
--
-- Purely additive, same function (public.enforce_tenant_not_suspended),
-- same exemptions (service_role, postgres / SECURITY DEFINER bodies).
--
-- Rollback: drop trg_tenant_suspension_guard from each table listed above.
-- ============================================================================

do $attach$
declare
  r record;
  targets text[] := array[
    'body_measurements', 'checkin_assessments', 'checkin_tag_corrections',
    'client_allergies', 'client_allergy_confirmations', 'client_checkin_schedule',
    'client_dietary_restrictions', 'client_meal_plan_slot_options',
    'client_meal_plan_slots', 'client_meal_plans', 'client_onboarding',
    'coach_videos', 'foods', 'history_client_consultations',
    'history_client_profile', 'history_workout_sessions',
    'history_workout_sets', 'intake_submissions', 'meal_adherence_logs', 'meals',
    'trainerize_staging', 'video_assignment_responses', 'video_assignments'
  ];
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(targets)
       -- guard against a table in the list no longer existing/renamed
       and exists (
         select 1 from information_schema.columns col
          where col.table_schema = 'public' and col.table_name = c.relname
            and col.column_name = 'tenant_id'
       )
     order by 1
  loop
    execute format('drop trigger if exists trg_tenant_suspension_guard on public.%I', r.relname);
    execute format(
      'create trigger trg_tenant_suspension_guard
         before insert or update or delete on public.%I
         for each row execute function public.enforce_tenant_not_suspended()', r.relname);
  end loop;
end
$attach$;
