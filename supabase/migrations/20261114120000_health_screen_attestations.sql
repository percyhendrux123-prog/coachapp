-- P33 (2026-11-14): the safe path for a flagged health screen on the self-serve plan.
--
-- The dead end this closes (P31): on a self-serve tenant there is no coach, so a flagged health
-- screen produced a held_medical draft that nothing could ever clear. review_health_screen() and
-- approve_program_draft need the coach role, and release_checklist() is never called there.
-- The 28-day re-intake clock also counted the held submission, so a mis-tap locked a person out.
--
-- The rule now: nobody here clears anyone and nobody here reads a health answer. A fixed table
-- (the same lists as supabase/functions/_shared/parq.ts and src/lib/healthHold.js) decides:
--   * doctor first: heart condition, chest pain, dizziness, bone/joint, BP or heart medication,
--     other reason, a listed medication. No plan until the signed-in person confirms that their
--     own doctor or licensed health professional told them unsupervised training and a diet
--     change are fine. Then system-clearance builds a conservative plan;
--   * no self-serve plan: pregnancy, eating-disorder history, and any flag id not in the
--     doctor-first list (fail closed).
--
--   1. self_serve_doctor_first_flags() / self_serve_blocking_flags(): the table, immutable.
--   2. health_screen_attestations: append-only, one row per confirmation, readable only by the
--      person it belongs to; written only by attest_my_health_screen().
--   3. health_clearance_builds: one row per attestation that started a build (service role only).
--      The insert is the claim, so two taps can never build two plans.
--   4. attest_my_health_screen(): the signed-in self-serve person's own confirmation.
--   5. my_health_hold(): what the person's own hold screen shows.
--   6. mint_my_intake_token() / mint_intake_token_for_client(): the 28-day clock counts only a
--      submission that produced a published program. A held, never-built screen does not.
--   7. list_system_buyers() v3: adds health_hold (none | needs_clearance | blocked).
--
-- Not changed: release_checklist() and review_health_screen(). An attestation row never
-- satisfies a coached release, and a coach review never applies to the self-serve plan.

-- ── 1. The flag table ───────────────────────────────────────────────────────────────────
create or replace function public.self_serve_doctor_first_flags()
returns text[] language sql immutable set search_path = public as $$
  select array['parq_heart_condition', 'parq_chest_pain', 'parq_dizziness',
               'parq_bone_joint_worsened_by_activity', 'parq_bp_or_heart_medication',
               'parq_other_reason_not_to_exercise', 'medication_disclosed']::text[]
$$;
create or replace function public.self_serve_blocking_flags()
returns text[] language sql immutable set search_path = public as $$
  select array['pregnancy', 'eating_disorder_history']::text[]
$$;
comment on function public.self_serve_doctor_first_flags() is
  'P33: stored health flag ids that mean "check with your doctor first" on the self-serve plan. Any other id is blocking. Twins: _shared/parq.ts DOCTOR_FIRST_FLAGS, src/lib/healthHold.js.';
comment on function public.self_serve_blocking_flags() is
  'P33: stored health flag ids that never get a self-serve plan. Unknown ids are blocking too; this list is for display and parity only.';

-- The statement the person confirms. The version is the only input; the text is stored from here.
create or replace function public.health_statement_version()
returns text language sql immutable set search_path = public as $$ select '2026-11-14.1'::text $$;
create or replace function public.health_statement_text(p_version text)
returns text language sql immutable set search_path = public as $$
  select case p_version
    when '2026-11-14.1' then
      'I talked to a doctor or licensed health professional about each item above.' || E'\n' ||
      'They told me I can train without supervision and change how I eat.' || E'\n' ||
      'I understand this plan is general fitness and nutrition education. It is not medical advice, and nobody reviewed my answers.'
  end
$$;

