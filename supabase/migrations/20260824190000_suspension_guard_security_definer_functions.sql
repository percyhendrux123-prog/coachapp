-- ============================================================================
-- Add a suspension check inside SECURITY DEFINER functions a coach can call.
--
-- The table-level guard (20260824180000 and the original
-- 20260728234500) cannot reach these: SECURITY DEFINER runs as `postgres`,
-- and the trigger deliberately exempts `postgres` so un-suspending stays
-- possible. That exemption is correct for the account-claim path it was
-- built for, but it also silently covers every OTHER SECURITY DEFINER
-- function — including ones a coach's own session can call today. Live
-- database check on 2026-08-24 confirmed `authenticated` can execute:
-- confirm_client_body_metrics, approve_program_draft, claim_client_invite,
-- complete_session, submit_checkin, schedule_client_checkins,
-- release_client_onboarding, assemble_client_meal_plan (via
-- assert_coach_owns_client). intake_match_or_create_client is reached
-- indirectly through the intake-submit / intake-onboard edge functions.
--
-- Two of the affected functions (assemble_client_meal_plan,
-- schedule_client_checkins, release_client_onboarding) already route through
-- shared ownership-check helpers (assert_coach_owns_client /
-- assert_coach_owns_onboarding) — fixing those two helpers covers all three
-- callers without touching the large function bodies at all, which is the
-- lower-risk edit. The remaining functions get the check added directly,
-- reproduced verbatim from the live definition plus one inserted check —
-- nothing else in any function body changes.
--
-- Each check reuses public.tenant_is_suspended(), the same helper and the
-- same user-facing copy the table trigger already uses.
--
-- Rollback: re-run each CREATE OR REPLACE with the check removed (the prior
-- bodies are preserved verbatim in this file's own history via git).
-- ============================================================================

-- --- assert_coach_owns_client: covers assemble_client_meal_plan, schedule_client_checkins ---
create or replace function public.assert_coach_owns_client(p_client_id uuid)
returns void
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare v_tenant uuid;
begin
  if auth.uid() is null then return; end if;  -- service_role / postgres
  select tenant_id into v_tenant from public.clients where id = p_client_id;
  if v_tenant is null then raise exception 'client not found'; end if;
  if public.current_app_role() is distinct from 'coach'
     or public.current_tenant_id() is distinct from v_tenant then
    raise exception 'not authorised: this client is not yours';
  end if;
  if public.tenant_is_suspended(v_tenant) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;
end $$;

-- --- assert_coach_owns_onboarding: covers release_client_onboarding ---
create or replace function public.assert_coach_owns_onboarding(p_onboarding_id uuid)
returns void
language plpgsql
stable security definer
set search_path to 'public'
as $$
declare v_tenant uuid;
begin
  if auth.uid() is null then return; end if;
  select tenant_id into v_tenant from public.client_onboarding where id = p_onboarding_id;
  if v_tenant is null then raise exception 'onboarding record not found'; end if;
  if public.current_app_role() is distinct from 'coach'
     or public.current_tenant_id() is distinct from v_tenant then
    raise exception 'not authorised: this onboarding record is not yours';
  end if;
  if public.tenant_is_suspended(v_tenant) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;
end $$;

-- --- confirm_client_body_metrics ---
create or replace function public.confirm_client_body_metrics(p_client_id uuid, p_age integer DEFAULT NULL::integer, p_sex text DEFAULT NULL::text, p_height_in numeric DEFAULT NULL::numeric, p_weight_lb numeric DEFAULT NULL::numeric, p_goal_weight_lb numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid;
  v_caller   uuid := auth.uid();
  v_role     text;
  v_missing  text[] := '{}';
  v_bad      text[] := '{}';
  v_client   public.clients%rowtype;
begin
  if v_caller is null then
    raise exception 'confirm_client_body_metrics: authentication required' using errcode = '42501';
  end if;

  select tenant_id, role into v_tenant, v_role
    from public.profiles where user_id = v_caller;
  if v_role is distinct from 'coach' then
    raise exception 'confirm_client_body_metrics: coach only' using errcode = '42501';
  end if;
  if public.tenant_is_suspended(v_tenant) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'confirm_client_body_metrics: no such client' using errcode = 'P0002';
  end if;
  if v_client.tenant_id is distinct from v_tenant then
    raise exception 'confirm_client_body_metrics: client is not in your tenant' using errcode = '42501';
  end if;

  -- Every value is required. A partial confirmation would leave the record in exactly the
  -- state this function exists to end -- half-populated, and therefore trusted.
  if p_age            is null then v_missing := v_missing || 'age';            end if;
  if nullif(btrim(coalesce(p_sex,'')),'') is null
                             then v_missing := v_missing || 'sex';             end if;
  if p_height_in      is null then v_missing := v_missing || 'height';         end if;
  if p_weight_lb      is null then v_missing := v_missing || 'weight';         end if;
  if p_goal_weight_lb is null then v_missing := v_missing || 'goal weight';    end if;

  if array_length(v_missing, 1) is not null then
    return jsonb_build_object(
      'status','refused', 'reason','incomplete', 'missing', to_jsonb(v_missing),
      'detail', format(
        'Not written. These are still unstated: %s. A body metric is a fact about one '
        'specific person; the record stays empty until someone supplies it, because an '
        'empty field asks a question and a filled-in guess ends one.',
        array_to_string(v_missing, ', ')));
  end if;

  -- Range checks. Out of range is treated as unstated, never clamped: a clamp is a quieter
  -- way of substituting a number nobody supplied.
  if p_age < 14 or p_age > 90                     then v_bad := v_bad || format('age %s is outside 14-90', p_age); end if;
  if p_sex not in ('male','female','other')       then v_bad := v_bad || format('sex "%s" is not male, female or other', p_sex); end if;
  if p_height_in < 48 or p_height_in > 90         then v_bad := v_bad || format('height %s in is outside 4''0"-7''6"', p_height_in); end if;
  if p_weight_lb < 70 or p_weight_lb > 600        then v_bad := v_bad || format('weight %s lb is outside 70-600', p_weight_lb); end if;
  if p_goal_weight_lb < 70 or p_goal_weight_lb > 600 then v_bad := v_bad || format('goal weight %s lb is outside 70-600', p_goal_weight_lb); end if;

  if array_length(v_bad, 1) is not null then
    return jsonb_build_object(
      'status','refused', 'reason','out_of_range', 'problems', to_jsonb(v_bad),
      'detail', array_to_string(v_bad, '; ') || '. Nothing was written.');
  end if;

  -- Imperial in; the sync trigger derives kg and cm.
  update public.clients
     set age            = p_age,
         sex            = lower(btrim(p_sex)),
         height_in      = p_height_in,
         weight_lb      = p_weight_lb,
         goal_weight_lb = p_goal_weight_lb,
         unit_pref      = coalesce(unit_pref, 'imperial'),
         updated_at     = now()
   where id = p_client_id
   returning * into v_client;

  -- Clear the blockers this confirmation actually answers, on every open onboarding for
  -- this client. Blockers for anything else are left exactly where they are.
  update public.client_onboarding co
     set blockers = (
           select coalesce(jsonb_agg(b), '[]'::jsonb)
             from jsonb_array_elements(co.blockers) b
            where b->>'code' not in (
              'intake_missing_age', 'intake_missing_sex', 'intake_missing_height_cm',
              'intake_missing_weight_kg', 'intake_missing_goal_weight_kg', 'missing_goal_weight')),
         updated_at = now()
   where co.client_id = p_client_id;

  perform public.onboarding_recompute_stage(co.id)
     from public.client_onboarding co where co.client_id = p_client_id;

  return jsonb_build_object(
    'status','confirmed',
    'client_id', p_client_id,
    'confirmed_by', v_caller,
    'confirmed_at', now(),
    'imperial', jsonb_build_object(
      'age', v_client.age, 'sex', v_client.sex, 'height_in', v_client.height_in,
      'weight_lb', v_client.weight_lb, 'goal_weight_lb', v_client.goal_weight_lb),
    -- Echoed back so the caller can see what the generator will actually read, rather than
    -- trusting that the conversion happened.
    'metric_derived', jsonb_build_object(
      'height_cm', v_client.height_cm, 'weight_kg', v_client.weight_kg,
      'goal_weight_kg', v_client.goal_weight_kg),
    'note', case when v_client.sex = 'other'
      then 'Recorded. Note: the Mifflin-St Jeor equation the generator uses has coefficients '
           'for male and female only. It has none for "other", so it will still decline to '
           'compute a calorie target for this client and the coach sets it by hand. That is a '
           'limit of the formula, stated rather than papered over.'
      else 'Recorded. The generator reads the derived metric values above.' end);
end $function$;

-- --- approve_program_draft ---
create or replace function public.approve_program_draft(p_draft_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d public.program_drafts%rowtype;
  pid uuid;
begin
  if coalesce(public.current_app_role(),'') is distinct from 'coach' then
    raise exception 'not authorized: coach role required';
  end if;
  select * into d from public.program_drafts where id = p_draft_id;
  if not found then raise exception 'draft % not found', p_draft_id; end if;
  if public.current_tenant_id() is null or d.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'not authorized: wrong tenant';
  end if;
  if public.tenant_is_suspended(d.tenant_id) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;
  if d.status not in ('draft','held_medical') then
    raise exception 'draft % is not pending (status %)', p_draft_id, d.status;
  end if;

  if p_decision = 'approve' then
    if d.status = 'held_medical' and jsonb_array_length(coalesce(d.training->'days','[]'::jsonb)) = 0 then
      raise exception 'medical hold: build/modify the plan before approving (no auto plan exists)';
    end if;
    update public.program_drafts
      set status='approved', decided_at=now(), decided_by=auth.uid(), decision_note=p_note
      where id = d.id;
    pid := public.publish_program_draft(d.id);
    return jsonb_build_object('status','published','program_id',pid,'draft_id',d.id);
  elsif p_decision = 'reject' then
    update public.program_drafts
      set status='rejected', decided_at=now(), decided_by=auth.uid(), decision_note=p_note
      where id = d.id;
    return jsonb_build_object('status','rejected','draft_id',d.id);
  else
    raise exception 'unknown decision: %', p_decision;
  end if;
end;
$function$;

-- --- claim_client_invite ---
-- Follows this function's own convention (returns a text status, never raises)
-- rather than the exception form used elsewhere in this migration.
create or replace function public.claim_client_invite(p_token text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  v_confirmed timestamptz;
  v_client public.clients;
  v_role text;
begin
  if uid is null then return 'not_authenticated'; end if;
  if p_token is null or length(p_token) < 16 then return 'invalid'; end if;

  select email_confirmed_at into v_confirmed from auth.users where id = uid;
  if v_confirmed is null then return 'unconfirmed'; end if;

  select * into v_client from public.clients where invite_token = p_token;
  if not found then return 'invalid'; end if;

  if v_client.invite_expires_at is not null and v_client.invite_expires_at < now() then
    return 'expired';
  end if;

  if v_client.client_user_id is not null then
    if v_client.client_user_id = uid then return 'already_yours'; end if;
    return 'already_claimed';
  end if;

  if exists (select 1 from public.clients where client_user_id = uid) then
    return 'other_client';
  end if;

  select role::text into v_role from public.profiles where user_id = uid;
  if v_role is not null and v_role <> 'client' then return 'role_conflict'; end if;

  if public.tenant_is_suspended(v_client.tenant_id) then
    return 'tenant_suspended';
  end if;

  update public.clients
     set client_user_id    = uid,
         status            = case when status = 'invited' then 'active'::client_status else status end,
         invite_token      = null,
         invite_expires_at = null,
         updated_at        = now()
   where id = v_client.id;

  insert into public.profiles (user_id, role, tenant_id)
  values (uid, 'client', v_client.tenant_id)
  on conflict (user_id) do nothing;

  return 'claimed';
end;
$function$;

-- --- complete_session ---
create or replace function public.complete_session(p_session_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cid uuid := public.current_client_id(); tid uuid := public.current_tenant_id(); s public.workout_sessions;
begin
  select * into s from public.workout_sessions where id = p_session_id;
  if s.id is null or s.client_id <> cid then raise exception 'not your session'; end if;
  if public.tenant_is_suspended(tid) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;
  update public.workout_sessions set status = 'complete', completed_at = now(), updated_at = now() where id = p_session_id;
  update public.assignments set current_day_index = current_day_index + 1, updated_at = now() where id = s.assignment_id and client_id = cid;
end $function$;

-- --- submit_checkin ---
create or replace function public.submit_checkin(p_weight numeric DEFAULT NULL::numeric, p_photo_urls jsonb DEFAULT '[]'::jsonb, p_answers jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cid uuid := public.current_client_id(); tid uuid := public.current_tenant_id(); ck uuid; ph jsonb;
begin
  if cid is null then raise exception 'not a client'; end if;
  if public.tenant_is_suspended(tid) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;
  insert into public.checkins(tenant_id, client_id, weight, photo_urls, answers) values (tid, cid, p_weight, p_photo_urls, p_answers) returning id into ck;
  if p_weight is not null then
    insert into public.progress_weights(tenant_id, client_id, date, weight, source_checkin_id) values (tid, cid, (now() at time zone 'utc')::date, p_weight, ck);
  end if;
  for ph in select * from jsonb_array_elements(coalesce(p_photo_urls, '[]'::jsonb)) loop
    insert into public.progress_photos(tenant_id, client_id, photo_url, pose_tag, source_checkin_id) values (tid, cid, ph ->> 'url', ph ->> 'pose_tag', ck);
  end loop;
  return ck;
end $function$;

-- --- intake_match_or_create_client ---
-- Called from the intake-submit / intake-onboard edge functions, which run with the
-- service role — auth.uid() is null there, so this check cannot gate on caller identity
-- the way the coach-session functions above do. It gates on the submission's own tenant
-- instead, and follows the function's existing convention of a blocked jsonb result.
create or replace function public.intake_match_or_create_client(p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s            public.intake_submissions%rowtype;
  v_email      text;
  v_matches    int;
  v_client     public.clients%rowtype;
  v_client_id  uuid;
  v_onb_id     uuid;
  v_outcome    text;
begin
  select * into s from public.intake_submissions where id = p_submission_id;
  if not found then return jsonb_build_object('status','error','reason','submission_not_found'); end if;

  if public.tenant_is_suspended(s.tenant_id) then
    return jsonb_build_object('status','blocked','reason','tenant_suspended',
      'detail','This coach''s app is paused (hosting subscription lapsed). New clients cannot '
               'be created from intake until it is reactivated.');
  end if;

  v_email := lower(nullif(trim(s.email), ''));
  if v_email is null then
    return jsonb_build_object('status','blocked','reason','no_email',
      'detail','The submission carries no email address. An account cannot be created and the '
               'client cannot sign in. Ask for the address before onboarding.');
  end if;

  if s.client_id is not null then
    select id into v_onb_id from public.client_onboarding
      where submission_id = s.id and client_id = s.client_id;
    return jsonb_build_object('status','ok','outcome','already_converted',
      'client_id', s.client_id, 'onboarding_id', v_onb_id);
  end if;

  select count(*) into v_matches
    from public.clients c
   where c.tenant_id = s.tenant_id and lower(trim(c.email)) = v_email;

  if v_matches > 1 then
    return jsonb_build_object('status','blocked','reason','ambiguous_email_match',
      'detail', format('%s existing client records in this tenant share the address %s. '
                       'Which one this submission belongs to is not knowable from the data. '
                       'Merge or correct the duplicates before converting.', v_matches, v_email));
  end if;

  if v_matches = 1 then
    select * into v_client from public.clients c
      where c.tenant_id = s.tenant_id and lower(trim(c.email)) = v_email;
    v_client_id := v_client.id;
    v_outcome := 'matched_existing';
  else
    insert into public.clients (tenant_id, display_name, email, status)
    values (s.tenant_id,
            coalesce(nullif(trim(s.full_name), ''), split_part(v_email,'@',1)),
            v_email, 'invited')
    returning * into v_client;
    v_client_id := v_client.id;
    v_outcome := 'created';
  end if;

  -- Carry the lifestyle/prep switch forward. CHECK-constrained on both sides, so an
  -- unstated value stays NULL and becomes a named blocker below.
  --
  -- CHANGED 2026-07-31: goal_weight_lb is no longer parsed from the raw string here.
  -- parse_goal_weight_lb() reads "165-170" as 167.5 and stores it in a POUNDS column
  -- without the form ever having said pounds. That is the same unit assumption that made
  -- a 95 kg client indistinguishable from a 210 kg one -- silently, and on the field the
  -- protein target is computed from. Goal weight now arrives only through
  -- confirm_client_body_metrics(), where a human states the unit.
  update public.clients
     set client_type = coalesce(client_type, s.client_type),
         updated_at  = now()
   where id = v_client_id;

  update public.client_allergies
     set client_id = v_client_id, updated_at = now()
   where submission_id = s.id and client_id is null;
  update public.client_dietary_restrictions
     set client_id = v_client_id, updated_at = now()
   where submission_id = s.id and client_id is null;

  update public.intake_submissions
     set client_id = v_client_id, status = 'converted', reviewed_at = coalesce(reviewed_at, now()),
         updated_at = now()
   where id = s.id;

  -- The onboarding row is created BEFORE any blocker is raised against it. This ordering
  -- is the bug fix: every blocker below now has a row to land on.
  insert into public.client_onboarding (tenant_id, client_id, submission_id, stage)
  values (s.tenant_id, v_client_id, s.id, 'started')
  on conflict (client_id, submission_id) do update set updated_at = now()
  returning id into v_onb_id;

  if (select goal_weight_lb from public.clients where id = v_client_id) is null then
    perform public.onboarding_add_blocker(v_onb_id, 'missing_goal_weight',
      format('No confirmed goal weight on this client. The intake said "%s", which carries no '
             'unit, so it was not written. Protein is computed off goal weight and is never '
             'substituted with current weight. Confirm it under Profile -> body metrics.',
             coalesce(nullif(s.goal_weight_raw,''), '(blank)')), 'block');
  end if;

  if v_outcome = 'matched_existing'
     and nullif(trim(s.full_name),'') is not null
     and lower(trim(v_client.display_name)) <> lower(trim(s.full_name)) then
    perform public.onboarding_add_blocker(v_onb_id, 'name_mismatch',
      format('The submission says "%s"; the existing record on %s says "%s". Same address, '
             'different name -- confirm this is the same person before releasing.',
             trim(s.full_name), v_email, v_client.display_name), 'review');
  end if;

  if (select client_type from public.clients where id = v_client_id) is null then
    perform public.onboarding_add_blocker(v_onb_id, 'client_type_unstated',
      'The intake did not state lifestyle or competition prep. This changes both the training '
      'draft and the meal assembly, so it cannot be assumed. Set it on the client record and '
      're-run.', 'block');
  end if;

  -- Body metrics have never been written by anything. Say so on every new onboarding
  -- rather than letting the generator discover it three steps later.
  if exists (
    select 1 from public.clients
     where id = v_client_id
       and (age is null or sex is null or height_in is null or weight_lb is null))
  then
    perform public.onboarding_add_blocker(v_onb_id, 'body_metrics_unconfirmed',
      format('Body metrics are not confirmed on this client. The intake carried age "%s", '
             'height "%s", weight "%s" as raw text, and the form does not ask sex at all. '
             'Nothing is read from those strings automatically. Open Profile -> body metrics, '
             'check them against the intake and confirm.',
             coalesce(nullif(s.age_raw,''),'(blank)'),
             coalesce(nullif(s.height_raw,''),'(blank)'),
             coalesce(nullif(s.weight_raw,''),'(blank)')), 'block');
  end if;

  return jsonb_build_object('status','ok','outcome',v_outcome,
    'client_id', v_client_id, 'onboarding_id', v_onb_id, 'email', v_email);
end $function$;
