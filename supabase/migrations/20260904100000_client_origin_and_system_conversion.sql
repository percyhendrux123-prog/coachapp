-- Phase 4 parts B and C (plan + 2026-09-04 amendment:
-- the original design notes (not included)).
--
-- 1. clients.origin — where a client record came from. NULL means "before this column
--    existed / not tracked" and is displayed as nothing, never as a guess (twin-facts rule).
-- 2. clients.converted_from_client_id — the SYSTEM buyer row a coaching client was moved
--    from. One direction only; the buyer row is untouched apart from losing its login.
-- 3. Writers stamp origin: provision_system_buyer → 'system', create_coach_client →
--    'coach_invite'. (trainerize-import stamps 'trainerize_import' from the edge function.)
-- 4. convert_system_buyer_to_coaching(): the only cross-tenant write in the app. Moves a
--    signed-in SYSTEM buyer's login onto a new row on the owner tenant's roster. Refuses
--    anyone who is not an owner-tenant coach, a buyer who never signed in, a duplicate email on
--    the roster, and a second move.
-- 5. list_system_buyers() v2 — adds has_account, converted_client_id, converted_at. Return
--    type changes, so it is dropped and recreated (grants re-applied below).

-- ── 1–2. Columns ─────────────────────────────────────────────────────────────────────
alter table public.clients
  add column if not exists origin text null;
alter table public.clients
  drop constraint if exists clients_origin_ck;
alter table public.clients
  add constraint clients_origin_ck
  check (origin is null or origin in ('system', 'coach_invite', 'trainerize_import'));
comment on column public.clients.origin is
  'How this client record came to exist: system (bought the self-serve plan), coach_invite (coach added them), trainerize_import. NULL = created before 2026-09-04, not tracked — display nothing, never infer.';

alter table public.clients
  add column if not exists converted_from_client_id uuid null references public.clients(id) on delete set null;
create index if not exists clients_converted_from_idx
  on public.clients (converted_from_client_id) where converted_from_client_id is not null;
comment on column public.clients.converted_from_client_id is
  'Set on a coaching client that was moved from a self-serve buyer row by convert_system_buyer_to_coaching(). Points at the buyer row, which keeps its history.';

