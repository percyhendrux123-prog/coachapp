-- Service-role variant of mint_my_intake_token for the MCP owner tool regenerate_my_plan,
-- which runs under the service role with the client id taken from the token row (never an
-- argument). Same 28-day rule, same self_serve requirement.
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

  -- Measured from when the buyer SUBMITTED, not when the token was minted (a token can sit
  -- unused for days before submission; created_at would start the 28-day clock too early).
  select max(submitted_at) into v_last
    from public.intake_forms
   where client_id = v_client and status = 'submitted';
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

revoke all on function public.mint_intake_token_for_client(uuid) from public, anon, authenticated;
grant execute on function public.mint_intake_token_for_client(uuid) to service_role;
