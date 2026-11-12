-- ============================================================================
-- Mark thread read: SECURITY DEFINER, tenant/role from profiles not JWT.
--
-- mark_thread_read carried the same JWT-preference bug as send_coach_message
-- and create_coach_client before 20260824160000: it depends on
-- current_tenant_id() / current_app_role(), which trust the JWT claim over
-- profiles and only fall back when the claim is empty (not merely wrong).
-- On a drifted session the read-pointer update failed RLS on
-- public.messages with the same "new row violates row-level security
-- policy" error, live in Inbox on 2026-08-24 — the same page as the
-- already-fixed Send button, one function over.
--
-- Mirrors 20260824160000_coach_ui_writes_definer.sql: read role + tenant
-- from public.profiles where user_id = auth.uid(), run as SECURITY DEFINER
-- so RLS cannot refuse a correctly stamped row. Refuses non-coaches,
-- missing tenant, and other-tenant clients. Still a pure read-pointer
-- stamp — no new write surface, no change to what gets marked read.
--
-- Rollback: restore the SECURITY INVOKER definition (drop the `security
-- definer` line and the `me` lookup, revert to current_tenant_id()/auth.uid()
-- directly as it read before this migration).
-- ============================================================================

create or replace function public.mark_thread_read(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  me public.profiles;
begin
  select * into me from public.profiles where user_id = auth.uid();
  if me.user_id is null or me.role is distinct from 'coach' then
    raise exception 'Only a coach can mark a thread read.';
  end if;
  if me.tenant_id is null then
    raise exception 'Your coaching session has no tenant. Sign out and sign back in.';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.tenant_id = me.tenant_id
  ) then
    raise exception 'Client not found.';
  end if;

  -- Stamp the per-coach read pointer (used by coach_inbox() for badge counts).
  insert into public.message_reads (tenant_id, client_id, reader_user_id, last_read_at)
  values (me.tenant_id, p_client_id, auth.uid(), now())
  on conflict (tenant_id, client_id, reader_user_id)
  do update set last_read_at = excluded.last_read_at;

  -- Stamp the aggregate read column on every unread client message in this
  -- thread. This is the signal the read model queries — once read_at is set,
  -- rm_source_health stops counting it as unread and rm_attention_candidates
  -- drops its unread_message signal.
  update public.messages
     set read_at = now()
   where tenant_id = me.tenant_id
     and client_id = p_client_id
     and sender_role = 'client'
     and read_at is null;
end;
$$;

comment on function public.mark_thread_read(uuid) is
  'Coach Inbox — stamp read pointer + read_at. Stamps tenant from profiles for auth.uid(). SECURITY DEFINER so JWT/RLS drift cannot block a coach marking a thread read.';

revoke all on function public.mark_thread_read(uuid) from public;
revoke all on function public.mark_thread_read(uuid) from anon;
grant execute on function public.mark_thread_read(uuid) to authenticated;

notify pgrst, 'reload schema';
