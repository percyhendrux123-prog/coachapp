-- ---------------------------------------------------------------------------
-- Coach Home performance fix, tier 2 — Part A only (2026-08-26).
--
-- See the original design notes (not included) for the full writeup.
-- Verified in a rolled-back transaction before this was committed:
--
--   - Wraps the three lookup functions (current_tenant_id, current_client_id,
--     current_app_role) in scalar subqueries everywhere they appear bare in
--     an RLS policy across the 9 tables the Coach Home call chain reads.
--     `x = current_tenant_id()` becomes `x = (select current_tenant_id())`.
--     This is the exact pattern Supabase's own performance advisor
--     recommends (auth_rls_initplan) -- it changes nothing about WHO can see
--     WHAT, only how many times Postgres has to re-run the lookup. Every
--     policy's boolean predicate is mathematically identical before and
--     after; only the evaluation/caching strategy changes.
--
--   - Correctness: ran the same read as 4 real identities (the owner's
--     coach account, a second real coach account on a different tenant, and
--     two real distinct client accounts) across all 9 tables -- 36
--     combinations -- before and after this change, in a rolled-back
--     transaction. Every row set returned was identical, including two
--     non-trivial cases: the programs table's EXISTS-based client policy,
--     and confirming the cross-tenant coach still sees zero rows of the owner tenant's
--     multi-client dataset (not a trivial empty-vs-empty comparison -- the owner tenant
--     has real data to leak into a broken policy and didn't).
--
--   - Performance: measured rm_coach_overview() as the platform owner's real coach
--     account, same test as the tier-1 migration. 2.4s average / ~8s peak
--     originally -> ~1.0s after tier-1's indexes and dedup work -> 240ms
--     with this change added on top, same rolled-back-transaction test run
--     twice for consistency. Buffer reads dropped from ~28,900 (pre-tier-1)
--     to ~6,400.
--
-- Part B from the plan doc (actually merging each table's client-policy and
-- coach-policy into one combined policy, rather than just wrapping the
-- function calls) is NOT included here. Verification surfaced real added
-- complexity the original plan underestimated -- several tables split
-- coach access across ALL-scoped and client access across SELECT-only
-- policies, so a true merge needs restructuring command scope, not a
-- straight 2-into-1 swap. Given Part A alone already gets this down to
-- 240ms, Part B is being deferred rather than pushed through to match the
-- plan document's original framing.
-- ---------------------------------------------------------------------------

alter policy assign_coach_all on public.assignments
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'))
  with check ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));
alter policy assign_client_read on public.assignments
  using (client_id = (select current_client_id()));

alter policy cha_client_read on public.checkin_hub_archive
  using (client_id = (select current_client_id()));
alter policy cha_coach_read on public.checkin_hub_archive
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));

alter policy checkins_coach_rw on public.checkins
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'))
  with check ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));
alter policy checkins_client_insert on public.checkins
  with check ((client_id = (select current_client_id())) and (tenant_id = (select current_tenant_id())));
alter policy checkins_client_read on public.checkins
  using (client_id = (select current_client_id()));

alter policy clients_coach_all on public.clients
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'))
  with check ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));

alter policy meal_plans_coach_all on public.meal_plans
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'))
  with check ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));
alter policy meal_plans_client_read on public.meal_plans
  using ((client_id = (select current_client_id())) and (status = 'assigned'));

alter policy msg_coach_all on public.messages
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'))
  with check ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach') and (sender_role = 'coach'));
alter policy msg_client_insert on public.messages
  with check ((client_id = (select current_client_id())) and (tenant_id = (select current_tenant_id())) and (sender_role = 'client'));
alter policy msg_client_read on public.messages
  using (client_id = (select current_client_id()));

alter policy programs_coach_all on public.programs
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'))
  with check ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));
alter policy programs_client_read on public.programs
  using (exists (select 1 from assignments a where a.program_id = programs.id and a.client_id = (select current_client_id())));

alter policy logs_client_all on public.workout_logs
  using (client_id = (select current_client_id()))
  with check ((client_id = (select current_client_id())) and (tenant_id = (select current_tenant_id())));
alter policy logs_coach_read on public.workout_logs
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));

alter policy sess_client_all on public.workout_sessions
  using (client_id = (select current_client_id()))
  with check ((client_id = (select current_client_id())) and (tenant_id = (select current_tenant_id())));
alter policy sess_coach_read on public.workout_sessions
  using ((tenant_id = (select current_tenant_id())) and ((select current_app_role()) = 'coach'));
