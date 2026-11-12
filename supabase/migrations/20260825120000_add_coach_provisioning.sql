-- ============================================================================
-- Add-a-coach, one click: schema for trial / comped / already-paid provisioning.
--
-- The platform owner needs to add a new coach as easily as a coach adds a client, without
-- a raw SQL insert every time (which is how the first coaches were
-- actually created). Mirrors two patterns already proven in this codebase:
--   - provision_licensed_coach() (20260824200000): atomic tenant + tenant_config
--     creation in one transaction, no partial-write failure mode.
--   - clients.invite_token / claim_client_invite(): a coach-created record with
--     no auth user attached yet, claimed later by whoever signs in with the
--     token. Same shape here, but claiming attaches a *coach*, not a client.
--
-- New tenant columns:
--   trial_ends_at       -- set only for a trial coach; null for comped/paid/legacy.
--   invite_token / invite_expires_at -- how the not-yet-signed-in coach claims
--     this tenant. 14-day TTL, matching client-invite's INVITE_TTL_DAYS.
-- ============================================================================

alter table public.tenants
  add column if not exists trial_ends_at timestamptz,
  add column if not exists invite_token text,
  add column if not exists invite_expires_at timestamptz;

create unique index if not exists tenants_invite_token_key on public.tenants (invite_token)
  where invite_token is not null;

-- --- provision_coach_admin -------------------------------------------------
-- Atomic tenant + tenant_config creation for a coach who doesn't have an auth
-- user yet. Exactly one of the three modes' fields gets set; the other two
-- stay null, so a single glance at the row tells you which situation a tenant
-- is in. `p_reason` is required for 'comped' (mirrors the existing
-- tenants.comp_reason convention of always naming why). `p_subscription_id` /
-- p_customer_id for 'paid' are NOT verified against Stripe here -- that check
-- happens in the calling edge function (admin-provision-coach), which is the
-- only caller with the Stripe key. This function trusts its caller completely,
-- which is why it is service_role only.
create or replace function public.provision_coach_admin(
  p_app_name text,
  p_display_name text,
  p_mode text,                    -- 'trial' | 'comped' | 'paid'
  p_reason text default null,
  p_subscription_id text default null,
  p_customer_id text default null
)
returns public.tenants
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  base0   text;
  v_slug  text;
  n       int := 0;
  t       public.tenants;
  tok     text;
begin
  if p_mode not in ('trial', 'comped', 'paid') then
    raise exception 'provision_coach_admin: invalid mode %', p_mode;
  end if;
  if p_mode = 'comped' and coalesce(nullif(trim(p_reason), ''), '') = '' then
    raise exception 'provision_coach_admin: comped mode requires a reason';
  end if;
  if p_mode = 'paid' and (p_subscription_id is null or p_customer_id is null) then
    raise exception 'provision_coach_admin: paid mode requires both subscription_id and customer_id';
  end if;

  base0 := regexp_replace(lower(coalesce(nullif(p_app_name, ''), 'coach')), '[^a-z0-9]+', '-', 'g');
  base0 := trim(both '-' from base0);
  if base0 = '' then base0 := 'coach'; end if;

  -- Not named `slug` -- a local variable with the same name as the tenants.slug
  -- column raises "column reference is ambiguous" (42702) inside the query
  -- below. Found live 2026-08-25 (see the standalone migration that fixes the
  -- same bug in the already-shipped provision_licensed_coach).
  v_slug := base0;
  while exists (select 1 from public.tenants where slug = v_slug) loop
    n := n + 1;
    v_slug := base0 || '-' || n;
  end loop;

  -- Same token shape as client-invite's crypto.randomUUID()+crypto.randomUUID(),
  -- reproduced in SQL so the whole row is written in one atomic insert.
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into public.tenants (
    slug, status,
    trial_ends_at, comp_reason, subscription_id, stripe_customer_id, subscription_status,
    invite_token, invite_expires_at
  ) values (
    v_slug, 'active',
    case when p_mode = 'trial' then now() + interval '14 days' else null end,
    case when p_mode = 'comped' then p_reason else null end,
    case when p_mode = 'paid' then p_subscription_id else null end,
    case when p_mode = 'paid' then p_customer_id else null end,
    case when p_mode = 'paid' then 'active' else null end,
    tok, now() + interval '14 days'
  )
  returning * into t;

  insert into public.tenant_config (tenant_id, app_name, coach_display_name)
  values (t.id, coalesce(nullif(p_app_name, ''), 'My Coaching App'), coalesce(nullif(p_display_name, ''), 'Coach'));

  return t;
end;
$$;

comment on function public.provision_coach_admin(text, text, text, text, text, text) is
  'Atomic tenant+tenant_config creation for a coach with no auth user yet (trial/comped/paid). Service-role only -- the caller (admin-provision-coach edge function) must independently verify the caller is the owner-tenant coach, and for paid mode, that the subscription is real, before calling this.';

revoke all on function public.provision_coach_admin(text, text, text, text, text, text) from public;
revoke all on function public.provision_coach_admin(text, text, text, text, text, text) from anon;
revoke all on function public.provision_coach_admin(text, text, text, text, text, text) from authenticated;
grant execute on function public.provision_coach_admin(text, text, text, text, text, text) to service_role;

-- --- claim_coach_invite -----------------------------------------------------
-- Mirrors claim_client_invite's shape exactly (validate token -> check not
-- already claimed -> attach the signed-in user -> clear the token), operating
-- on tenants/coach instead of clients/client. Callable by any authenticated
-- user (same as claim_client_invite) -- the function does its own
-- authorization by requiring a live, unexpired, unclaimed token.
--
-- Deliberately stricter than claim_client_invite on one point: refuses if the
-- caller already has ANY profile row (coach or client, any tenant), rather
-- than silently no-op'ing via ON CONFLICT DO NOTHING the way the client flow
-- does for an already-'client' caller. A brand-new coach account should not
-- already belong to something else.
create or replace function public.claim_coach_invite(p_token text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  v_confirmed timestamptz;
  v_tenant public.tenants;
begin
  if uid is null then return 'not_authenticated'; end if;
  if p_token is null or length(p_token) < 16 then return 'invalid'; end if;

  select email_confirmed_at into v_confirmed from auth.users where id = uid;
  if v_confirmed is null then return 'unconfirmed'; end if;

  select * into v_tenant from public.tenants where invite_token = p_token;
  if not found then return 'invalid'; end if;

  if v_tenant.invite_expires_at is not null and v_tenant.invite_expires_at < now() then
    return 'expired';
  end if;

  if v_tenant.coach_user_id is not null then
    if v_tenant.coach_user_id = uid then return 'already_yours'; end if;
    return 'already_claimed';
  end if;

  if exists (select 1 from public.profiles where user_id = uid) then
    return 'already_has_account';
  end if;

  update public.tenants
     set coach_user_id     = uid,
         invite_token      = null,
         invite_expires_at = null,
         updated_at        = now()
   where id = v_tenant.id;

  insert into public.profiles (user_id, role, tenant_id)
  values (uid, 'coach', v_tenant.id);

  return 'claimed';
end;
$$;

comment on function public.claim_coach_invite(text) is
  'Attaches the signed-in user as coach_user_id on a pending (unclaimed) tenant created by provision_coach_admin, and creates their profiles row. Mirrors claim_client_invite.';
