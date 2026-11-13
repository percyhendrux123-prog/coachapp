-- P26: a flagged health screen + a coach-built (library) program must be releasable once a coach
-- reviews the screen, and only then. Run against a database with every migration applied
-- (local stack or a throwaway project). ONE transaction, ends with ROLLBACK: nothing persists.
-- Impersonates a coach by setting the JWT claims GUC the way PostgREST does. A clean run prints
-- one NOTICE per passed test ('ok 1' .. 'ok 18', with lettered sub-tests); any 'TEST FAILED' raise stops the script.
-- P28 (review P27): 3g-3p whitespace-only notes, missing seen flags and the dropped 2-argument
-- signature; 9b an old confirmation replayed after an edit; 15 the stale confirmation (show A,
-- edit to B, confirm A refused; reload B, review succeeds); 16 the table constraint; 17
-- role-level read/write/execute denials; 18 grants.
begin;

create temp table fx (k text primary key, v uuid) on commit drop;
insert into fx values ('tenant', gen_random_uuid()), ('other_tenant', gen_random_uuid()),
  ('coach', gen_random_uuid()), ('client', gen_random_uuid()), ('client2', gen_random_uuid()),
  ('program', gen_random_uuid()), ('intake', gen_random_uuid()), ('intake2', gen_random_uuid()),
  ('client3', gen_random_uuid()), ('intake3', gen_random_uuid());
grant select on fx to authenticated, anon;
-- What the coach's screen showed (test 15), exactly as the checklist returned it.
create temp table shown (k text primary key, flags jsonb) on commit drop;
grant select, insert on shown to authenticated;

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
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', '   '), 'review refused: say what you checked%', '3a blank note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', null), 'review refused: say what you checked%', '3b null note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', repeat('x', 1001)), 'review refused: keep the note under 1000%', '3c long note');
-- P28: whitespace of every kind is not a note (the first draft's btrim only stripped spaces).
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', E'\t\t\t'), 'review refused: say what you checked%', '3g tabs-only note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', E'\n\n\n'), 'review refused: say what you checked%', '3h newlines-only note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', E'\r\n\r\n'), 'review refused: say what you checked%', '3i CRLF-only note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', E' \t\n\r\f\x0b '), 'review refused: say what you checked%', '3j mixed-whitespace note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', E'\u00a0\u00a0\u00a0\u3000\ufeff'), 'review refused: say what you checked%', '3k Unicode-space-only note');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', E'\t ok \n'), 'review refused: say what you checked%', '3l two characters inside whitespace');
-- P28: the first draft's 2-argument signature is gone, so nothing can skip the seen-flags check.
do $$ begin
  if to_regprocedure('public.review_health_screen(uuid, text)') is not null then
    raise exception 'TEST FAILED 3m: the 2-argument review_health_screen still exists'; end if;
  if to_regprocedure('public.review_health_screen(uuid, jsonb, text)') is null then
    raise exception 'TEST FAILED 3m: the 3-argument review_health_screen is missing'; end if;
  raise notice 'ok 3m only review_health_screen(uuid, jsonb, text) exists';
end $$;
select pg_temp.expect_error(format('select public.review_health_screen(%L::uuid, %L::text)', (select v from fx where k='intake'), 'cleared'), '%function public.review_health_screen(uuid, text) does not exist%', '3n old 2-argument call');
select pg_temp.expect_error(format('select public.review_health_screen(%L, null, %L)', (select v from fx where k='intake'), 'cleared by GP'), 'review refused: the health screen changed since you opened it%', '3o no seen flags');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '"parq_heart_condition"', 'cleared by GP'), 'review refused: the health screen changed since you opened it%', '3p seen flags not an array');
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'user_role', 'client',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', 'cleared'), 'not authorized: coach role required', '3d client role');
select set_config('request.jwt.claims', json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='other_tenant'))::text, true);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', 'cleared'), 'not authorized: wrong tenant', '3e other tenant coach');
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', 'cleared'), 'not authorized: a signed-in coach is required', '3f no user id');
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

