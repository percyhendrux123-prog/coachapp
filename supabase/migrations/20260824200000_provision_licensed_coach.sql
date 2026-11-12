-- ============================================================================
-- Atomic license provisioning.
--
-- license-provision (the edge function) used to do three separate inserts
-- (tenants, then profiles, then tenant_config) with no transaction. A
-- mid-way failure — the second or third insert erroring — left the paid
-- session's license_stripe_ref (UNIQUE) already burned, a half-built
-- tenant on record, and no self-serve way to finish or retry: idempotency
-- check 2 (by license_stripe_ref) would find the orphan tenant and report
-- "already_provisioned" forever, with no profile and no config behind it.
--
-- This function does all three writes as one statement, mirroring the
-- existing public.provision_coach() (which already does this correctly)
-- but taking the extra license/subscription fields the paid path needs.
-- A raised exception anywhere inside rolls back everything this call did.
--
-- SECURITY: takes an arbitrary p_user_id — this must NEVER be reachable by
-- a coach's own session, only by the service role after license-provision
-- has independently verified a real Stripe payment server-side. Grants
-- reflect that: revoked from anon/authenticated, granted to service_role
-- only.
-- ============================================================================

create or replace function public.provision_licensed_coach(
  p_user_id uuid,
  p_app_name text,
  p_display_name text,
  p_session_id text,
  p_customer_id text,
  p_subscription_id text
)
returns public.tenants
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  base0 text;
  slug  text;
  n     int := 0;
  t     public.tenants;
begin
  base0 := regexp_replace(lower(coalesce(nullif(p_app_name,''), 'coach')), '[^a-z0-9]+', '-', 'g');
  base0 := trim(both '-' from base0);
  if base0 = '' then base0 := 'coach'; end if;

  slug := base0;
  while exists (select 1 from public.tenants where slug = slug) loop
    n := n + 1;
    slug := base0 || '-' || n;
  end loop;

  insert into public.tenants (
    coach_user_id, slug, license_stripe_ref, licensed_at,
    stripe_customer_id, subscription_id, subscription_status, status
  ) values (
    p_user_id, slug, p_session_id, now(),
    p_customer_id, p_subscription_id, 'active', 'active'
  )
  returning * into t;

  insert into public.profiles (user_id, role, tenant_id)
  values (p_user_id, 'coach', t.id);

  insert into public.tenant_config (tenant_id, app_name, coach_display_name)
  values (t.id, coalesce(nullif(p_app_name,''), 'My Coaching App'), coalesce(nullif(p_display_name,''), 'Coach'));

  return t;
end;
$$;

comment on function public.provision_licensed_coach(uuid, text, text, text, text, text) is
  'Atomic tenant+profile+tenant_config creation for a paid white-label license. Service-role only — the caller (license-provision edge function) must independently verify the Stripe payment before calling this.';

revoke all on function public.provision_licensed_coach(uuid, text, text, text, text, text) from public;
revoke all on function public.provision_licensed_coach(uuid, text, text, text, text, text) from anon;
revoke all on function public.provision_licensed_coach(uuid, text, text, text, text, text) from authenticated;
grant execute on function public.provision_licensed_coach(uuid, text, text, text, text, text) to service_role;
