-- P26: a flagged health screen + a coach-built (library) program must be releasable once a coach
-- reviews the screen, and only then. Run against a database with every migration applied
-- (local stack or a throwaway project). ONE transaction, ends with ROLLBACK: nothing persists.
-- Impersonates a coach by setting the JWT claims GUC the way PostgREST does. A clean run prints
-- one NOTICE per passed test ('ok 1' .. 'ok 14', with lettered sub-tests); any 'TEST FAILED' raise stops the script.
begin;

create temp table fx (k text primary key, v uuid) on commit drop;
insert into fx values ('tenant', gen_random_uuid()), ('other_tenant', gen_random_uuid()),
  ('coach', gen_random_uuid()), ('client', gen_random_uuid()), ('client2', gen_random_uuid()),
  ('program', gen_random_uuid()), ('intake', gen_random_uuid()), ('intake2', gen_random_uuid());
grant select on fx to authenticated;

insert into public.tenants (id, slug) values ((select v from fx where k='tenant'), 'p26-test'), ((select v from fx where k='other_tenant'), 'p26-other');
insert into public.tenant_config (tenant_id, mode) values ((select v from fx where k='tenant'), 'coached') on conflict (tenant_id) do nothing;

-- Client 1: the screen + waiver path (no program draft is ever generated), flagged on Q1,
-- then a program from the coach's own library assigned. Training only (nutrition declined).
insert into public.clients (id, tenant_id, display_name, email, status, nutrition_declined_at)
  values ((select v from fx where k='client'), (select v from fx where k='tenant'), 'P26 Screen Client', 'p26-screen@example.invalid', 'invited', now());
insert into public.intake_forms (id, tenant_id, client_id, token, status, submitted_at, answers, health_flags)
  values ((select v from fx where k='intake'), (select v from fx where k='tenant'), (select v from fx where k='client'), 'p26-token-1', 'submitted', now() - interval '1 hour',
          '{"intake_kind":"screen","parq_heart_condition":true}'::jsonb, '["parq_heart_condition"]'::jsonb);
insert into public.programs (id, tenant_id, name, structure, is_default)
  values ((select v from fx where k='program'), (select v from fx where k='tenant'), 'P26 Library Program', '{"days":[{"name":"Day 1","exercises":[]}]}'::jsonb, false);
insert into public.assignments (tenant_id, client_id, program_id, active)
  values ((select v from fx where k='tenant'), (select v from fx where k='client'), (select v from fx where k='program'), true);

select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);

create or replace function pg_temp.expect_error(p_sql text, p_like text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'TEST FAILED (%): expected an error like %, got success', p_label, p_like;
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    if sqlerrm not like p_like then raise exception 'TEST FAILED (%): expected %, got %', p_label, p_like, sqlerrm; end if;
    raise notice 'ok % refused: %', p_label, sqlerrm;
  end;
end $$;

-- 1. the dead end as it stood: program live, nutrition declined, email ok, health flagged.
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client'));
  if c->'program'->>'state' <> 'live' or c->'health'->>'state' <> 'flagged' or (c->>'ready')::boolean then
    raise exception 'TEST FAILED 1: %', c; end if;
  if c->'health'->>'intake_id' is distinct from (select v from fx where k='intake')::text then
    raise exception 'TEST FAILED 1: checklist does not name the intake: %', c->'health'; end if;
  if exists (select 1 from public.program_drafts where client_id = (select v from fx where k='client')) then
    raise exception 'TEST FAILED 1: fixture should have no draft'; end if;
  raise notice 'ok 1 flagged screen + library program reads as blocked, intake named: %', c->'health'->>'detail';
end $$;

-- 2. release still refuses on health before any review.
select pg_temp.expect_error(format('select public.release_client(%L, false)', (select v from fx where k='client')), 'release refused: Health screen flagged%', '2 release before review');

-- 3. review refusals: blank note, too short, not a coach, wrong tenant, nothing written.
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), '   '), 'review refused: say what you checked%', '3a blank note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), null), 'review refused: say what you checked%', '3b null note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), repeat('x', 1001)), 'review refused: keep the note under 1000%', '3c long note');
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'user_role', 'client',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), 'cleared'), 'not authorized: coach role required', '3d client role');
select set_config('request.jwt.claims', json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='other_tenant'))::text, true);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), 'cleared'), 'not authorized: wrong tenant', '3e other tenant coach');
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), 'cleared'), 'not authorized: a signed-in coach is required', '3f no user id');
select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
do $$ begin
  if exists (select 1 from public.health_screen_reviews where client_id = (select v from fx where k='client')) then raise exception 'TEST FAILED 3: a refusal wrote a review'; end if;
  raise notice 'ok 3 refusals wrote nothing';