-- 5. the review: recorded with who, when, which flags, the note (trimmed of tabs/newlines too).
do $$ declare r jsonb; row public.health_screen_reviews%rowtype; begin
  r := public.review_health_screen((select v from fx where k='intake'), '["parq_heart_condition"]', E'\t\n  Talked it through; GP clearance letter on file  \r\n');
  if r->>'status' <> 'reviewed' then raise exception 'TEST FAILED 5: %', r; end if;
  select * into row from public.health_screen_reviews where id = (r->>'review_id')::uuid;
  if row.reviewed_by <> (select v from fx where k='coach') or row.flags <> '["parq_heart_condition"]'::jsonb
     or row.note <> 'Talked it through; GP clearance letter on file' or row.tenant_id <> (select v from fx where k='tenant') then
    raise exception 'TEST FAILED 5: review row wrong: %', row_to_json(row); end if;
  raise notice 'ok 5 review recorded, note trimmed of every whitespace kind: %', r;
end $$;

-- 6. idempotent: a second tap returns the first review, no second row.
do $$ declare r1 uuid; r2 uuid; begin
  select id into r1 from public.health_screen_reviews where intake_id = (select v from fx where k='intake');
  r2 := (public.review_health_screen((select v from fx where k='intake'), '["parq_heart_condition"]', 'again')->>'review_id')::uuid;
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

-- 9. flags edited after the review (update_client_onboarding path) need a new review; the old
--    confirmation cannot be replayed for the new flags (P28: the idempotent return sits behind
--    the seen-flags check).
update public.intake_forms set health_flags = '["parq_heart_condition","medications"]'::jsonb where id = (select v from fx where k='intake');
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client'));
  if c->'health'->>'state' <> 'flagged' or (c->>'ready')::boolean then raise exception 'TEST FAILED 9: changed flags still cleared: %', c->'health'; end if;
  raise notice 'ok 9 changed flags need a new review';
end $$;
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', 'again'), 'review refused: the health screen changed since you opened it%', '9b old flags replayed after an edit');
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
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition"]', 'old one'), 'review refused: a newer health screen exists%', '10b stale screen');
delete from public.intake_forms where id = (select v from fx where k='intake2');

-- 11. a clear screen, or an unsubmitted one, has nothing to review.
insert into public.intake_forms (id, tenant_id, client_id, token, status, submitted_at, health_flags)
  values ((select v from fx where k='intake2'), (select v from fx where k='tenant'), (select v from fx where k='client'), 'p26-token-5', 'submitted', now(), '[]'::jsonb);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake2'), '[]', 'nothing'), 'review refused: this health screen has no flags to review', '11b clear screen');
delete from public.intake_forms where id = (select v from fx where k='intake2');
insert into public.intake_forms (id, tenant_id, client_id, token, status, health_flags)
  values ((select v from fx where k='intake2'), (select v from fx where k='tenant'), (select v from fx where k='client'), 'p26-token-3', 'pending', '[]'::jsonb);
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake2'), '[]', 'nothing'), 'review refused: this health screen has not been submitted', '11a pending screen');
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
  perform public.review_health_screen((select v from fx where k='intake2'), '["parq_chest_pain"]', 'Cleared to train by cardiologist, letter on file');
  r := public.release_client((select v from fx where k='client2'), false);
  if r->>'status' <> 'released' or r->'program'->>'action' <> 'already_live' then raise exception 'TEST FAILED 13: %', r; end if;
  if (select status from public.program_drafts where client_id = (select v from fx where k='client2')) <> 'held_medical' then
    raise exception 'TEST FAILED 13: release touched the held draft'; end if;
  raise notice 'ok 13 held-path client released after review; held draft untouched';
end $$;

