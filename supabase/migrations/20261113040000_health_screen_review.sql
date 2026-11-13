-- A coach can review a flagged health screen directly (P26, 2026-11-12).
--
-- The dead end this closes: release_checklist() counts a flagged screen as reviewed ONLY when a
-- coach approved a program DRAFT that carried that intake (approve_program_draft on the held
-- draft). Two common paths never produce such a draft:
--   1. the health screen + waiver path (/screen, intake_kind = 'screen') never generates a
--      draft at all, so a "yes" answer can never be cleared;
--   2. the full intake path makes a held_medical draft with no training days; the coach then
--      assigns a program from their own library instead. Approving the held draft is refused
--      (empty plan), and once a plan is built publish_program_draft refuses again because a
--      coach-built program is live (20260920210000).
-- Either way the Release checklist said "review and approve the held draft in Programs first"
-- and there was no in-app way to do it.
--
-- The safety intent stays: a flagged screen still blocks release until a COACH acts on it, and
-- nothing infers clearance. What changes is that the coach's review can be recorded on the
-- screen itself, with who, when, which flags, and a note saying what they checked.
--   * health_screen_reviews: append-only record, one row per review. Readable by the tenant's
--     coaches; written only through review_health_screen() (no insert/update/delete grant).
--   * review_health_screen(intake, note): coach-only, tenant-checked, refused on a suspended
--     tenant, on an intake that is not the client's latest submitted screen, on a screen with
--     no flags, and on a blank note. Idempotent for the same flags.
--   * release_checklist(): a review counts only for the exact intake AND the exact flag set it
--     reviewed. A new screen, or flags edited later (update_client_onboarding), needs a new
--     review. The draft-approval path is unchanged and still counts.

create table if not exists public.health_screen_reviews (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  intake_id   uuid not null references public.intake_forms(id) on delete cascade,
  flags       jsonb not null check (jsonb_typeof(flags) = 'array' and jsonb_array_length(flags) > 0),
  note        text not null check (char_length(btrim(note)) between 3 and 1000),
  reviewed_by uuid not null,
  reviewed_at timestamptz not null default now()
);
create index if not exists health_screen_reviews_intake_idx on public.health_screen_reviews (intake_id);
create index if not exists health_screen_reviews_client_idx on public.health_screen_reviews (client_id);
comment on table public.health_screen_reviews is
  'P26: a coach reviewed a flagged health screen (intake). Append-only; written only by review_health_screen(). release_checklist() honours a row only for the same intake and the same flags.';

alter table public.health_screen_reviews enable row level security;
drop policy if exists health_screen_reviews_coach_read on public.health_screen_reviews;
create policy health_screen_reviews_coach_read on public.health_screen_reviews
  for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach');

revoke all on table public.health_screen_reviews from public, anon, authenticated;
grant select on table public.health_screen_reviews to authenticated;
grant all on table public.health_screen_reviews to service_role;

create or replace function public.review_health_screen(p_intake_id uuid, p_note text)
returns jsonb
language plpgsql security definer
set search_path = public as $fn$
declare
  v_intake  public.intake_forms%rowtype;
  v_latest  uuid;
  v_note    text := btrim(coalesce(p_note, ''));
  v_uid     uuid := auth.uid();
  v_review  public.health_screen_reviews%rowtype;
begin
  if coalesce(public.current_app_role(), '') is distinct from 'coach' then
    raise exception 'not authorized: coach role required';
  end if;
  if v_uid is null then
    raise exception 'not authorized: a signed-in coach is required';
  end if;
  select * into v_intake from public.intake_forms where id = p_intake_id for update;
  if not found then raise exception 'health screen % not found', p_intake_id; end if;
  if public.current_tenant_id() is null or v_intake.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'not authorized: wrong tenant';
  end if;
  if public.tenant_is_suspended(v_intake.tenant_id) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;

  if v_intake.status is distinct from 'submitted' then
    raise exception 'review refused: this health screen has not been submitted' using errcode = 'P0001';
  end if;
  -- Same ordering release_checklist() uses, so the coach always reviews the screen it reads.
  select i.id into v_latest from public.intake_forms i
   where i.client_id = v_intake.client_id and i.status = 'submitted'
   order by i.submitted_at desc nulls last, i.created_at desc limit 1;
  if v_latest is distinct from v_intake.id then
    raise exception 'review refused: a newer health screen exists for this client — review that one' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_intake.health_flags) is distinct from 'array' or jsonb_array_length(v_intake.health_flags) = 0 then
    raise exception 'review refused: this health screen has no flags to review' using errcode = 'P0001';
  end if;
  if char_length(v_note) < 3 then
    raise exception 'review refused: say what you checked (for example: talked it through, doctor''s clearance on file)' using errcode = 'P0001', hint = 'note';
  end if;
  if char_length(v_note) > 1000 then
    raise exception 'review refused: keep the note under 1000 characters' using errcode = 'P0001', hint = 'note';
  end if;

  -- Idempotent for the same screen and flags: a second tap returns the first review.
  select * into v_review from public.health_screen_reviews r
   where r.intake_id = v_intake.id and r.flags = v_intake.health_flags
   order by r.reviewed_at asc limit 1;
  if v_review.id is null then
    insert into public.health_screen_reviews (tenant_id, client_id, intake_id, flags, note, reviewed_by)
    values (v_intake.tenant_id, v_intake.client_id, v_intake.id, v_intake.health_flags, v_note, v_uid)
    returning * into v_review;
  end if;

  return jsonb_build_object('status', 'reviewed', 'review_id', v_review.id, 'intake_id', v_intake.id,
                            'client_id', v_intake.client_id, 'flags', v_review.flags,
                            'reviewed_at', v_review.reviewed_at);
