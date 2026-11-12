-- ============================================================================
-- Populate messages.read_at so the Signal Integrity box and attention queue
-- can detect closed-loop threads.
--
-- The read model (rm_source_health, rm_attention_candidates) has always
-- queried messages.read_at IS NULL to determine unread state. But read_at
-- was never written — mark_thread_read() upserted into message_reads only,
-- and sendCoachMessage() only inserted new rows.
--
-- read_at now gets stamped in TWO places:
--   1. mark_thread_read() — when a coach opens a thread in the inbox
--   2. sendCoachMessage() — when a coach replies (call-site, JS side)
--
-- Both paths converge on the same RPC, so every coach action that implies
-- "I've seen this thread" writes read_at, and the read model queries start
-- returning accurate counts without any structural change to the SQL.
--
-- Rollback: revert mark_thread_read() to the prior definition.
-- ============================================================================

create or replace function public.mark_thread_read(p_client_id uuid)
returns void
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  -- Stamp the per-coach read pointer (used by coach_inbox() for badge counts).
  insert into public.message_reads (tenant_id, client_id, reader_user_id, last_read_at)
  values (current_tenant_id(), p_client_id, auth.uid(), now())
  on conflict (tenant_id, client_id, reader_user_id)
  do update set last_read_at = excluded.last_read_at;

  -- Stamp the aggregate read column on every unread client message in this
  -- thread. This is the signal the read model queries — once read_at is set,
  -- rm_source_health stops counting it as unread and rm_attention_candidates
  -- drops its unread_message signal.
  update public.messages
     set read_at = now()
   where tenant_id = current_tenant_id()
     and client_id = p_client_id
     and sender_role = 'client'
     and read_at is null;
end;
$$;

comment on function public.mark_thread_read(uuid) is
  'Upserts the coach read pointer in message_reads AND stamps messages.read_at on unread client messages in the thread, so the read model sees a closed loop.';

-- Also backfill existing threads where the coach has a read pointer but
-- messages.read_at was never set. This fixes the current data so the Signal
-- Integrity box and attention queue correct themselves immediately after
-- deploy, without waiting for the next coach action.
update public.messages m
   set read_at = mr.last_read_at
  from message_reads mr
 where mr.tenant_id = m.tenant_id
   and mr.client_id = m.client_id
   and m.sender_role = 'client'
   and m.read_at is null
   and mr.last_read_at is not null;

grant execute on function public.mark_thread_read(uuid) to authenticated;