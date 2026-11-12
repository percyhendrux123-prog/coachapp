-- ============================================================================
-- Coach UI writes: SECURITY DEFINER, tenant from profiles not JWT.
--
-- fb2e139 shipped invoker RPCs. Inbox still returned
--   new row violates row-level security policy for table "messages"
-- after a force-stop on Android and iPad. Live JS already calls
-- send_coach_message. The insert still ran as `authenticated` and RLS
-- used JWT claims (user_role / tenant_id) which can disagree with
-- profiles.role — the source the coach UI actually trusts.
--
-- These replacements:
--   * read role + tenant from public.profiles where user_id = auth.uid()
--   * insert as SECURITY DEFINER so RLS cannot refuse a correctly stamped row
--   * still refuse non-coaches, missing tenant, empty body, and other-tenant clients
--   * send remains a PURE APPEND
--
-- Rollback: restore the invoker definitions from 20260824153000.
-- ============================================================================

create or replace function public.send_coach_message(p_client_id uuid, p_body text)
returns public.messages
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  me public.profiles;
  rec public.messages;
  cleaned text := trim(coalesce(p_body, ''));
begin
  select * into me from public.profiles where user_id = auth.uid();
  if me.user_id is null or me.role is distinct from 'coach' then
    raise exception 'Only a coach can send this message.';
  end if;
  if me.tenant_id is null then
    raise exception 'Your coaching session has no tenant. Sign out and sign back in.';
  end if;
  if cleaned = '' then
    raise exception 'Message cannot be empty.';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.tenant_id = me.tenant_id
  ) then
    raise exception 'Client not found.';
  end if;

  insert into public.messages (tenant_id, client_id, sender_role, body)
  values (me.tenant_id, p_client_id, 'coach', cleaned)
  returning * into rec;
  return rec;
end;
$$;

comment on function public.send_coach_message(uuid, text) is
  'Coach Inbox / client-tab reply. Stamps tenant from profiles for auth.uid(). Pure append. SECURITY DEFINER so JWT/RLS drift cannot block a coach send.';

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
    client_type, show_date, show_name
  ) values (
    me.tenant_id,
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
  'Clients → Add client. Stamps tenant from profiles for auth.uid(). SECURITY DEFINER so JWT/RLS drift cannot block roster create.';

revoke all on function public.create_coach_client(text, text, text, text, text, date, text) from public;
grant execute on function public.create_coach_client(text, text, text, text, text, date, text) to authenticated;

notify pgrst, 'reload schema';
