-- Activity v1 uses notification_log as the internal activity ledger.
-- This is not external delivery: no email, SMS, or push is sent by this channel.
alter type public.notif_channel add value if not exists 'in_app';

drop policy if exists notif_client_insert_in_app on public.notification_log;
create policy notif_client_insert_in_app on public.notification_log
  for insert
  with check (
    channel::text = 'in_app'
    and client_id = public.current_client_id()
    and tenant_id = public.current_tenant_id()
  );

drop policy if exists notif_coach_insert_in_app on public.notification_log;
create policy notif_coach_insert_in_app on public.notification_log
  for insert
  with check (
    channel::text = 'in_app'
    and tenant_id = public.current_tenant_id()
    and public.current_app_role() = 'coach'
  );