-- 15. P28 (review P27 finding 1): the confirmation is bound to the flags the coach saw.
--     Show A (the checklist, read as the authenticated coach), the same intake is edited to B,
--     the coach confirms A: refused, nothing written, health still holds, release refused.
--     Reload shows B; reviewing B succeeds under the authenticated role.
insert into public.clients (id, tenant_id, display_name, email, status, nutrition_declined_at)
  values ((select v from fx where k='client3'), (select v from fx where k='tenant'), 'P28 Stale Client', 'p28-stale@example.invalid', 'invited', now());
insert into public.intake_forms (id, tenant_id, client_id, token, status, submitted_at, answers, health_flags)
  values ((select v from fx where k='intake3'), (select v from fx where k='tenant'), (select v from fx where k='client3'), 'p28-token-1', 'submitted', now(),
          '{"intake_kind":"screen"}'::jsonb, '["parq_joint_problem"]'::jsonb);
insert into public.assignments (tenant_id, client_id, program_id, active)
  values ((select v from fx where k='tenant'), (select v from fx where k='client3'), (select v from fx where k='program'), true);
set local role authenticated;
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='client3'));
  if c->'health'->>'state' <> 'flagged' or c->'health'->'flags' <> '["parq_joint_problem"]'::jsonb then raise exception 'TEST FAILED 15a: %', c->'health'; end if;
  insert into shown values ('A', c->'health'->'flags');
  raise notice 'ok 15a coach is shown A = %', c->'health'->'flags';
end $$;
reset role;
-- Another session edits the same intake (the update_client_onboarding path) to B.
update public.intake_forms set health_flags = '["parq_joint_problem","parq_heart_condition"]'::jsonb where id = (select v from fx where k='intake3');
set local role authenticated;
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake3'), (select flags from shown where k='A'), 'Knee checked, fine to train'),
  'review refused: the health screen changed since you opened it — reload and review the flags as they are now', '15b confirm A after the edit to B');
do $$ declare c jsonb; begin
  if exists (select 1 from public.health_screen_reviews where intake_id = (select v from fx where k='intake3')) then
    raise exception 'TEST FAILED 15c: the stale confirmation wrote a review'; end if;
  c := public.release_checklist((select v from fx where k='client3'));
  if c->'health'->>'state' <> 'flagged' or (c->'health'->>'ok')::boolean or (c->>'ready')::boolean then
    raise exception 'TEST FAILED 15c: health hold lifted by a stale confirmation: %', c->'health'; end if;
  raise notice 'ok 15c no review written, health still on hold';
end $$;
reset role;
select pg_temp.expect_error(format('select public.release_client(%L, false)', (select v from fx where k='client3')), 'release refused: Health screen flagged%', '15d release still refused');
set local role authenticated;
do $$ declare c jsonb; r jsonb; begin
  c := public.release_checklist((select v from fx where k='client3'));
  if c->'health'->'flags' <> '["parq_joint_problem","parq_heart_condition"]'::jsonb then raise exception 'TEST FAILED 15e: reload does not show B: %', c->'health'; end if;
  insert into shown values ('B', c->'health'->'flags');
  r := public.review_health_screen((select v from fx where k='intake3'), (select flags from shown where k='B'), 'Knee checked; cardiologist clearance letter on file');
  if r->>'status' <> 'reviewed' or r->'flags' <> (select flags from shown where k='B') then raise exception 'TEST FAILED 15e: %', r; end if;
  c := public.release_checklist((select v from fx where k='client3'));
  if c->'health'->>'state' <> 'flagged_reviewed' or not (c->>'ready')::boolean then raise exception 'TEST FAILED 15e: %', c; end if;
  raise notice 'ok 15e reload shows B, coach reviews B as authenticated, checklist ready';
end $$;
-- Same set, different order: fail closed (a new review is needed, never a silent match).
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake3'), '["parq_heart_condition","parq_joint_problem"]', 'reordered'),
  'review refused: the health screen changed since you opened it%', '15f reordered flags');
reset role;