-- ── 2. Attestations ─────────────────────────────────────────────────────────────────────
create table if not exists public.health_screen_attestations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  client_id         uuid not null references public.clients(id) on delete cascade,
  intake_id         uuid not null references public.intake_forms(id) on delete cascade,
  flags             jsonb not null check (jsonb_typeof(flags) = 'array' and jsonb_array_length(flags) > 0),
  statement_version text not null,
  statement_text    text not null check (char_length(statement_text) > 0),
  typed_name        text not null,
  attested_by       uuid not null,
  attested_at       timestamptz not null default now(),
  constraint health_screen_attestations_name_check
    check (char_length(regexp_replace(typed_name, '^[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')) between 2 and 120)
);
create index if not exists health_screen_attestations_intake_idx on public.health_screen_attestations (intake_id);
create index if not exists health_screen_attestations_client_idx on public.health_screen_attestations (client_id);
comment on table public.health_screen_attestations is
  'P33: a self-serve person confirmed, signed in, that their own doctor or licensed health professional cleared them for unsupervised training and a diet change. Append-only; written only by attest_my_health_screen(). Nobody at the app reviews it. Never counts toward a coached release.';

alter table public.health_screen_attestations enable row level security;
drop policy if exists health_screen_attestations_own_read on public.health_screen_attestations;
create policy health_screen_attestations_own_read on public.health_screen_attestations
  for select to authenticated
  using (client_id = public.current_client_id());

revoke all on table public.health_screen_attestations from public, anon, authenticated;
grant select on table public.health_screen_attestations to authenticated;
grant all on table public.health_screen_attestations to service_role;

-- ── 3. Build claims (service role only) ────────────────────────────────────────────────
create table if not exists public.health_clearance_builds (
  attestation_id uuid primary key references public.health_screen_attestations(id) on delete cascade,
  intake_id      uuid not null references public.intake_forms(id) on delete cascade,
  claimed_at     timestamptz not null default now(),
  draft_id       uuid null references public.program_drafts(id) on delete set null
);
comment on table public.health_clearance_builds is
  'P33: system-clearance inserts one row per attestation before it builds (the insert is the lock), and sets draft_id when the build is published. A failed build deletes its row so a retry can run.';
alter table public.health_clearance_builds enable row level security;
revoke all on table public.health_clearance_builds from public, anon, authenticated;
grant all on table public.health_clearance_builds to service_role;

-- ── 4. attest_my_health_screen ──────────────────────────────────────────────────────────
create or replace function public.attest_my_health_screen(
  p_intake_id uuid, p_seen_flags jsonb, p_statement_version text, p_typed_name text
)
returns jsonb
language plpgsql security definer
set search_path = public as $fn$
declare
  v_uid     uuid := auth.uid();
  v_client  uuid;
  v_tenant  uuid;
  v_mode    text;
  v_intake  public.intake_forms%rowtype;
  v_latest  uuid;
  v_bad     text[];
  -- Same trim as health_screen_reviews (P28): every whitespace kind, both ends.
  v_name    text := regexp_replace(coalesce(p_typed_name, ''), '^[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g');
  v_row     public.health_screen_attestations%rowtype;
