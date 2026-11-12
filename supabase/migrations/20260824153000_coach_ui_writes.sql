-- ============================================================================
-- Coach UI writes stamp tenant on the server.
--
-- Inbox send and Add client were browser inserts that copied profile.tenant_id
-- from the session. When that value was missing or belonged to another tenant,
-- Postgres refused the row: new row violates row-level security policy.
-- The coach then had to ask an agent to insert the client or the message.
--
-- These RPCs keep the existing RLS. They fill tenant_id from
-- current_tenant_id() so a signed-in coach can add a client and reply
-- from the app. Send remains a PURE APPEND — it does not mark the thread read.
--
-- Rollback: drop the two functions.
-- ============================================================================

create or replace function public.send_coach_message(p_client_id uuid, p_body text)
returns public.messages
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  tid uuid := public.current_tenant_id();
  rec public.messages;
  cleaned text := trim(coalesce(p_body, ''));
begin
  if public.current_app_role() is distinct from 'coach' then
    raise exception 'Only a coach can send this message.';
  end if;
  if tid is null then
    raise exception 'Your coaching session has no tenant. Sign out and sign back in.';
  end if;
  if cleaned = '' then
    raise exception 'Message cannot be empty.';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.tenant_id = tid
  ) then
    raise exception 'Client not found.';
  end if;

  insert into public.messages (tenant_id, client_id, sender_role, body)
  values (tid, p_client_id, 'coach', cleaned)
  returning * into rec;
  return rec;
end;
$$;

comment on function public.send_coach_message(uuid, text) is
  'Coach Inbox / client-tab reply. Stamps tenant_id from the session. Pure append — does not mark the thread read.';

revoke all on function public.send_coach_message(uuid, text) from public;
grant execute on function public.send_coach_message(uuid, text) to authenticated;

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
security invoker
set search_path to 'public'
as $$
declare
  tid uuid := public.current_tenant_id();
  rec public.clients;
  cleaned_name text := trim(coalesce(p_display_name, ''));
  cleaned_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  cleaned_type text := nullif(trim(coalesce(p_client_type, '')), '');
  st text := coalesce(nullif(trim(coalesce(p_status, '')), ''), 'invited');
begin
  if public.current_app_role() is distinct from 'coach' then
    raise exception 'Only a coach can add a client.';
  end if;
  if tid is null then
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
    where c.tenant_id = tid and lower(c.email) = cleaned_email
  ) then
    raise exception 'A client with that email already exists.';
  end if;

  insert into public.clients (
    tenant_id, display_name, email, coaching_tier, status,
    client_type, show_date, show_name
  ) values (
    tid,
    cleaned_name,
    cleaned_email,
    nullif(trim(coalesce(p_coaching_tier, '')), ''),
    st::public.client_status,
    cleaned_type,
    case when cleaned_type = 'prep' then p_show_date else null end,
    case when cleaned_type = 'prep' then nullif(trim(coalesce(p_show_name, '')), '') else null end
  )
  returning * into rec;
  return rec;
end;
$$;

comment on function public.create_coach_client(text, text, text, text, text, date, text) is
  'Clients → Add client. Stamps tenant_id from the session so a coach can create a roster row from the app.';

revoke all on function public.create_coach_client(text, text, text, text, text, date, text) from public;
grant execute on function public.create_coach_client(text, text, text, text, text, date, text) to authenticated;