end $$;

-- 4. a coach cannot write the review table directly (only the function writes it).
set local role authenticated;
select pg_temp.expect_error(format('insert into public.health_screen_reviews (tenant_id, client_id, intake_id, flags, note, reviewed_by) values (%L, %L, %L, %L, %L, %L)',
  (select v from fx where k='tenant'), (select v from fx where k='client'), (select v from fx where k='intake'), '["parq_heart_condition"]', 'forged', (select v from fx where k='coach')),
  'permission denied%', '4 direct insert as authenticated');
reset role;

-- 5. the review: recorded with who, when, which flags, the note.
do $$ declare r jsonb; row public.health_screen_reviews%rowtype; begin
  r := public.review_health_screen((select v from fx where k='intake'), '  Talked it through; GP clearance letter on file  ');
  if r->>'status' <> 'reviewed' then raise exception 'TEST FAILED 5: %', r; end if;
  select * into row from public.health_screen_reviews where id = (r->>'review_id')::uuid;
  if row.reviewed_by <> (select v from fx where k='coach') or row.flags <> '["parq_heart_condition"]'::jsonb
     or row.note <> 'Talked it through; GP clearance letter on file' or row.tenant_id <> (select v from fx where k='tenant') then
    raise exception 'TEST FAILED 5: review row wrong: %', row_to_json(row); end if;
  raise notice 'ok 5 review recorded: %', r;
end $$;

-- 6. idempotent: a second tap returns the first review, no second row.
do $$ declare r1 uuid; r2 uuid; begin
  select id into r1 from public.health_screen_reviews where intake_id = (select v from fx where k='intake');
  r2 := (public.review_health_screen((select v from fx where k='intake'), 'again')->>'review_id')::uuid;
  if r1 <> r2 or (select count(*) from public.health_screen_reviews where intake_id = (select v from fx where k='intake')) <> 1 then
    raise exception 'TEST FAILED 6: not idempotent'; end if;
  raise notice 'ok 6 idempotent review';
end $$;

-- 7. the coach can read the review back (RLS select policy).
set local role authenticated;
do $$ begin
  if (select count(*) from public.health_screen_reviews where intake_id = (select v from fx where k='intake')) <> 1 then
    raise exception 'TEST FAILED 7: coach cannot read the review'; end if;
  raise notice 'ok 7 coach reads the review under RLS';
end $$;
reset role;

-- 8. checklist now ready; health says reviewed with the date.
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client'));
  if c->'health'->>'state' <> 'flagged_reviewed' or not (c->'health'->>'ok')::boolean or not (c->>'ready')::boolean then
    raise exception 'TEST FAILED 8: %', c; end if;
  raise notice 'ok 8 reviewed screen reads ready: %', c->'health'->>'detail';
end $$;

-- 9. flags edited after the review (update_client_onboarding path) need a new review.
update public.intake_forms set health_flags = '["parq_heart_condition","medications"]'::jsonb where id = (select v from fx where k='intake');
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client'));
  if c->'health'->>'state' <> 'flagged' or (c->>'ready')::boolean then raise exception 'TEST FAILED 9: changed flags still cleared: %', c->'health'; end if;
  raise notice 'ok 9 changed flags need a new review';
end $$;
update public.intake_forms set health_flags = '["parq_heart_condition"]'::jsonb where id = (select v from fx where k='intake');

-- 10. a newer flagged screen needs its own review; the old screen can no longer be reviewed.
insert into public.intake_forms (id, tenant_id, client_id, token, status, submitted_at, answers, health_flags)
  values ((select v from fx where k='intake2'), (select v from fx where k='tenant'), (select v from fx where k='client'), 'p26-token-2', 'submitted', now(),
          '{"intake_kind":"screen","parq_heart_condition":true}'::jsonb, '["parq_heart_condition"]'::jsonb);
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client'));
  if c->'health'->>'state' <> 'flagged' or c->'health'->>'intake_id' <> (select v from fx where k='intake2')::text then
    raise exception 'TEST FAILED 10: newer screen not required: %', c->'health'; end if;
  raise notice 'ok 10 newer screen needs its own review';
