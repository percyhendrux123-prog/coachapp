-- P33 (2026-11-14): the self-serve plan is a free email signup.
--
-- There is no payment in front of the plan any more, so the signup endpoint is the thing to
-- protect: it could otherwise open accounts and send intake emails to other people's
-- addresses. The intake link is delivered ONLY by email, never returned to the browser, and
-- system-signup (the edge function) applies three limits through system_signup_gate():
--   * the same address gets at most one email per 24 hours (later tries get the same answer
--     and nothing is sent);
--   * 5 attempts per hour from one network address (hashed);
--   * a daily cap on emails sent (SYSTEM_SIGNUP_DAILY_CAP, default 50); over it the page says
--     signups are paused.
-- Addresses are stored only as keyed hashes in the attempts table. Nothing here is readable
-- from the browser: RLS on, no policies, no grants to anon or authenticated.
--
--   1. system_signup_attempts: one row per attempt (hashes, decision, time).
--   2. system_signup_sources: where a new signup came from (the six attribution fields that
--      used to ride on the Stripe session), one row per client.
--   3. system_signup_gate(): the three limits, serialized under one advisory lock.
--   4. provision_system_signup(): one client per email in the self-serve tenant; reuses an
--      unexpired pending intake token, else mints one (14 days). A person who already
--      submitted an intake gets no new token here (kind = existing): the email tells them to
--      sign in, so this path can never be used to skip the 28-day re-intake rule.
--   5. provision_system_buyer() stays, unused by this copy, so existing deployments keep working.

-- ── 1. Attempts ─────────────────────────────────────────────────────────────────────────
create table if not exists public.system_signup_attempts (
  id         uuid primary key default gen_random_uuid(),
  email_hash text not null check (char_length(email_hash) between 16 and 128),
  ip_hash    text not null check (char_length(ip_hash) between 16 and 128),
  decision   text not null check (decision in ('ok', 'sent', 'send_failed', 'failed', 'email_recent', 'ip_limited', 'paused')),
  created_at timestamptz not null default now()
);
create index if not exists system_signup_attempts_email_idx on public.system_signup_attempts (email_hash, created_at desc);
create index if not exists system_signup_attempts_ip_idx on public.system_signup_attempts (ip_hash, created_at desc);
create index if not exists system_signup_attempts_created_idx on public.system_signup_attempts (created_at desc);
comment on table public.system_signup_attempts is
  'P33: free self-serve signup attempts. Keyed hashes only (no address, no IP). Read by system_signup_gate() for the per-email, per-IP and daily limits. Service role only.';
alter table public.system_signup_attempts enable row level security;
revoke all on table public.system_signup_attempts from public, anon, authenticated;
grant all on table public.system_signup_attempts to service_role;

-- ── 2. Sources ──────────────────────────────────────────────────────────────────────────
create table if not exists public.system_signup_sources (
  client_id   uuid primary key references public.clients(id) on delete cascade,
  attribution jsonb not null check (jsonb_typeof(attribution) = 'object'),
  created_at  timestamptz not null default now()
);
comment on table public.system_signup_sources is
  'P33: where a free self-serve signup came from (src, med, camp, cnt, landing, first_touch_at), re-sanitized by system-signup. First signup per client only. Service role only.';
alter table public.system_signup_sources enable row level security;
revoke all on table public.system_signup_sources from public, anon, authenticated;
grant all on table public.system_signup_sources to service_role;

-- ── 3. The gate ─────────────────────────────────────────────────────────────────────────
-- Returns { decision, attempt_id }. decision: ok | email_recent | ip_limited | paused.
-- 'ok' rows are later marked 'sent', 'send_failed' or 'failed' by system-signup. An 'ok' row
-- that was never marked (a crash) still counts against the address and the cap: fail closed.
create or replace function public.system_signup_gate(p_email_hash text, p_ip_hash text, p_daily_cap integer)
returns jsonb
language plpgsql security definer
set search_path = public as $fn$
declare
  v_cap      integer := greatest(coalesce(p_daily_cap, 50), 0);
  v_decision text;
  v_id       uuid;
