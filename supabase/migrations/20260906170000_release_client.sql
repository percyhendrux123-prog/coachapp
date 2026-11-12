-- Slice 3 of the original design notes (not included) — one release.
--
-- D6: clients.nutrition_declined_at records the coach's explicit choice "no nutrition plan
-- for this client" (training-only coaching). It satisfies the release checklist and the
-- status view's nutrition item; it is never inferred, only set by release_client(…, true).
alter table public.clients add column if not exists nutrition_declined_at timestamptz null;
comment on column public.clients.nutrition_declined_at is
  'Coach recorded "no nutrition plan for this client" (D6). Set only by release_client(p_no_nutrition => true). NULL = not declined.';

-- release_checklist(): the three items as they stand, for the Release button to render
-- before anything is written. Same rules as release_client(); read-only.
create or replace function public.release_checklist(p_client_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public as $fn$
declare
  cli          public.clients%rowtype;
  v_live       boolean;
  v_draft      public.program_drafts%rowtype;
  v_days       int := 0;
  v_assigned   boolean;
  v_splan_id   uuid;
  v_slots      int := 0;
  v_lplan_id   uuid;
  v_held       public.program_drafts%rowtype;
  v_intake     public.intake_forms%rowtype;
  v_flags      jsonb;
  v_reviewed   boolean := false;
  v_program    jsonb;
  v_nutrition  jsonb;
  v_email      jsonb;
  v_health     jsonb;
begin
  if coalesce(public.current_app_role(), '') is distinct from 'coach' then
    raise exception 'not authorized: coach role required';
  end if;
  select * into cli from public.clients where id = p_client_id;
  if not found then raise exception 'client % not found', p_client_id; end if;
  if public.current_tenant_id() is null or cli.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'not authorized: wrong tenant';
  end if;

  -- 1. program
  select exists (select 1 from public.assignments a where a.client_id = cli.id and a.active) into v_live;
  select * into v_draft from public.program_drafts d
   where d.client_id = cli.id and d.status in ('draft','approved')
   order by d.generated_at desc limit 1;
  if found then v_days := jsonb_array_length(coalesce(v_draft.training->'days','[]'::jsonb)); end if;
  -- A medical hold is a program state the coach must resolve in Programs; release never
  -- approves a held draft on the coach's behalf.
  select * into v_held from public.program_drafts d
   where d.client_id = cli.id and d.status = 'held_medical'
   order by d.generated_at desc limit 1;
  v_program := case
    when v_live then jsonb_build_object('ok', true, 'state', 'live', 'detail', 'Program live')
    when v_draft.id is null and v_held.id is not null then jsonb_build_object('ok', false, 'state', 'held_medical', 'detail', 'Program draft held for medical review — review and approve it in Programs first')
    when v_draft.id is not null and v_days > 0 then jsonb_build_object('ok', true, 'state', 'draft', 'detail', format('Program draft (%s day%s)', v_days, case when v_days = 1 then '' else 's' end), 'draft_id', v_draft.id)
    when v_draft.id is not null then jsonb_build_object('ok', false, 'state', 'empty_draft', 'detail', 'Program draft has no training days')
    else jsonb_build_object('ok', false, 'state', 'none', 'detail', 'No program draft') end;

  -- 2. nutrition — structured (client_meal_plans) first, then the legacy meal_plans table.
  select exists (select 1 from public.client_meal_plans m where m.client_id = cli.id and m.status = 'assigned')
      or exists (select 1 from public.meal_plans l where l.client_id = cli.id and (l.assigned_at is not null or l.status = 'assigned'))
    into v_assigned;
  select m.id into v_splan_id from public.client_meal_plans m
   where m.client_id = cli.id and m.status = 'draft' order by m.created_at desc limit 1;
  if v_splan_id is not null then
    select count(*) into v_slots from public.client_meal_plan_slots s where s.plan_id = v_splan_id;
  end if;
  select l.id into v_lplan_id from public.meal_plans l
   where l.client_id = cli.id and l.assigned_at is null and coalesce(l.status,'draft') = 'draft'
   order by l.created_at desc limit 1;
  v_nutrition := case
    when v_assigned then jsonb_build_object('ok', true, 'state', 'assigned', 'detail', 'Nutrition assigned')
    when cli.nutrition_declined_at is not null then jsonb_build_object('ok', true, 'state', 'declined', 'detail', 'No nutrition plan (recorded ' || to_char(cli.nutrition_declined_at, 'YYYY-MM-DD') || ')')
    when v_splan_id is not null and v_slots > 0 then jsonb_build_object('ok', true, 'state', 'draft', 'detail', format('Nutrition (%s meal%s)', v_slots, case when v_slots = 1 then '' else 's' end), 'plan_id', v_splan_id, 'source', 'structured')
    when v_splan_id is not null then jsonb_build_object('ok', false, 'state', 'empty_draft', 'detail', 'Nutrition draft has no meals')
    when v_lplan_id is not null then jsonb_build_object('ok', true, 'state', 'draft', 'detail', 'Nutrition (uploaded plan)', 'plan_id', v_lplan_id, 'source', 'legacy')
    else jsonb_build_object('ok', false, 'state', 'none', 'detail', 'No nutrition plan — or tick "no nutrition for this client"') end;

  -- 3. email — present AND syntactically valid (one @, something either side, a dot after).
  v_email := case
    when nullif(trim(coalesce(cli.email, '')), '') is null then jsonb_build_object('ok', false, 'state', 'missing', 'detail', 'Email missing')
    when trim(cli.email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then jsonb_build_object('ok', false, 'state', 'invalid', 'detail', 'Email looks invalid: ' || cli.email)
    else jsonb_build_object('ok', true, 'state', 'valid', 'detail', 'Email ' || trim(cli.email)) end;

  -- 4. health / compliance — authoritative at the database boundary. Reads the latest
  -- SUBMITTED intake's health_flags (written by intake-submit from the PAR-Q answers).
  -- Fails closed: no screen on record, or an unreadable one, blocks; a flagged screen
  -- blocks unless a coach has explicitly reviewed it — the only clearance this app records
  -- is a coach approving the draft that carried the flags (approve_program_draft on the held
  -- draft, decided_by set). Nothing here infers clearance.
  select * into v_intake from public.intake_forms i
   where i.client_id = cli.id and i.status = 'submitted'
   order by i.submitted_at desc nulls last, i.created_at desc limit 1;
  if v_intake.id is null then
    v_health := jsonb_build_object('ok', false, 'state', 'no_screen', 'detail', 'No health screen on record — a submitted intake is required');
  elsif jsonb_typeof(v_intake.health_flags) is distinct from 'array' then
    v_health := jsonb_build_object('ok', false, 'state', 'unreadable', 'detail', 'Health screen not readable — fix the intake record before releasing');
  elsif jsonb_array_length(v_intake.health_flags) = 0 then
    v_health := jsonb_build_object('ok', true, 'state', 'clear', 'detail', 'Health screen clear');
  else
    v_flags := v_intake.health_flags;
    select exists (select 1 from public.program_drafts d
                    where d.intake_id = v_intake.id and d.status in ('approved', 'published')
                      and d.decided_by is not null) into v_reviewed;
    v_health := case
      when v_reviewed then jsonb_build_object('ok', true, 'state', 'flagged_reviewed', 'flags', v_flags,
                              'detail', 'Health screen flagged, reviewed and approved by coach')
      else jsonb_build_object('ok', false, 'state', 'flagged', 'flags', v_flags,
                              'detail', 'Health screen flagged (' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_flags) x) || ') — review and approve the held draft in Programs first') end;
  end if;

  return jsonb_build_object(
    'client_id', cli.id,
    'program', v_program, 'nutrition', v_nutrition, 'email', v_email, 'health', v_health,
    'invite_state', case when cli.client_user_id is not null then 'claimed'
                         when cli.invite_token is null then 'none'
                         when cli.invite_expires_at < now() then 'expired' else 'pending' end,
    'ready', (v_program->>'ok')::boolean and (v_nutrition->>'ok')::boolean and (v_email->>'ok')::boolean and (v_health->>'ok')::boolean);
