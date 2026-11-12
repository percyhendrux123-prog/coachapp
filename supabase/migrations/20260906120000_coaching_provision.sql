-- Slice 0 of the original design notes (not included) — paid → intake link, automatic.
--
-- 1. clients.stripe_checkout_session_id — the owner-tenant coaching Checkout Session that created
--    or attached this client. Unique where set: one payment provisions once, however many
--    times the /welcome page or the webhook replays it. Separate from
--    system_checkout_session_id on purpose (different product, different tenant).
-- 2. origin gains 'stripe_coaching' (a coaching client created by an owner-tenant payment).
-- 3. provision_coaching_client(): the twin of provision_system_buyer for the owner tenant.
--    Service-role only — called by coaching-provision and stripe-webhook, never a browser.
--    Matches an existing owner-tenant client by email (two matches → refuses, 'ambiguous', same
--    rule as intake_match_or_create_client), otherwise inserts an invited client with the
--    tier from the price map; mints a 14-day intake token either way.

alter table public.clients
  add column if not exists stripe_checkout_session_id text;
create unique index if not exists clients_stripe_checkout_session_uidx
  on public.clients (stripe_checkout_session_id) where stripe_checkout_session_id is not null;
comment on column public.clients.stripe_checkout_session_id is
  'Owner-tenant coaching Checkout Session (cs_…) that provisioned or attached this client. NULL = paid outside this path or before 2026-09-06 — not tracked, never inferred.';

alter table public.clients drop constraint if exists clients_origin_ck;
alter table public.clients
  add constraint clients_origin_ck
  check (origin is null or origin in ('system', 'coach_invite', 'trainerize_import', 'stripe_coaching'));

create or replace function public.provision_coaching_client(p_email text, p_session_id text, p_tier text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant  uuid;
  v_client  uuid;
  v_token   text;
  v_matches int;
  v_email   text := lower(trim(p_email));
begin
  if v_email is null or v_email = '' or position('@' in v_email) = 0 then
    raise exception 'provision_coaching_client: email required';
  end if;
  if p_session_id is null or p_session_id = '' then
    raise exception 'provision_coaching_client: session id required';
  end if;
  if p_tier is null or p_tier not in ('entry', 'standard') then
    raise exception 'provision_coaching_client: tier must be entry or standard, got %', coalesce(p_tier, 'null');
  end if;

  select id into v_tenant from public.tenants where slug = 'owner';
  if v_tenant is null then raise exception 'provision_coaching_client: owner tenant missing'; end if;

  -- Idempotency: this payment already produced or attached a client.
  select id into v_client from public.clients where stripe_checkout_session_id = p_session_id;
  if v_client is not null then
    select token into v_token from public.intake_forms
     where client_id = v_client order by created_at desc limit 1;
    return jsonb_build_object('client_id', v_client, 'intake_token', v_token, 'outcome', 'existed');
  end if;

  select count(*) into v_matches from public.clients
   where tenant_id = v_tenant and lower(trim(email)) = v_email;
  if v_matches > 1 then
    return jsonb_build_object('outcome', 'ambiguous', 'matches', v_matches,
      'detail', format('%s owner-tenant client records share this email; which one paid is not knowable from the data. Merge the duplicates, then attach the session by hand.', v_matches));
  end if;

  if v_matches = 1 then
    select id into v_client from public.clients
     where tenant_id = v_tenant and lower(trim(email)) = v_email;
    update public.clients
       set stripe_checkout_session_id = p_session_id,
           coaching_tier = coalesce(coaching_tier, p_tier),
           status = case when status = 'archived' then 'invited' else status end,
           updated_at = now()
     where id = v_client;
  else
    insert into public.clients (tenant_id, display_name, email, status, coaching_tier, stripe_checkout_session_id, origin)
    values (v_tenant, split_part(v_email, '@', 1), v_email, 'invited', p_tier, p_session_id, 'stripe_coaching')
    returning id into v_client;
  end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.intake_forms (tenant_id, client_id, token, status, expires_at)
  values (v_tenant, v_client, v_token, 'pending', now() + interval '14 days');

  return jsonb_build_object('client_id', v_client, 'intake_token', v_token,
    'outcome', case when v_matches = 1 then 'attached' else 'created' end);
end;
$$;

revoke all on function public.provision_coaching_client(text, text, text) from public, anon, authenticated;
grant execute on function public.provision_coaching_client(text, text, text) to service_role;
comment on function public.provision_coaching_client(text, text, text) is
  'Service role only. Provisions or attaches an owner-tenant coaching client from a paid Checkout Session and mints a 14-day intake token. Idempotent on session id; refuses an ambiguous email match.';