begin
  if p_email_hash is null or char_length(p_email_hash) < 16 or p_ip_hash is null or char_length(p_ip_hash) < 16 then
    raise exception 'system_signup_gate: hashes required';
  end if;
  perform pg_advisory_xact_lock(hashtext('system_signup_gate'));

  if (select count(*) from public.system_signup_attempts
       where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 5 then
    v_decision := 'ip_limited';
  elsif exists (select 1 from public.system_signup_attempts
                 where email_hash = p_email_hash and decision in ('ok', 'sent')
                   and created_at > now() - interval '24 hours') then
    v_decision := 'email_recent';
  elsif (select count(*) from public.system_signup_attempts
          where decision in ('ok', 'sent') and created_at > now() - interval '24 hours') >= v_cap then
    v_decision := 'paused';
  else
    v_decision := 'ok';
  end if;

  insert into public.system_signup_attempts (email_hash, ip_hash, decision)
  values (p_email_hash, p_ip_hash, v_decision) returning id into v_id;
  return jsonb_build_object('decision', v_decision, 'attempt_id', v_id);
end $fn$;
revoke all on function public.system_signup_gate(text, text, integer) from public, anon, authenticated;
grant execute on function public.system_signup_gate(text, text, integer) to service_role;

-- ── 4. Provision ────────────────────────────────────────────────────────────────────────
create or replace function public.provision_system_signup(p_email text)
returns jsonb
language plpgsql security definer
set search_path = public as $fn$
declare
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_tenant uuid;
  v_client public.clients%rowtype;
  v_token  text;
  v_new    boolean := false;
begin
  if v_email = '' or position('@' in v_email) = 0 or char_length(v_email) > 254 then
    raise exception 'provision_system_signup: email required';
  end if;
  select t.id into v_tenant from public.tenants t join public.tenant_config c on c.tenant_id = t.id
   where t.slug = 'self-serve' and c.mode = 'self_serve';
  if v_tenant is null then raise exception 'provision_system_signup: self-serve tenant missing or not self_serve'; end if;

  -- One client per email in the self-serve tenant, even under two simultaneous signups.
  perform pg_advisory_xact_lock(hashtext('system_signup:' || v_email));
  select * into v_client from public.clients
   where tenant_id = v_tenant and lower(email) = v_email
   order by joined_at asc nulls last limit 1;

  if v_client.id is null then
    insert into public.clients (tenant_id, display_name, email, status, client_type, origin)
    values (v_tenant, split_part(v_email, '@', 1), v_email, 'invited', 'lifestyle', 'system')
    returning * into v_client;
    v_new := true;
  elsif v_client.status = 'archived'
     or exists (select 1 from public.intake_forms f where f.client_id = v_client.id and f.status = 'submitted') then
    -- Already started: no new intake token from a public form. They sign in instead.
    return jsonb_build_object('client_id', v_client.id, 'kind', 'existing', 'new_client', false);
  end if;

  select token into v_token from public.intake_forms
   where client_id = v_client.id and status = 'pending' and (expires_at is null or expires_at > now())
   order by created_at desc limit 1;
  if v_token is null then
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into public.intake_forms (tenant_id, client_id, token, status, expires_at, answers)
    values (v_tenant, v_client.id, v_token, 'pending', now() + interval '14 days', '{}'::jsonb);
  end if;
  return jsonb_build_object('client_id', v_client.id, 'kind', 'intake', 'intake_token', v_token, 'new_client', v_new);
end $fn$;
revoke all on function public.provision_system_signup(text) from public, anon, authenticated;
grant execute on function public.provision_system_signup(text) to service_role;

-- ── 5. The paid path's provisioner stays for existing deployments ───────────────────────
comment on function public.provision_system_buyer(text, text, jsonb) is
  'DEPRECATED (P33, 2026-11-14): the self-serve plan is a free signup (provision_system_signup). Kept so deployments that still run the old paid redeem path do not break. Nothing in this copy calls it.';
