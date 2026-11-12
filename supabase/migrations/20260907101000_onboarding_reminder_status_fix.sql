-- Slice 2 fix, found by ops/tests/onboarding_reminders.test.sql group 13 on the first live run
-- (2026-09-07 03:15 CDT): onboarding_reminder_status() read the switch values as `v` from
-- jsonb_each_text(), whose columns are key/value. Every coach call errored; nothing else in
-- the slice touches this function. Same body, one alias.

create or replace function public.onboarding_reminder_status()
returns jsonb
language plpgsql stable security definer
set search_path = public as $fn$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or coalesce(current_app_role(), '') <> 'coach' then
    raise exception 'onboarding_reminder_status: coach only';
  end if;
  return (
    select jsonb_build_object(
      'sender_email', tc.sender_email,
      'switches', coalesce(tc.onboarding_reminders, '{}'::jsonb),
      'any_on', coalesce((select bool_or(e.value::boolean)
                            from jsonb_each_text(coalesce(tc.onboarding_reminders, '{}'::jsonb)) e), false),
      'sent_24h', (select count(*) from notification_log n where n.tenant_id = v_tenant
                     and n.template in ('intake_reminder', 'invite_reminder', 'first_open_reminder')
                     and n.status = 'sent' and n.sent_at > now() - interval '24 hours'),
      'skipped_no_sender_24h', (select count(*) from notification_log n where n.tenant_id = v_tenant
                     and n.template in ('intake_reminder', 'invite_reminder', 'first_open_reminder')
                     and n.status in ('skipped_no_sender', 'skipped_sender_unverified') and n.sent_at > now() - interval '24 hours'),
      'skipped_switch_off_24h', (select count(*) from notification_log n where n.tenant_id = v_tenant
                     and n.template in ('intake_reminder', 'invite_reminder', 'first_open_reminder')
                     and n.status = 'skipped_switch_off' and n.sent_at > now() - interval '24 hours'),
      'last_run', (select jsonb_build_object('finished_at', r.finished_at, 'outcome', r.outcome, 'healthy', r.healthy)
                     from ops_job_runs r where r.job = 'onboarding-nudge' order by r.finished_at desc limit 1)
    )
    from tenant_config tc where tc.tenant_id = v_tenant
  );
end $fn$;

revoke all on function public.onboarding_reminder_status() from public, anon;
grant execute on function public.onboarding_reminder_status() to authenticated;