end $$;
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), 'old one'), 'review refused: a newer health screen exists%', '10b stale screen');
delete from public.intake_forms where id = (select v from fx where k='intake2');

-- 11. a clear screen, or an unsubmitted one, has nothing to review.
insert into public.intake_forms (id, tenant_id, client_id, token, status, submitted_at, health_flags)
  values ((select v from fx where k='intake2'), (select v from fx where k='tenant'), (select v from fx where k='client'), 'p26-token-5', 'submitted', now(), '[]'::jsonb);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake2'), 'nothing'), 'review refused: this health screen has no flags to review', '11b clear screen');
delete from public.intake_forms where id = (select v from fx where k='intake2');
insert into public.intake_forms (id, tenant_id, client_id, token, status, health_flags)
  values ((select v from fx where k='intake2'), (select v from fx where k='tenant'), (select v from fx where k='client'), 'p26-token-3', 'pending', '[]'::jsonb);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake2'), 'nothing'), 'review refused: this health screen has not been submitted', '11a pending screen');
delete from public.intake_forms where id = (select v from fx where k='intake2');

-- 12. release: program already live (the library program stays), invite minted.
do $$ declare r jsonb; begin
  r := public.release_client((select v from fx where k='client'), false);
  if r->>'status' <> 'released' or r->'program'->>'action' <> 'already_live'
     or r->'program'->>'program_id' <> (select v from fx where k='program')::text then raise exception 'TEST FAILED 12: %', r; end if;
  if not exists (select 1 from public.assignments where client_id = (select v from fx where k='client') and program_id = (select v from fx where k='program') and active) then
    raise exception 'TEST FAILED 12: library program no longer live'; end if;
  raise notice 'ok 12 released with the library program: %', r->'program';
end $$;

-- 13. the full-intake path: held_medical draft with no days, library program assigned instead.
--     Approving the held draft is refused; the review clears health; release leaves the held
--     draft alone (the coach still decides it on Coach Home).
insert into public.clients (id, tenant_id, display_name, email, status, nutrition_declined_at)
  values ((select v from fx where k='client2'), (select v from fx where k='tenant'), 'P26 Held Client', 'p26-held@example.invalid', 'invited', now());
insert into public.intake_forms (id, tenant_id, client_id, token, status, submitted_at, health_flags)
  values ((select v from fx where k='intake2'), (select v from fx where k='tenant'), (select v from fx where k='client2'), 'p26-token-4', 'submitted', now(), '["parq_chest_pain"]'::jsonb);
insert into public.program_drafts (tenant_id, client_id, intake_id, status, training, meal_plan, macros, health_flags)
  values ((select v from fx where k='tenant'), (select v from fx where k='client2'), (select v from fx where k='intake2'), 'held_medical', '{"days":[]}'::jsonb,
          '{"held_for_medical_review":true}'::jsonb, '{}'::jsonb, '["parq_chest_pain"]'::jsonb);
insert into public.assignments (tenant_id, client_id, program_id, active)
  values ((select v from fx where k='tenant'), (select v from fx where k='client2'), (select v from fx where k='program'), true);
select pg_temp.expect_error(format('select public.approve_program_draft(%L, %L, null)',
  (select id from public.program_drafts where client_id = (select v from fx where k='client2')), 'approve'), 'medical hold:%', '13a held empty draft cannot be approved');
select pg_temp.expect_error(format('select public.release_client(%L, false)', (select v from fx where k='client2')), 'release refused: Health screen flagged%', '13b held-path release before review');
do $$ declare r jsonb; begin
  perform public.review_health_screen((select v from fx where k='intake2'), 'Cleared to train by cardiologist, letter on file');
  r := public.release_client((select v from fx where k='client2'), false);
  if r->>'status' <> 'released' or r->'program'->>'action' <> 'already_live' then raise exception 'TEST FAILED 13: %', r; end if;
  if (select status from public.program_drafts where client_id = (select v from fx where k='client2')) <> 'held_medical' then
    raise exception 'TEST FAILED 13: release touched the held draft'; end if;
  raise notice 'ok 13 held-path client released after review; held draft untouched';
end $$;

-- 14. a suspended tenant cannot record a review.
update public.tenants set status = 'suspended' where id = (select v from fx where k='tenant');
update public.intake_forms set health_flags = '["parq_heart_condition","medications"]'::jsonb where id = (select v from fx where k='intake');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L)', (select v from fx where k='intake'), 'while paused'), 'This app is paused%', '14 suspended tenant');

rollback;