begin
  if v_uid is null then
    raise exception 'not authorized: sign in first' using errcode = '42501';
  end if;
  if coalesce(public.current_app_role(), '') is distinct from 'client' then
    raise exception 'not authorized: only the person who answered the health screen can confirm it' using errcode = '42501';
  end if;
  v_client := public.current_client_id();
  if v_client is null then
    raise exception 'not authorized: no client record for this sign-in' using errcode = '42501';
  end if;

  select * into v_intake from public.intake_forms where id = p_intake_id for update;
  if not found or v_intake.client_id is distinct from v_client then
    raise exception 'not authorized: this health screen is not yours' using errcode = '42501';
  end if;
  select c.tenant_id into v_tenant from public.clients c where c.id = v_client;
  if v_tenant is distinct from v_intake.tenant_id then
    raise exception 'not authorized: wrong tenant' using errcode = '42501';
  end if;
  select mode into v_mode from public.tenant_config where tenant_id = v_tenant;
  if v_mode is distinct from 'self_serve' then
    raise exception 'refused: this confirmation is only for the self-serve plan' using errcode = 'P0001', hint = 'not_self_serve';
  end if;
  if public.tenant_is_suspended(v_tenant) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;

  if v_intake.status is distinct from 'submitted' then
    raise exception 'refused: this health screen has not been submitted' using errcode = 'P0001';
  end if;
  -- Same ordering release_checklist() and review_health_screen() use.
  select i.id into v_latest from public.intake_forms i
   where i.client_id = v_client and i.status = 'submitted'
   order by i.submitted_at desc nulls last, i.created_at desc limit 1;
  if v_latest is distinct from v_intake.id then
    raise exception 'refused: a newer health screen exists — open the app again and answer that one' using errcode = 'P0001', hint = 'stale';
  end if;
  if jsonb_typeof(v_intake.health_flags) is distinct from 'array' or jsonb_array_length(v_intake.health_flags) = 0 then
    raise exception 'refused: this health screen has nothing to confirm' using errcode = 'P0001';
  end if;
  -- The person confirms what they were shown (P28's stale rule), checked under the row lock.
  if p_seen_flags is null or jsonb_typeof(p_seen_flags) is distinct from 'array'
     or p_seen_flags is distinct from v_intake.health_flags then
    raise exception 'refused: your health screen changed since this page opened — reload and read it again'
      using errcode = 'P0001', hint = 'stale';
  end if;
  -- Any flag outside the doctor-first list means no self-serve plan, whatever is confirmed.
  select array_agg(f) into v_bad
    from jsonb_array_elements_text(v_intake.health_flags) f
   where f <> all (public.self_serve_doctor_first_flags());
  if v_bad is not null then
    raise exception 'refused: this plan is not built for an answer on this health screen' using errcode = 'P0001', hint = 'blocking';
  end if;
  if p_statement_version is null or p_statement_version is distinct from public.health_statement_version() then
    raise exception 'refused: the confirmation text changed — reload and read it again' using errcode = 'P0001', hint = 'version';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'refused: type your full name' using errcode = 'P0001', hint = 'name';
  end if;

  -- Idempotent for the same screen, flags and statement.
  select * into v_row from public.health_screen_attestations a
   where a.intake_id = v_intake.id and a.flags = v_intake.health_flags
     and a.statement_version = p_statement_version
   order by a.attested_at asc limit 1;
  if v_row.id is null then
    insert into public.health_screen_attestations
      (tenant_id, client_id, intake_id, flags, statement_version, statement_text, typed_name, attested_by)
    values (v_tenant, v_client, v_intake.id, v_intake.health_flags, p_statement_version,
            public.health_statement_text(p_statement_version), v_name, v_uid)
    returning * into v_row;
  end if;

  return jsonb_build_object('status', 'attested', 'attestation_id', v_row.id, 'intake_id', v_row.intake_id,
                            'client_id', v_row.client_id, 'flags', v_row.flags,
                            'statement_version', v_row.statement_version, 'attested_at', v_row.attested_at);
end $fn$;

revoke all on function public.attest_my_health_screen(uuid, jsonb, text, text) from public, anon;
grant execute on function public.attest_my_health_screen(uuid, jsonb, text, text) to authenticated;
comment on function public.attest_my_health_screen(uuid, jsonb, text, text) is
  'P33: the signed-in self-serve person confirms their own doctor''s clearance for their latest flagged health screen. Refuses coaches, coached tenants, other people''s screens, stale flags, blocking or unknown flags, the wrong statement version and a blank name. Idempotent.';

-- ── 5. my_health_hold ───────────────────────────────────────────────────────────────────
-- What the person's own hold screen shows. state:
--   none             no flagged screen waiting (or a plan was built from it)
--   needs_clearance  doctor-first flags, not yet confirmed
--   building         confirmed, but the plan did not finish building (system-clearance retries)
--   blocked          a flag that never gets a self-serve plan
create or replace function public.my_health_hold()
returns jsonb
language plpgsql stable security definer
set search_path = public as $fn$
declare
  v_client  uuid := public.current_client_id();
  v_tenant  uuid;
  v_mode    text;
  v_intake  public.intake_forms%rowtype;
  v_flags   jsonb;
  v_live    boolean;
  v_reason  text;
begin
  if auth.uid() is null or v_client is null then
    raise exception 'not_a_client' using errcode = '42501';
  end if;
  select c.tenant_id into v_tenant from public.clients c where c.id = v_client;
  select mode into v_mode from public.tenant_config where tenant_id = v_tenant;
  if v_mode is distinct from 'self_serve' then
    return jsonb_build_object('state', 'none');
  end if;
  select * into v_intake from public.intake_forms i
   where i.client_id = v_client and i.status = 'submitted'
   order by i.submitted_at desc nulls last, i.created_at desc limit 1;
  v_flags := coalesce(v_intake.health_flags, '[]'::jsonb);
  if v_intake.id is null or jsonb_typeof(v_flags) <> 'array' or jsonb_array_length(v_flags) = 0 then
    return jsonb_build_object('state', 'none');
  end if;
  if exists (select 1 from public.program_drafts d where d.intake_id = v_intake.id and d.status = 'published') then
    return jsonb_build_object('state', 'none');
  end if;
  v_live := exists (select 1 from public.assignments a where a.client_id = v_client and a.active);

  if exists (select 1 from jsonb_array_elements_text(v_flags) f where f <> all (public.self_serve_doctor_first_flags())) then
    v_reason := case
      when v_flags ? 'eating_disorder_history' then 'eating_disorder_history'
      when v_flags ? 'pregnancy' then 'pregnancy'
      else 'other' end;
    return jsonb_build_object('state', 'blocked', 'reason', v_reason, 'intake_id', v_intake.id,
                              'has_live_plan', v_live);
  end if;

  return jsonb_build_object(
    'state', case when exists (select 1 from public.health_screen_attestations a
                                where a.intake_id = v_intake.id and a.flags = v_flags
                                  and a.statement_version = public.health_statement_version())
                  then 'building' else 'needs_clearance' end,
    'intake_id', v_intake.id, 'flags', v_flags, 'has_live_plan', v_live,
    'statement_version', public.health_statement_version());
end $fn$;

revoke all on function public.my_health_hold() from public, anon;
grant execute on function public.my_health_hold() to authenticated;

-- ── 6. Re-intake clock: only a submission that produced a published program counts ─────
create or replace function public.mint_my_intake_token()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid := public.current_client_id();
  v_tenant uuid := public.current_tenant_id();
  v_mode   text;
  v_last   timestamptz;
  v_token  text;
begin
  if v_client is null or v_tenant is null then raise exception 'not_a_client'; end if;
  select mode into v_mode from public.tenant_config where tenant_id = v_tenant;
  if v_mode is distinct from 'self_serve' then raise exception 'not_self_serve'; end if;

  -- Measured from when the person SUBMITTED an intake that produced a published program
  -- (P33). A held or not-eligible screen never built anything, so it does not start the
  -- clock: a mis-tap can be answered again straight away.
  select max(i.submitted_at) into v_last
    from public.intake_forms i
   where i.client_id = v_client and i.status = 'submitted'
     and exists (select 1 from public.program_drafts d where d.intake_id = i.id and d.status = 'published');
  if v_last is not null and v_last > now() - interval '28 days' then
    raise exception 'too_soon:%', to_char(v_last + interval '28 days', 'YYYY-MM-DD');
  end if;

  -- An unused pending token is reused rather than multiplied.
  select token into v_token from public.intake_forms
   where client_id = v_client and status = 'pending' and (expires_at is null or expires_at > now())
   order by created_at desc limit 1;
  if v_token is not null then return v_token; end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.intake_forms (tenant_id, client_id, token, status, expires_at)
  values (v_tenant, v_client, v_token, 'pending', now() + interval '24 hours');
  return v_token;
end;
$$;
revoke all on function public.mint_my_intake_token() from public, anon;
grant execute on function public.mint_my_intake_token() to authenticated;

create or replace function public.mint_intake_token_for_client(p_client_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid := p_client_id;
  v_tenant uuid;
  v_mode   text;
  v_last   timestamptz;
  v_token  text;
begin
  select tenant_id into v_tenant from public.clients where id = p_client_id;
  if v_tenant is null then raise exception 'client not found'; end if;
  select mode into v_mode from public.tenant_config where tenant_id = v_tenant;
  if v_mode is distinct from 'self_serve' then raise exception 'not_self_serve'; end if;

  -- Same rule as mint_my_intake_token (P33): only a built submission starts the clock.
  select max(i.submitted_at) into v_last
    from public.intake_forms i
   where i.client_id = v_client and i.status = 'submitted'
     and exists (select 1 from public.program_drafts d where d.intake_id = i.id and d.status = 'published');
  if v_last is not null and v_last > now() - interval '28 days' then
    raise exception 'too_soon:%', to_char(v_last + interval '28 days', 'YYYY-MM-DD');
  end if;

  select token into v_token from public.intake_forms
   where client_id = v_client and status = 'pending' and (expires_at is null or expires_at > now())
   order by created_at desc limit 1;
  if v_token is not null then return v_token; end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.intake_forms (tenant_id, client_id, token, status, expires_at)
  values (v_tenant, v_client, v_token, 'pending', now() + interval '24 hours');
  return v_token;
end;
$$;
revoke all on function public.mint_intake_token_for_client(uuid) from public, anon, authenticated;
grant execute on function public.mint_intake_token_for_client(uuid) to service_role;

-- ── 7. list_system_buyers v3: health_hold ───────────────────────────────────────────────
-- A held person is a fact about them, not a stuck delivery: stuckReasons() returns nothing for
-- a row whose health_hold is not 'none', and the digest counts them on a separate line.
-- 'none' also covers "confirmed but the build failed": that IS a stuck delivery and stays visible.
drop function if exists public.list_system_buyers();
create function public.list_system_buyers()
returns table (
  client_id uuid,
  tenant_id uuid,
  app_name text,
  display_name text,
  email_masked text,
  status text,
  joined_at timestamptz,
  intake_status text,
  intake_submitted_at timestamptz,
  program_published boolean,
  meal_plan_assigned boolean,
  ai_connected boolean,
  ai_scope text,
  last_seen_at timestamptz,
  has_account boolean,
  converted_client_id uuid,
  converted_at timestamptz,
  health_hold text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1 from public.profiles p
      join public.tenants t on t.id = p.tenant_id
      where p.user_id = auth.uid() and p.role = 'coach' and t.slug = 'owner'
    )
  ) then
    raise exception 'list_system_buyers is restricted to the platform owner' using errcode = '42501';
  end if;

  return query
  select
    c.id,
    c.tenant_id,
    tc.app_name,
    c.display_name,
    case when c.email is null then null
         else left(split_part(c.email, '@', 1), 2) || '…@' || split_part(c.email, '@', 2) end,
    c.status::text,
    c.joined_at,
    coalesce(li.status, 'none'),
    li.submitted_at,
    exists (select 1 from public.assignments a where a.client_id = c.id and a.active),
    exists (select 1 from public.client_meal_plans m where m.client_id = c.id and m.status = 'assigned'),
    exists (select 1 from public.connector_tokens k where k.client_id = c.id and k.kind = 'client' and k.revoked_at is null),
    (select max(k.scope) from public.connector_tokens k where k.client_id = c.id and k.kind = 'client' and k.revoked_at is null),
    greatest(
      (select max(k.last_used_at) from public.connector_tokens k where k.client_id = c.id),
      li.submitted_at,
      c.updated_at
    ),
    (c.client_user_id is not null or conv.id is not null),
    conv.id,
    conv.joined_at,
    case
      when ls.id is null or jsonb_typeof(ls.health_flags) <> 'array' or jsonb_array_length(ls.health_flags) = 0 then 'none'
      when exists (select 1 from public.program_drafts d where d.intake_id = ls.id and d.status = 'published') then 'none'
      when exists (select 1 from jsonb_array_elements_text(ls.health_flags) f where f <> all (public.self_serve_doctor_first_flags())) then 'blocked'
      when exists (select 1 from public.health_screen_attestations x where x.intake_id = ls.id and x.flags = ls.health_flags) then 'none'
      else 'needs_clearance'
    end
  from public.clients c
  join public.tenant_config tc on tc.tenant_id = c.tenant_id and tc.mode = 'self_serve'
  left join lateral (
    select f.status::text as status, f.submitted_at
      from public.intake_forms f
     where f.client_id = c.id
     order by f.submitted_at desc nulls last, f.created_at desc
     limit 1
  ) li on true
  left join lateral (
    select f.id, f.health_flags
      from public.intake_forms f
     where f.client_id = c.id and f.status = 'submitted'
     order by f.submitted_at desc nulls last, f.created_at desc
     limit 1
  ) ls on true
  left join lateral (
    select k.id, k.joined_at from public.clients k
     where k.converted_from_client_id = c.id
     order by k.joined_at desc limit 1
  ) conv on true
  where c.status <> 'archived'
  order by c.joined_at desc nulls last;
end;
$$;

revoke all on function public.list_system_buyers() from public, anon;
grant execute on function public.list_system_buyers() to authenticated, service_role;
