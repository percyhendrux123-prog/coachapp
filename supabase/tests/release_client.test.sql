-- release_client() refusal + atomicity tests. Slice 3, the original design notes (not included).
--
-- Runs entirely inside ONE transaction and ends with ROLLBACK: fixture rows are created,
-- every assertion runs, nothing persists. Run against a database that already has the
-- Slice 3 migration applied (a Supabase branch, local stack, or — on the coach's word — the SQL
-- editor). It impersonates a coach by setting the JWT claims GUC the way PostgREST does.
--
-- Each `TEST FAILED` raise stops the script, so the script stops at the first broken expectation and
-- the transaction still rolls back. A clean run prints one NOTICE per passed test.
begin;

-- ---------- fixtures ----------
create temp table fx (k text primary key, v uuid) on commit drop;
insert into fx values ('tenant', gen_random_uuid()), ('coach', gen_random_uuid()), ('client', gen_random_uuid());

insert into public.tenants (id, slug) values ((select v from fx where k='tenant'), 'release-test');
insert into public.tenant_config (tenant_id, mode) values ((select v from fx where k='tenant'), 'coached')
  on conflict (tenant_id) do nothing;
-- No profiles row: profiles.user_id is a foreign key into auth.users, and the role + tenant
-- come from the JWT claims below (current_app_role / current_tenant_id read the claims first).
insert into public.clients (id, tenant_id, display_name, email, status)
  values ((select v from fx where k='client'), (select v from fx where k='tenant'), 'Release Test Client', null, 'invited');

-- impersonate the coach (what PostgREST does for a coach JWT)
select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);

create or replace function pg_temp.expect_refusal(p_no_nutrition boolean, p_hint text) returns void language plpgsql as $$
declare v_hint text;
begin
  begin
    perform public.release_client((select v from fx where k='client'), p_no_nutrition);
    raise exception 'TEST FAILED: expected refusal (%), got success', p_hint;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    if v_hint is distinct from p_hint then
      raise exception 'TEST FAILED: expected hint % got % (%)', p_hint, v_hint, sqlerrm;
    end if;
    raise notice 'ok — refused: % (%)', p_hint, sqlerrm;
  end;
end $$;

-- ---------- 1. nothing at all → program is the first missing item ----------
select pg_temp.expect_refusal(false, 'program');

-- ---------- 2. an EMPTY draft is still "program missing" ----------
insert into public.program_drafts (id, tenant_id, client_id, status, training, meal_plan, macros)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='client'), 'draft', '{"days":[]}'::jsonb, '{}'::jsonb, '{}'::jsonb);
select pg_temp.expect_refusal(false, 'program');
delete from public.program_drafts where client_id = (select v from fx where k='client');

-- ---------- 3. real draft, no nutrition, not declined → nutrition ----------
insert into public.program_drafts (id, tenant_id, client_id, status, training, meal_plan, macros)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='client'), 'draft',
          '{"days":[{"name":"Day 1","exercises":[]},{"name":"Day 2","exercises":[]}]}'::jsonb, '{}'::jsonb, '{}'::jsonb);
select pg_temp.expect_refusal(false, 'nutrition');

-- ---------- 4. declined nutrition (D6) but no email → email ----------
select pg_temp.expect_refusal(true, 'email');

-- ---------- 4b. syntactically invalid email → still email ----------
update public.clients set email = 'nope' where id = (select v from fx where k='client');
select pg_temp.expect_refusal(true, 'email');

-- ---------- 4c. valid email, no submitted intake → health (fail closed: no screen on record) ----------
update public.clients set email = 'release-test@example.invalid' where id = (select v from fx where k='client');
select pg_temp.expect_refusal(true, 'health');

-- ---------- 4d. unreadable health_flags (an object, not an array) → health ----------
insert into public.intake_forms (tenant_id, client_id, token, status, submitted_at, health_flags)
  values ((select v from fx where k='tenant'), (select v from fx where k='client'), 'fx-token-1', 'submitted', now(), '{}'::jsonb);
select pg_temp.expect_refusal(true, 'health');

-- ---------- 4e. flagged screen, not reviewed → health ----------
update public.intake_forms set health_flags = '["parq_chest_pain"]'::jsonb where token = 'fx-token-1';
select pg_temp.expect_refusal(true, 'health');

-- ---------- 4f. flagged screen, reviewed: a coach-approved draft FOR THAT INTAKE clears it ----------
-- (the draft from test 3 is re-pointed at the intake and marked approved by a coach; release
--  must still not auto-approve a held one — that is test 4g)
update public.program_drafts set intake_id = (select id from public.intake_forms where token = 'fx-token-1'),
       status = 'approved', decided_by = (select v from fx where k='coach'), decided_at = now()
 where client_id = (select v from fx where k='client');
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client'));
  if c->'health'->>'state' <> 'flagged_reviewed' or not (c->'health'->>'ok')::boolean then raise exception 'TEST FAILED: reviewed flags not honoured: %', c->'health'; end if;
  raise notice 'ok — flagged + coach-approved reads as reviewed: %', c->'health'->>'detail';
