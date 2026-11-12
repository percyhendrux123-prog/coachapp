-- Slice 2: the daily reminder run. Same transport as license-reconcile-daily and
-- send-digest-daily (both created by hand on the live project; this one lives in the repo):
-- pg_cron → net.http_post → the edge function, bearer read from the vault secret
-- 'cron_reconcile_bearer' (= CRON_SECRET). The function refuses anything without it.
--
-- 15:00 UTC = 10:00 Central. The two existing jobs run at 08:00/08:17 UTC (3am Central),
-- which is fine for a coach digest and wrong for a message to a client's phone.
--
-- Nothing this job sends can leave until a tenant's switch is ON and a sender is set
-- (tenant_config.onboarding_reminders / sender_email — both default off/null). Scheduling
-- the run is safe on its own; the first live run should still be preceded by a dry run
-- (POST {"dry":true} with the bearer) so the candidate list is read by a human first.

select cron.unschedule(jobid) from cron.job where jobname = 'onboarding-nudge-daily';

select cron.schedule(
  'onboarding-nudge-daily',
  '0 15 * * *',
  $cron$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/onboarding-nudge',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_reconcile_bearer')
    ),
    body    := '{}'::jsonb
  );
  $cron$
);