end $fn$;

revoke all on function public.review_health_screen(uuid, text) from public, anon;
grant execute on function public.review_health_screen(uuid, text) to authenticated, service_role;
comment on function public.review_health_screen(uuid, text) is
  'P26: coach records a review of a flagged health screen (the client''s latest submitted intake). Coach-only, tenant-checked, note required. Satisfies release_checklist() health for that intake and flag set only.';

-- release_checklist(): verbatim re-issue of 20260906180000 except item 4 (health), which also
-- accepts a health_screen_reviews row for the same intake and flags, and returns intake_id so
-- the Release panel can offer the review.
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
  v_splan      public.client_meal_plans%rowtype;
  v_splan_id   uuid;
  v_slots      int := 0;
  v_day0       int := 0;
  v_unpub      int := 0;
  v_sreason    text;
  v_lplan      public.meal_plans%rowtype;
  v_lplan_id   uuid;
  v_lreason    text;
  v_held       public.program_drafts%rowtype;
  v_intake     public.intake_forms%rowtype;
  v_flags      jsonb;
  v_reviewed   boolean := false;
  v_review     public.health_screen_reviews%rowtype;
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
  -- Mirrors check_client_meal_plan_release() (the trigger that guards the assign) exactly,
  -- so the checklist never shows a tick the write would refuse.
  select * into v_splan from public.client_meal_plans m
   where m.client_id = cli.id and m.status = 'draft' order by m.created_at desc limit 1;
  if v_splan.id is not null then
    v_splan_id := v_splan.id;
    select count(*) into v_slots from public.client_meal_plan_slots s where s.plan_id = v_splan_id;
    select count(*) filter (where s.meal_id is not null),
           count(*) filter (where mm.id is null or mm.status <> 'published')
      into v_day0, v_unpub
      from public.client_meal_plan_slots s left join public.meals mm on mm.id = s.meal_id
     where s.plan_id = v_splan_id and s.day_index = 0;
    v_sreason := case
      when v_slots = 0 then 'no meals'
      when v_splan.meals_per_day is null or v_splan.meals_per_day < 1 then 'meals per day not set'
      when v_splan.target_calories is null or v_splan.target_protein_g is null or v_splan.target_fat_g is null or v_splan.target_carb_g is null then 'macro targets not set'
      when v_day0 is distinct from v_splan.meals_per_day then format('day 1 has %s filled slot%s, meals per day says %s', v_day0, case when v_day0 = 1 then '' else 's' end, v_splan.meals_per_day)
      when v_unpub > 0 then format('%s meal%s not published', v_unpub, case when v_unpub = 1 then '' else 's' end)
      else null end;
  end if;
  -- Mirrors check_meal_plan_release() for the legacy table.
  select * into v_lplan from public.meal_plans l
   where l.client_id = cli.id and l.assigned_at is null and coalesce(l.status,'draft') = 'draft'
   order by l.created_at desc limit 1;
  if v_lplan.id is not null then
    v_lplan_id := v_lplan.id;
    v_lreason := case
      when v_lplan.calories is null or v_lplan.protein_g is null or v_lplan.fat_g is null or v_lplan.carb_g is null then 'macros not set'
      when jsonb_array_length(coalesce(v_lplan.meals, '[]'::jsonb)) = 0 then 'no meals'
      else null end;
  end if;
  v_nutrition := case
    when v_assigned then jsonb_build_object('ok', true, 'state', 'assigned', 'detail', 'Nutrition assigned')
    when cli.nutrition_declined_at is not null then jsonb_build_object('ok', true, 'state', 'declined', 'detail', 'No nutrition plan (recorded ' || to_char(cli.nutrition_declined_at, 'YYYY-MM-DD') || ')')
    when v_splan_id is not null and v_sreason is null then jsonb_build_object('ok', true, 'state', 'draft', 'detail', format('Nutrition (%s meal%s)', v_slots, case when v_slots = 1 then '' else 's' end), 'plan_id', v_splan_id, 'source', 'structured')
    when v_splan_id is not null then jsonb_build_object('ok', false, 'state', case when v_slots = 0 then 'empty_draft' else 'incomplete_draft' end, 'detail', 'Nutrition draft not ready: ' || v_sreason, 'plan_id', v_splan_id, 'source', 'structured')
    when v_lplan_id is not null and v_lreason is null then jsonb_build_object('ok', true, 'state', 'draft', 'detail', 'Nutrition (uploaded plan)', 'plan_id', v_lplan_id, 'source', 'legacy')
    when v_lplan_id is not null then jsonb_build_object('ok', false, 'state', 'incomplete_draft', 'detail', 'Nutrition draft not ready: ' || v_lreason, 'plan_id', v_lplan_id, 'source', 'legacy')
    else jsonb_build_object('ok', false, 'state', 'none', 'detail', 'No nutrition plan — or tick "no nutrition for this client"') end;

  -- 3. email — present AND syntactically valid (one @, something either side, a dot after).
  v_email := case
    when nullif(trim(coalesce(cli.email, '')), '') is null then jsonb_build_object('ok', false, 'state', 'missing', 'detail', 'Email missing')
    when trim(cli.email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then jsonb_build_object('ok', false, 'state', 'invalid', 'detail', 'Email looks invalid: ' || cli.email)
    else jsonb_build_object('ok', true, 'state', 'valid', 'detail', 'Email ' || trim(cli.email)) end;

  -- 4. health / compliance — authoritative at the database boundary. Reads the latest
  -- SUBMITTED intake's health_flags (written by intake-submit from the PAR-Q answers).
  -- Fails closed: no screen on record, or an unreadable one, blocks; a flagged screen
  -- blocks unless a coach has explicitly reviewed it. Two records count as that review, and
  -- nothing else: a coach approving the draft that carried the flags (approve_program_draft,
  -- decided_by set), or a coach's review_health_screen() row for this exact intake and
  -- these exact flags. Nothing here infers clearance.
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
    select * into v_review from public.health_screen_reviews r
     where r.intake_id = v_intake.id and r.flags = v_flags and r.reviewed_by is not null
     order by r.reviewed_at desc limit 1;
    v_health := case
      when v_reviewed then jsonb_build_object('ok', true, 'state', 'flagged_reviewed', 'flags', v_flags, 'intake_id', v_intake.id,
                              'detail', 'Health screen flagged, reviewed and approved by coach')
      when v_review.id is not null then jsonb_build_object('ok', true, 'state', 'flagged_reviewed', 'flags', v_flags, 'intake_id', v_intake.id,
                              'review_id', v_review.id, 'reviewed_at', v_review.reviewed_at,
                              'detail', 'Health screen flagged, reviewed by coach on ' || to_char(v_review.reviewed_at, 'YYYY-MM-DD'))
      else jsonb_build_object('ok', false, 'state', 'flagged', 'flags', v_flags, 'intake_id', v_intake.id,
                              'detail', 'Health screen flagged (' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_flags) x) || ') — a coach must review it before release') end;
  end if;

  return jsonb_build_object(
    'client_id', cli.id,
    'program', v_program, 'nutrition', v_nutrition, 'email', v_email, 'health', v_health,
    'invite_state', case when cli.client_user_id is not null then 'claimed'
                         when cli.invite_token is null then 'none'
                         when cli.invite_expires_at < now() then 'expired' else 'pending' end,
    'ready', (v_program->>'ok')::boolean and (v_nutrition->>'ok')::boolean and (v_email->>'ok')::boolean and (v_health->>'ok')::boolean);
end $fn$;

-- CREATE OR REPLACE keeps the ACL; re-asserted anyway, matching 20260906170000.
revoke all on function public.release_checklist(uuid) from public, anon;
grant execute on function public.release_checklist(uuid) to authenticated, service_role;