end $fn$;

-- release_client(): the one button. Refuses with the FIRST missing item named (program /
-- nutrition / email / health); otherwise, in one transaction: publish the draft (existing
-- publish_program_draft path), assign the nutrition draft (releaseStructuredPlan /
-- releaseMealPlan logic, server-side), mint the invite token (client-invite's token logic)
-- and return its claim_path. Any failure rolls back everything: no half-released client.
--
-- Never silently partial, end to end: the auth account cannot be created inside SQL, so the
-- SPA pre-creates it FIRST via client-invite {account_only: true} — an unconfirmed,
-- passwordless account with no invite token is inert and idempotent — and only then calls
-- this function. If the account step fails nothing has been released; if this function
-- fails nothing has been released; if both succeed the claim link returned here is the
-- one the client receives. No second token mint after release.
create or replace function public.release_client(p_client_id uuid, p_no_nutrition boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public as $fn$
declare
  cli          public.clients%rowtype;
  chk          jsonb;
  v_draft_id   uuid;
  v_program_id uuid;
  v_program    jsonb;
  v_nutrition  jsonb;
  v_plan_id    uuid;
  v_token      text;
  v_expires    timestamptz;
begin
  -- release_checklist() carries the role + tenant checks; a refusal there is a refusal here.
  chk := public.release_checklist(p_client_id);
  -- Serialise concurrent releases of the same client: the second waits, then re-reads.
  select * into cli from public.clients where id = p_client_id for update;
  chk := public.release_checklist(p_client_id);
  if public.tenant_is_suspended(cli.tenant_id) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;

  -- Checklist, first missing item named. p_no_nutrition satisfies item 2 only when nothing
  -- else does; it never overrides a plan that exists.
  if not (chk->'program'->>'ok')::boolean then
    raise exception 'release refused: %', chk->'program'->>'detail' using errcode = 'P0001', hint = 'program';
  end if;
  -- The D6 tick only stands in for NOTHING. An empty draft is a draft to fix, not a decline.
  if not (chk->'nutrition'->>'ok')::boolean and not (p_no_nutrition and chk->'nutrition'->>'state' = 'none') then
    raise exception 'release refused: %', chk->'nutrition'->>'detail' using errcode = 'P0001', hint = 'nutrition';
  end if;
  if not (chk->'email'->>'ok')::boolean then
    raise exception 'release refused: %', chk->'email'->>'detail' using errcode = 'P0001', hint = 'email';
  end if;
  if not (chk->'health'->>'ok')::boolean then
    raise exception 'release refused: %', chk->'health'->>'detail' using errcode = 'P0001', hint = 'health';
  end if;

  -- 1. program: publish through the existing path, or leave a live assignment alone.
  if chk->'program'->>'state' = 'live' then
    select a.program_id into v_program_id from public.assignments a where a.client_id = cli.id and a.active limit 1;
    v_program := jsonb_build_object('action', 'already_live', 'program_id', v_program_id);
  else
    v_draft_id := (chk->'program'->>'draft_id')::uuid;
    update public.program_drafts
       set status = 'approved', decided_at = coalesce(decided_at, now()), decided_by = coalesce(decided_by, auth.uid()),
           decision_note = coalesce(decision_note, 'released via release_client')
     where id = v_draft_id and status = 'draft';
    v_program_id := public.publish_program_draft(v_draft_id);
    v_program := jsonb_build_object('action', 'published', 'program_id', v_program_id, 'draft_id', v_draft_id);
  end if;

  -- 2. nutrition
  if chk->'nutrition'->>'state' in ('assigned', 'declined') then
    v_nutrition := jsonb_build_object('action', 'already_' || (chk->'nutrition'->>'state'));
  elsif chk->'nutrition'->>'state' = 'draft' then
    v_plan_id := (chk->'nutrition'->>'plan_id')::uuid;
    if chk->'nutrition'->>'source' = 'structured' then
      -- releaseStructuredPlan(): two columns, status-guarded, never nulls an assigned_at.
      update public.client_meal_plans set status = 'assigned', assigned_at = now(), updated_at = now()
       where id = v_plan_id and status = 'draft';
    else
      -- releaseMealPlan(): the legacy table, same two-column write.
      update public.meal_plans set status = 'assigned', assigned_at = now(), updated_at = now()
       where id = v_plan_id and assigned_at is null;
    end if;
    if not found then raise exception 'release: nutrition plan % was not in draft state', v_plan_id; end if;
    v_nutrition := jsonb_build_object('action', 'assigned', 'plan_id', v_plan_id, 'source', chk->'nutrition'->>'source');
  else
    -- p_no_nutrition, and nothing else satisfied the item: record the choice (D6).
    update public.clients set nutrition_declined_at = now(), updated_at = now() where id = cli.id;
    v_nutrition := jsonb_build_object('action', 'declined');
  end if;

  -- 3. invite token (client-invite's minting; the SPA calls that function next for the auth account).
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_expires := now() + interval '14 days';
  update public.clients
     set invite_token = v_token, invite_expires_at = v_expires, updated_at = now()
   where id = cli.id;

  return jsonb_build_object(
    'status', 'released',
    'client_id', cli.id,
    'program', v_program,
    'nutrition', v_nutrition,
    'invite', jsonb_build_object('token_minted', true, 'expires_at', v_expires,
                                 'claim_path', '/claim?token=' || v_token,
                                 'already_claimed', cli.client_user_id is not null),
    'needs_account', cli.client_user_id is null,
    'email', cli.email);
end $fn$;

revoke all on function public.release_checklist(uuid) from public, anon;
revoke all on function public.release_client(uuid, boolean) from public, anon;
grant execute on function public.release_checklist(uuid) to authenticated, service_role;
grant execute on function public.release_client(uuid, boolean) to authenticated, service_role;
comment on function public.release_client(uuid, boolean) is
  'Slice 3: one release. Coach-only, tenant-checked. Refuses naming the first missing item (program / nutrition / email); otherwise publishes the draft, assigns nutrition (or records D6 decline), mints the invite token — atomically. SPA calls client-invite next for the auth account.';

-- ---------- client_onboarding_facts: nutrition_state gains 'declined' (D6) ----------
-- Verbatim re-issue of 20260906150000's function with one CASE branch added.
create or replace function public.client_onboarding_facts(p_tenant_id uuid default null)
returns table (
  client_id uuid,
  display_name text,
  client_status text,
  paid_via_platform boolean,
  intake_state text,
  intake_sent_at timestamptz,
  intake_expires_at timestamptz,
  intake_submitted_at timestamptz,
  draft_state text,
  program_live boolean,
  nutrition_state text,
  invite_state text,
  invite_expires_at timestamptz,
  opened_app boolean,
  first_set_logged boolean,
  first_checkin boolean,
  stalled_since timestamptz,
  stalled_days integer,
  next_action text
)
language plpgsql stable security invoker
set search_path = public as $fn$
declare
  v_tenant uuid := coalesce(p_tenant_id, current_tenant_id());
begin
  if v_tenant is null then
    raise exception 'client_onboarding_facts: no tenant in session';
  end if;
  -- A signed-in user (coach JWT) may only read their own tenant. The service role and a
  -- direct database session (SQL editor, migrations) may pass any tenant.
  if auth.uid() is not null and auth.role() is distinct from 'service_role'
     and v_tenant is distinct from current_tenant_id() then
    raise exception 'client_onboarding_facts: tenant mismatch';
  end if;

  return query
  with c as (
    select cl.* from clients cl where cl.tenant_id = v_tenant and cl.status <> 'archived'
  ),
  intake as (
    select distinct on (i.client_id) i.client_id, i.status, i.created_at, i.expires_at, i.submitted_at
    from intake_forms i where i.tenant_id = v_tenant order by i.client_id, i.created_at desc
  ),
  draft as (
    select distinct on (d.client_id) d.client_id, d.status, d.generated_at, d.decided_at
    from program_drafts d where d.tenant_id = v_tenant order by d.client_id, d.generated_at desc
  ),
  asg as (
    select a.client_id, bool_or(a.active) as live, max(a.assigned_at) as assigned_at
    from assignments a where a.tenant_id = v_tenant group by a.client_id
  ),
  -- Nutrition lives in TWO tables: client_meal_plans (structured, current) and meal_plans
  -- (the older uploaded/legacy plans, still assigned for some clients — 5 of 35 on
  -- 2026-09-06 had a plan ONLY there). A client is "assigned" if either table says so.
  mp_all as (
    select m.client_id, m.status, m.assigned_at, m.updated_at
    from client_meal_plans m where m.tenant_id = v_tenant
    union all
    select l.client_id,
           case when l.assigned_at is not null or l.status = 'assigned' then 'assigned' else 'draft' end,
           l.assigned_at, l.updated_at
    from meal_plans l where l.tenant_id = v_tenant
  ),
  mp as (
    select x.client_id,
           bool_or(x.status = 'assigned') as assigned,
           bool_or(x.status = 'draft') as drafted,
           max(x.assigned_at) as assigned_at,
           max(x.updated_at) as updated_at
    from mp_all x group by x.client_id
  ),
  -- A logged set lives in workout_logs (done = true). history_workout_sets is the Trainerize
  -- import table and was empty for every client on 2026-09-06 — the plan named it, the data
  -- said otherwise. Both are read so an imported history still counts.
  sets as (
    select x.client_id, true as any_set from (
      select l.client_id from workout_logs l where l.tenant_id = v_tenant and l.done
      union all
      select h.client_id from history_workout_sets h where h.tenant_id = v_tenant
    ) x group by x.client_id
  ),
  sess as (
    select w.client_id, max(w.session_date) as last_session from workout_sessions w where w.tenant_id = v_tenant group by w.client_id
  ),
  ck as (
    select k.client_id, max(k.submitted_at) as last_checkin from checkins k where k.tenant_id = v_tenant group by k.client_id
  ),
  facts as (
    select
      c.id,
      c.display_name,
      c.status::text as client_status,
      case when c.stripe_checkout_session_id is not null then true else null end as paid_via_platform,
      case
        when i.client_id is null then 'none'
        when i.status = 'submitted' then 'submitted'
        when i.expires_at < now() then 'expired'
        else 'pending' end as intake_state,
      i.created_at as intake_sent_at,
      i.expires_at as intake_expires_at,
      i.submitted_at as intake_submitted_at,
      coalesce(d.status::text, 'none') as draft_state,
      coalesce(a.live, false) as program_live,
      -- D6 (Slice 3): a coach may record 'no nutrition plan for this client'. That is a
      -- satisfied checklist item, not a missing plan — it must never read as 'none'.
      case when m.assigned then 'assigned'
           when c.nutrition_declined_at is not null then 'declined'
           when m.drafted then 'draft' else 'none' end as nutrition_state,
      case
        when c.client_user_id is not null then 'claimed'
        when c.invite_token is null then 'none'
        when c.invite_expires_at < now() then 'expired'
        else 'pending' end as invite_state,
      c.invite_expires_at,
      coalesce(c.welcome_seen, false) as opened_app,
      coalesce(s.any_set, false) as first_set_logged,
      (ck.last_checkin is not null) as first_checkin,
      greatest(c.joined_at, c.updated_at, i.created_at, i.submitted_at, d.generated_at, d.decided_at,
               a.assigned_at, m.assigned_at, m.updated_at, se.last_session::timestamptz, ck.last_checkin) as stalled_since
    from c
    left join intake i on i.client_id = c.id
    left join draft  d on d.client_id = c.id
    left join asg    a on a.client_id = c.id
    left join mp     m on m.client_id = c.id
    left join sets   s on s.client_id = c.id
    left join sess   se on se.client_id = c.id
    left join ck     on ck.client_id = c.id
  )
  select
    f.id, f.display_name, f.client_status, f.paid_via_platform,
    f.intake_state, f.intake_sent_at, f.intake_expires_at, f.intake_submitted_at,
    f.draft_state, f.program_live, f.nutrition_state,
    f.invite_state, f.invite_expires_at,
    f.opened_app, f.first_set_logged, f.first_checkin,
    f.stalled_since,
    greatest(0, floor(extract(epoch from (now() - coalesce(f.stalled_since, now()))) / 86400))::int as stalled_days,
    case
      when not f.program_live and f.intake_state = 'none'    then 'send_intake'
      when not f.program_live and f.intake_state = 'expired' then 'intake_expired_resend'
      when not f.program_live and f.intake_state = 'pending' then 'awaiting_client_intake'
      when not f.program_live and f.draft_state in ('draft', 'held_medical') then 'review_draft'
      when not f.program_live                                then 'unclassified'
      when f.nutrition_state = 'none'                        then 'assemble_nutrition'
      when f.nutrition_state = 'draft'                       then 'release'
      when f.invite_state = 'none'                           then 'send_invite'
      when f.invite_state = 'expired'                        then 'invite_expired_resend'
      when f.invite_state = 'pending'                        then 'awaiting_client_claim'
      when not f.opened_app                                  then 'awaiting_first_open'
      when not f.first_set_logged                            then 'awaiting_first_set'
      else 'onboarded' end as next_action
  from facts f
  order by f.display_name;
end $fn$;
