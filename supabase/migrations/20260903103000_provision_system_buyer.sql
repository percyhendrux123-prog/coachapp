-- Atomic SYSTEM buyer provisioning: clients row + intake_forms token (with the pre-pay
-- health-screen answers pre-filled) in ONE transaction, or nothing. Modelled on
-- provision_licensed_coach (20260824200000): a mid-way failure must never burn a payment.
-- Idempotent on the checkout session id (unique index below). The auth user is created by
-- the calling edge function AFTER this returns (GoTrue is not in this transaction); the
-- existing on_auth_user_confirmed → link_client_by_email links it on first sign-in.
--
-- client_type = 'lifestyle' hardcoded below — confirmed live 2026-09-02 against
-- clients_client_type_ck (CHECK: null or 'lifestyle'/'prep'). SYSTEM buyers are always
-- lifestyle, never prep (there is no coach to run a prep cycle against).
alter table public.clients add column if not exists system_checkout_session_id text;
create unique index if not exists clients_system_checkout_session_key
  on public.clients (system_checkout_session_id) where system_checkout_session_id is not null;

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
    insert into public.clients (tenant_id, display_name, email, status, client_type, system_checkout_session_id)
    values (v_tenant, split_part(v_email, '@', 1), v_email, 'invited', 'lifestyle', p_session_id)
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

revoke all on function public.provision_system_buyer(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.provision_system_buyer(text, text, jsonb) to service_role;
