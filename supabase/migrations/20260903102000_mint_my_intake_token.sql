-- Re-intake for self-serve buyers: mint a fresh intake_forms token for MY client row, at most
-- once per 28 days. Client-callable; the function does its own authorization — the row it
-- writes is always the caller's own, in a self_serve tenant, or nothing.
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

revoke all on function public.mint_my_intake_token() from public, anon;
grant execute on function public.mint_my_intake_token() to authenticated;
