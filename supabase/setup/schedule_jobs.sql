-- Optional scheduled jobs (pg_cron + pg_net). Enable both extensions in the Supabase
-- dashboard first, and create the two vault secrets described in .env.example
-- (project_url, cron_reconcile_bearer = your CRON_SECRET).
-- onboarding-nudge-daily is already scheduled by a migration.

-- Daily: sync white-label hosting subscriptions from Stripe and run the grace policy.
select cron.schedule(
  'license-reconcile-daily',
  '17 8 * * *',
  $cron$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/license-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_reconcile_bearer')
    ),
    body    := '{}'::jsonb
  );
  $cron$
);

-- Daily: email the platform owner a digest of the last 24 hours (needs DIGEST_RECIPIENT).
select cron.schedule(
  'send-digest-daily',
  '0 13 * * *',
  $cron$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_reconcile_bearer')
    ),
    body    := '{}'::jsonb
  );
  $cron$
);