-- ── 3a. provision_system_buyer stamps origin = system ────────────────────────────────
create or replace function public.provision_system_buyer(p_email text, p_session_id text, p_parq jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid;
  v_client uuid;
  v_token  text;
  v_email  text := lower(trim(p_email));
begin
  if v_email is null or v_email = '' or position('@' in v_email) = 0 then
    raise exception 'provision_system_buyer: email required';
  end if;
  if p_session_id is null or p_session_id = '' then
    raise exception 'provision_system_buyer: session id required';
  end if;

  select t.id into v_tenant from public.tenants t join public.tenant_config c on c.tenant_id = t.id
   where t.slug = 'self-serve' and c.mode = 'self_serve';
  if v_tenant is null then raise exception 'provision_system_buyer: self-serve tenant missing or not self_serve'; end if;

  -- Idempotency: this payment already produced a client.
  select id into v_client from public.clients where system_checkout_session_id = p_session_id;
  if v_client is not null then
    select token into v_token from public.intake_forms
     where client_id = v_client order by created_at desc limit 1;
    return jsonb_build_object('client_id', v_client, 'intake_token', v_token, 'already_provisioned', true);
  end if;

  -- One SYSTEM client per email inside the system tenant. A second purchase by the same
  -- email attaches to the same client rather than creating a twin (Stripe refund is the platform owner's).
  select id into v_client from public.clients
   where tenant_id = v_tenant and lower(email) = v_email limit 1;
  if v_client is null then
    insert into public.clients (tenant_id, display_name, email, status, client_type, system_checkout_session_id, origin)
    values (v_tenant, split_part(v_email, '@', 1), v_email, 'invited', 'lifestyle', p_session_id, 'system')
    returning id into v_client;
  else
    update public.clients set system_checkout_session_id = p_session_id, updated_at = now() where id = v_client;
  end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.intake_forms (tenant_id, client_id, token, status, expires_at, answers)
  values (v_tenant, v_client, v_token, 'pending', now() + interval '14 days', coalesce(p_parq, '{}'::jsonb));

  return jsonb_build_object('client_id', v_client, 'intake_token', v_token, 'already_provisioned', false);
end;
$$;

-- Existing SYSTEM buyers are a known fact (system_checkout_session_id is set only by the
-- SYSTEM path), so backfilling them is not an inference.
update public.clients set origin = 'system'
 where origin is null and system_checkout_session_id is not null;

-- ── 3b. create_coach_client stamps origin = coach_invite ─────────────────────────────
create or replace function public.create_coach_client(
  p_display_name text,
  p_email text default null,
  p_coaching_tier text default null,
  p_status text default 'invited',
  p_client_type text default null,
  p_show_date date default null,
  p_show_name text default null
)
returns public.clients
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  me public.profiles;
  rec public.clients;
  cleaned_name text := trim(coalesce(p_display_name, ''));
  cleaned_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  cleaned_type text := nullif(trim(coalesce(p_client_type, '')), '');
  st text := coalesce(nullif(trim(coalesce(p_status, '')), ''), 'invited');
begin
  select * into me from public.profiles where user_id = auth.uid();
  if me.user_id is null or me.role is distinct from 'coach' then
    raise exception 'Only a coach can add a client.';
  end if;
  if me.tenant_id is null then
    raise exception 'Your coaching session has no tenant. Sign out and sign back in.';
  end if;
  if cleaned_name = '' then
    raise exception 'Name is required.';
  end if;
  if cleaned_type is not null and cleaned_type not in ('lifestyle', 'prep') then
    raise exception 'Client type must be lifestyle, prep, or unset.';
  end if;
  if cleaned_email is not null and exists (
    select 1 from public.clients c
    where c.tenant_id = me.tenant_id and lower(c.email) = cleaned_email
  ) then
    raise exception 'A client with that email already exists.';
  end if;

  insert into public.clients (
    tenant_id, display_name, email, coaching_tier, status,
    client_type, show_date, show_name, origin
  ) values (
    me.tenant_id,
    cleaned_name,
    cleaned_email,
    nullif(trim(coalesce(p_coaching_tier, '')), ''),
    st::public.client_status,
    cleaned_type,
    case when cleaned_type = 'prep' then p_show_date else null end,
    case when cleaned_type = 'prep' then nullif(trim(coalesce(p_show_name, '')), '') else null end,
    'coach_invite'
  )
  returning * into rec;
  return rec;
end;
$$;

-- ── 4. Move a SYSTEM buyer to coaching ───────────────────────────────────────────────
create or replace function public.convert_system_buyer_to_coaching(p_buyer_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  me        public.profiles;
  v_slug    text;
  buyer     public.clients;
  v_mode    text;
  v_new     uuid;
begin
  -- Caller: a coach whose tenant is the platform owner (slug 'owner'). Service role is
  -- deliberately not accepted — this is the platform owner's finger on a button, not an agent's.
  select * into me from public.profiles where user_id = auth.uid();
  if me.user_id is null or me.role is distinct from 'coach' then
    raise exception 'Only a coach can move a buyer to coaching.' using errcode = '42501';
  end if;
  select slug into v_slug from public.tenants where id = me.tenant_id;
  if v_slug is distinct from 'owner' then
    raise exception 'Moving SYSTEM buyers is restricted to the platform owner.' using errcode = '42501';
  end if;

  select * into buyer from public.clients where id = p_buyer_client_id;
  if buyer.id is null then
    raise exception 'Buyer not found.';
  end if;
  select mode into v_mode from public.tenant_config where tenant_id = buyer.tenant_id;
  if v_mode is distinct from 'self_serve' then
    raise exception 'That client is not a SYSTEM buyer.';
  end if;
  if buyer.client_user_id is null then
    raise exception 'This buyer has never signed in to SYSTEM, so there is no login to move. Add them as a client and send an invite instead.';
  end if;
  if exists (select 1 from public.clients where converted_from_client_id = buyer.id) then
    raise exception 'This buyer has already been moved to coaching.';
  end if;
  if buyer.email is not null and exists (
    select 1 from public.clients c where c.tenant_id = me.tenant_id and lower(c.email) = lower(buyer.email)
  ) then
    raise exception 'A client with that email already exists on your roster.';
  end if;
  if public.tenant_is_suspended(me.tenant_id) then
    raise exception 'Your app is paused; reactivate billing before adding clients.' using errcode = '42501';
  end if;

  -- The coaching row. Body metrics and units copied as facts the buyer entered; client_type
  -- left null — SYSTEM hardcodes lifestyle, which is not a coach's classification.
  insert into public.clients (
    tenant_id, display_name, email, status, origin, converted_from_client_id,
    sex, age, height_cm, weight_kg, goal_weight_kg, height_in, weight_lb, goal_weight_lb,
    activity_level, body_fat_pct, unit_pref
  ) values (
    me.tenant_id, buyer.display_name, buyer.email, 'active', 'system', buyer.id,
    buyer.sex, buyer.age, buyer.height_cm, buyer.weight_kg, buyer.goal_weight_kg, buyer.height_in, buyer.weight_lb, buyer.goal_weight_lb,
    buyer.activity_level, buyer.body_fat_pct, buyer.unit_pref
  ) returning id into v_new;

  -- Move the login. Order matters: clients_user_unique allows one row per user.
  update public.clients set client_user_id = null, updated_at = now() where id = buyer.id;
  update public.clients set client_user_id = buyer.client_user_id, updated_at = now() where id = v_new;
  update public.profiles set tenant_id = me.tenant_id where user_id = buyer.client_user_id and role = 'client';

  -- AI tokens were scoped to the buyer row (and owner scope cannot exist on a coached
  -- tenant). Revoke; the client reconnects from the coaching app if they want to.
  update public.connector_tokens set revoked_at = now()
   where client_id = buyer.id and revoked_at is null;

  return v_new;
end;
$$;

revoke all on function public.convert_system_buyer_to_coaching(uuid) from public, anon;
grant execute on function public.convert_system_buyer_to_coaching(uuid) to authenticated;
comment on function public.convert_system_buyer_to_coaching(uuid) is
  'Platform owner only. Creates a coaching row (origin=system, converted_from_client_id) on the caller''s roster, moves the buyer''s login to it, re-points profiles.tenant_id, revokes the buyer''s AI tokens. Buyer row keeps its history. Refuses a never-signed-in buyer.';

-- ── 5. list_system_buyers v2 ─────────────────────────────────────────────────────────
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
  converted_at timestamptz
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
    -- has_account: they signed in at least once (login on this row, or moved with them).
    (c.client_user_id is not null or conv.id is not null),
    conv.id,
    conv.joined_at
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