end $$;
-- put the draft back to plain draft + clear screen for the success tests below
update public.program_drafts set status = 'draft', decided_by = null, decided_at = null where client_id = (select v from fx where k='client');
update public.intake_forms set health_flags = '[]'::jsonb where token = 'fx-token-1';

-- ---------- 4g. a HELD draft is a program problem release never resolves ----------
update public.program_drafts set status = 'held_medical' where client_id = (select v from fx where k='client');
select pg_temp.expect_refusal(true, 'program');
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client'));
  if c->'program'->>'state' <> 'held_medical' then raise exception 'TEST FAILED: held draft not named: %', c->'program'; end if;
  raise notice 'ok — held draft named: %', c->'program'->>'detail';
end $$;
update public.program_drafts set status = 'draft' where client_id = (select v from fx where k='client');
update public.clients set email = null where id = (select v from fx where k='client');

-- nothing was written by any refusal
do $$ begin
  if exists (select 1 from public.assignments where client_id = (select v from fx where k='client')) then raise exception 'TEST FAILED: refusal left an assignment'; end if;
  if (select nutrition_declined_at from public.clients where id = (select v from fx where k='client')) is not null then raise exception 'TEST FAILED: refusal recorded a decline'; end if;
  if (select invite_token from public.clients where id = (select v from fx where k='client')) is not null then raise exception 'TEST FAILED: refusal minted an invite'; end if;
  if (select status from public.program_drafts where client_id = (select v from fx where k='client')) <> 'draft' then raise exception 'TEST FAILED: refusal touched the draft'; end if;
  raise notice 'ok — refusals wrote nothing';
end $$;

-- ---------- 5. forced rollback: a failure AFTER the program publishes must undo it ----------
update public.clients set email = 'release-test@example.invalid' where id = (select v from fx where k='client');
create or replace function pg_temp.boom() returns trigger language plpgsql as $$
begin raise exception 'forced failure for the atomicity test'; end $$;
-- fires on the invite-token write, i.e. the LAST step, after publish + nutrition already ran
create trigger fx_boom before update of invite_token on public.clients for each row
  when (new.display_name = 'Release Test Client') execute function pg_temp.boom();
do $$ begin
  begin
    perform public.release_client((select v from fx where k='client'), true);
    raise exception 'TEST FAILED: forced failure did not raise';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    raise notice 'ok — forced failure raised: %', sqlerrm;
  end;
end $$;
do $$ begin
  if exists (select 1 from public.assignments where client_id = (select v from fx where k='client')) then raise exception 'TEST FAILED: publish survived the rollback'; end if;
  if exists (select 1 from public.programs where source_draft_id in (select id from public.program_drafts where client_id = (select v from fx where k='client'))) then raise exception 'TEST FAILED: program row survived the rollback'; end if;
  if (select status from public.program_drafts where client_id = (select v from fx where k='client')) <> 'draft' then raise exception 'TEST FAILED: draft status survived the rollback'; end if;
  if (select nutrition_declined_at from public.clients where id = (select v from fx where k='client')) is not null then raise exception 'TEST FAILED: decline survived the rollback'; end if;
  raise notice 'ok — forced failure rolled back publish, nutrition and invite together';
end $$;
drop trigger fx_boom on public.clients;

-- ---------- 6. success: publishes, records decline, mints invite, in one call ----------
do $$
declare r jsonb;
begin
  r := public.release_client((select v from fx where k='client'), true);
  if r->>'status' <> 'released' then raise exception 'TEST FAILED: status %', r->>'status'; end if;
  if r->'program'->>'action' <> 'published' then raise exception 'TEST FAILED: program action %', r->'program'->>'action'; end if;
  if r->'nutrition'->>'action' <> 'declined' then raise exception 'TEST FAILED: nutrition action %', r->'nutrition'->>'action'; end if;
  if not (r->'invite'->>'token_minted')::boolean then raise exception 'TEST FAILED: no invite token'; end if;
  if r->'invite'->>'claim_path' not like '/claim?token=%' then raise exception 'TEST FAILED: no claim_path returned'; end if;
  if (select invite_token from public.clients where id = (select v from fx where k='client')) <> substr(r->'invite'->>'claim_path', length('/claim?token=') + 1) then raise exception 'TEST FAILED: claim_path does not carry the minted token'; end if;
  if not (r->>'needs_account')::boolean then raise exception 'TEST FAILED: needs_account should be true for a never-claimed client'; end if;
  if not exists (select 1 from public.assignments where client_id = (select v from fx where k='client') and active) then raise exception 'TEST FAILED: no active assignment'; end if;
  if (select status from public.program_drafts where client_id = (select v from fx where k='client')) <> 'published' then raise exception 'TEST FAILED: draft not published'; end if;
  if (select nutrition_declined_at from public.clients where id = (select v from fx where k='client')) is null then raise exception 'TEST FAILED: decline not recorded'; end if;
  if (select invite_token from public.clients where id = (select v from fx where k='client')) is null then raise exception 'TEST FAILED: invite not minted'; end if;
  raise notice 'ok — released: %', r;