-- 16. P28: the table itself refuses a whitespace-only note, even for a privileged writer.
select pg_temp.expect_error(format('insert into public.health_screen_reviews (tenant_id, client_id, intake_id, flags, note, reviewed_by) values (%L, %L, %L, %L, %L, %L)',
  (select v from fx where k='tenant'), (select v from fx where k='client3'), (select v from fx where k='intake3'), '["parq_joint_problem"]', E'\t\n\t\n', (select v from fx where k='coach')),
  '%violates check constraint "health_screen_reviews_note_check"%', '16a tabs/newlines note via table');
select pg_temp.expect_error(format('insert into public.health_screen_reviews (tenant_id, client_id, intake_id, flags, note, reviewed_by) values (%L, %L, %L, %L, %L, %L)',
  (select v from fx where k='tenant'), (select v from fx where k='client3'), (select v from fx where k='intake3'), '["parq_joint_problem"]', E'\u00a0 ok \u3000', (select v from fx where k='coach')),
  '%violates check constraint "health_screen_reviews_note_check"%', '16b two characters inside Unicode spaces via table');

-- 17. role-level denials under the real database roles.
--     A client of the same tenant, and a coach of another tenant, read nothing.
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'user_role', 'client',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.health_screen_reviews) <> 0 then raise exception 'TEST FAILED 17a: a client can read reviews'; end if;
  raise notice 'ok 17a client reads no reviews';
end $$;
reset role;
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='other_tenant'))::text, true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.health_screen_reviews) <> 0 then raise exception 'TEST FAILED 17b: another tenant''s coach can read reviews'; end if;
  raise notice 'ok 17b other-tenant coach reads no reviews';
end $$;
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
--     The tenant's own coach cannot update, delete or truncate reviews.
set local role authenticated;
select pg_temp.expect_error(format('update public.health_screen_reviews set note = %L where intake_id = %L', 'rewritten', (select v from fx where k='intake3')), 'permission denied%', '17c update as authenticated');
select pg_temp.expect_error(format('delete from public.health_screen_reviews where intake_id = %L', (select v from fx where k='intake3')), 'permission denied%', '17d delete as authenticated');
select pg_temp.expect_error('truncate public.health_screen_reviews', 'permission denied%', '17e truncate as authenticated');
reset role;
--     anon can neither read the table nor call the function.
set local role anon;
select pg_temp.expect_error('select count(*) from public.health_screen_reviews', 'permission denied%', '17f anon select');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake3'), '["parq_joint_problem"]', 'anon try'), 'permission denied for function review_health_screen', '17g anon execute');
reset role;
do $$ begin
  if (select count(*) from public.health_screen_reviews where intake_id = (select v from fx where k='intake3')) <> 1 then
    raise exception 'TEST FAILED 17: review rows changed under denied roles'; end if;
  raise notice 'ok 17 review rows unchanged after every denied attempt';
end $$;

-- 18. grants: execute for authenticated (not anon); no table write grant to authenticated.
do $$ begin
  if has_function_privilege('anon', 'public.review_health_screen(uuid, jsonb, text)', 'execute') then raise exception 'TEST FAILED 18: anon can execute'; end if;
  if not has_function_privilege('authenticated', 'public.review_health_screen(uuid, jsonb, text)', 'execute') then raise exception 'TEST FAILED 18: authenticated cannot execute'; end if;
  if has_table_privilege('authenticated', 'public.health_screen_reviews', 'insert') or has_table_privilege('authenticated', 'public.health_screen_reviews', 'update')
     or has_table_privilege('authenticated', 'public.health_screen_reviews', 'delete') then raise exception 'TEST FAILED 18: authenticated has a write grant'; end if;
  raise notice 'ok 18 grants: execute authenticated (not anon); no table write grant';
end $$;

-- 14. a suspended tenant cannot record a review (kept last: it suspends the test tenant).
update public.tenants set status = 'suspended' where id = (select v from fx where k='tenant');
update public.intake_forms set health_flags = '["parq_heart_condition","medications"]'::jsonb where id = (select v from fx where k='intake');
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L, %L)', (select v from fx where k='intake'), '["parq_heart_condition","medications"]', 'while paused'), 'This app is paused%', '14 suspended tenant');

rollback;