end $$;

-- ---------- 7. idempotent: a second release leaves the live program alone ----------
do $$
declare r jsonb;
begin
  r := public.release_client((select v from fx where k='client'), false);
  if r->'program'->>'action' <> 'already_live' then raise exception 'TEST FAILED: second release re-published (%)', r->'program'->>'action'; end if;
  if r->'nutrition'->>'action' <> 'already_declined' then raise exception 'TEST FAILED: second release nutrition %', r->'nutrition'->>'action'; end if;
  if (select count(*) from public.assignments where client_id = (select v from fx where k='client') and active) <> 1 then raise exception 'TEST FAILED: more than one active assignment'; end if;
  raise notice 'ok — idempotent second release: %', r;
end $$;

-- ---------- 8. structured nutrition draft with meals is assigned by release ----------
-- (a fresh client so the program step runs again too)
insert into public.clients (id, tenant_id, display_name, email, status)
  values (gen_random_uuid(), (select v from fx where k='tenant'), 'Release Test Two', 'release-test-2@example.invalid', 'invited');
insert into public.intake_forms (tenant_id, client_id, token, status, submitted_at, health_flags)
  values ((select v from fx where k='tenant'), (select id from public.clients where display_name = 'Release Test Two'), 'fx-token-2', 'submitted', now(), '[]'::jsonb);
do $$
declare c uuid; p uuid; m uuid; r jsonb;
begin
  select id into c from public.clients where display_name = 'Release Test Two';
  insert into public.program_drafts (id, tenant_id, client_id, status, training, meal_plan, macros)
    values (gen_random_uuid(), (select v from fx where k='tenant'), c, 'draft', '{"days":[{"name":"Day 1","exercises":[]}]}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  -- A plan the assign trigger (check_client_meal_plan_release) will accept: one published
  -- meal on day 0, meals_per_day = 1, all four targets set.
  select id into m from public.meals where status = 'published' limit 1;
  if m is null then raise notice 'skip — no published meals in library, structured-plan test not run'; return; end if;
  insert into public.client_meal_plans (id, tenant_id, client_id, title, status, meals_per_day, target_calories, target_protein_g, target_fat_g, target_carb_g)
    values (gen_random_uuid(), (select v from fx where k='tenant'), c, 'Test plan', 'draft', 1, 2000, 150, 60, 200) returning id into p;
  -- before the slot exists the checklist must say NOT ready, naming the reason
  if (public.release_checklist(c)->'nutrition'->>'ok')::boolean then raise exception 'TEST FAILED: empty structured draft read as ready'; end if;
  insert into public.client_meal_plan_slots (plan_id, tenant_id, client_id, day_index, slot_index, slot_label, meal_id, servings)
    values (p, (select v from fx where k='tenant'), c, 0, 0, 'Meal 1', m, 1);
  r := public.release_client(c, false);
  if r->'nutrition'->>'action' <> 'assigned' or r->'nutrition'->>'source' <> 'structured' then raise exception 'TEST FAILED: nutrition %', r->'nutrition'; end if;
  if (select status from public.client_meal_plans where id = p) <> 'assigned' then raise exception 'TEST FAILED: plan not assigned'; end if;
  if (select assigned_at from public.client_meal_plans where id = p) is null then raise exception 'TEST FAILED: assigned_at not set'; end if;
  raise notice 'ok — structured nutrition assigned by release: %', r->'nutrition';
end $$;

-- ---------- 9. wrong tenant is refused before anything is read ----------
select set_config('request.jwt.claims',
  json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'user_role', 'coach', 'tenant_id', gen_random_uuid())::text, true);
do $$ begin
  begin
    perform public.release_checklist((select v from fx where k='client'));
    raise exception 'TEST FAILED: wrong tenant was allowed';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    if sqlerrm not like '%not authorized%' then raise exception 'TEST FAILED: unexpected error %', sqlerrm; end if;
    raise notice 'ok — wrong tenant refused: %', sqlerrm;
  end;
end $$;

do $$ begin raise notice 'ALL RELEASE TESTS PASSED (rolling back)'; end $$;
rollback;
