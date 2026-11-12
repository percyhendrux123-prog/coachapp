-- Slice 2 of the original design notes (not included) — reminders on the stalls.
--
-- Three things, all read-side except two config columns and one index:
--   1. tenant_config.sender_email + tenant_config.onboarding_reminders — the sending identity
--      and the four per-tenant switches (D3: default ALL OFF; the platform owner flips them in Settings).
--   2. onboarding_reminders_due() — the selection. Reads client_onboarding_facts() for every
--      tenant, applies the approved thresholds, drops anything already sent (idempotent on
--      client × template × threshold day × the token it points at), and returns each candidate
--      WITH the facts the sender needs to decide honestly: is the switch on, is there a sender,
--      is there an email, is there a push subscription. The edge function onboarding-nudge does
--      not shape anything — it sends, or logs why it did not.
--   3. onboarding_coach_digest() — the coach-owed section that folds into send-digest, and
--      onboarding_reminder_status() — what the coach home and Settings show about the switches.
--
-- Thresholds (approved 2026-09-06 20:08):
--   intake_reminder     intake pending, day 3 and day 10 (link dies at 14)
--   invite_reminder     invite pending, day 3 and day 10 (link dies at 14)
--   first_open_reminder claimed, never opened, day 2
--   coach digest        daily, once, inside send-digest — not a separate email
-- A threshold fires ONCE per token. Day 3 fires while days 3–9; day 10 fires while days 10–12
-- ("four days left" is not honest at day 13, and the coach resends at 14). If the switch was off
-- when a threshold passed and is flipped on later inside the window, that threshold fires then.

-- ---------- 1. config ----------
alter table public.tenant_config
  add column if not exists sender_email text,
  add column if not exists onboarding_reminders jsonb not null
    default '{"intake": false, "invite": false, "first_open": false, "coach_digest": false}'::jsonb;

alter table public.tenant_config drop constraint if exists tenant_config_sender_email_check;
alter table public.tenant_config add constraint tenant_config_sender_email_check
  check (sender_email is null or sender_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

alter table public.tenant_config drop constraint if exists tenant_config_onboarding_reminders_check;
alter table public.tenant_config add constraint tenant_config_onboarding_reminders_check
  check (jsonb_typeof(onboarding_reminders) = 'object');

comment on column public.tenant_config.sender_email is
  'Address automated client reminders leave from (Resend). NULL = reminders are logged skipped_no_sender, never sent. Must be on a domain verified in Resend; the sender checks that at run time.';
comment on column public.tenant_config.onboarding_reminders is
  'Slice 2 switches: {intake, invite, first_open, coach_digest}. Default all false. A missing key reads as false.';

-- ---------- 2. idempotency: one SENT row per client × template × threshold × token ----------
-- channel is in the key because first_open goes out on email AND push, logged separately.
create unique index if not exists notification_log_onboarding_reminder_once
  on public.notification_log (client_id, channel, template, (consent_snapshot->>'threshold_day'), (consent_snapshot->>'ref'), status)
  where template in ('intake_reminder', 'invite_reminder', 'first_open_reminder');

-- ---------- 3. the selection ----------
create or replace function public.onboarding_reminders_due()
returns table (
  tenant_id uuid,
  tenant_slug text,
  client_id uuid,
  display_name text,
  email text,
  template text,
  threshold_day integer,
  ref text,
  link_path text,
  expires_at timestamptz,
  since timestamptz,
  days_since integer,
  switch_on boolean,
  sender_email text,
  push_subscription jsonb,
  push_ok boolean
)
language plpgsql stable security definer
set search_path = public as $fn$
declare
  t record;
begin
  -- Service role (the cron-driven edge function) or a direct database session (SQL editor,
  -- the test suite). Never a signed-in user: this reads every tenant.
  if auth.uid() is not null and auth.role() is distinct from 'service_role' then
    raise exception 'onboarding_reminders_due: service role only';
  end if;

  for t in
    select tn.id, tn.slug, tc.sender_email, coalesce(tc.onboarding_reminders, '{}'::jsonb) as sw
      from tenants tn left join tenant_config tc on tc.tenant_id = tn.id
  loop
    return query
    with f as (
      select * from client_onboarding_facts(t.id) x where x.client_status not in ('paused', 'archived')
    ),
    cl as (
      select c.id, c.email, c.invite_token, c.invite_expires_at, c.client_user_id, c.updated_at,
             c.push_subscription, c.notif_enabled, c.notif_channels,
             u.last_sign_in_at
        from clients c left join auth.users u on u.id = c.client_user_id
       where c.tenant_id = t.id
    ),
    it as (
      select distinct on (i.client_id) i.client_id, i.id, i.token, i.created_at, i.expires_at
        from intake_forms i where i.tenant_id = t.id order by i.client_id, i.created_at desc
    ),
    raw as (
      -- intake: sent, not submitted, not expired. Clock = when this token was minted.
      select f.client_id, f.display_name, cl.email,
             'intake_reminder'::text as template,
             it.id::text as ref,
             '/intake?token=' || it.token as link_path,
             it.expires_at,
             it.created_at as since,
             'intake'::text as switch_key,
             cl.push_subscription, cl.notif_enabled, cl.notif_channels
        from f join cl on cl.id = f.client_id join it on it.client_id = f.client_id
       where f.next_action = 'awaiting_client_intake' and it.token is not null
      union all
      -- invite: token out, not claimed, not expired. Clock = expiry minus the 14-day TTL
      -- (client-invite's INVITE_TTL_DAYS); the mint time itself is not stored.
      select f.client_id, f.display_name, cl.email,
             'invite_reminder',
             md5(cl.invite_token),
             '/claim?token=' || cl.invite_token,
             cl.invite_expires_at,
             cl.invite_expires_at - interval '14 days',
             'invite',
             cl.push_subscription, cl.notif_enabled, cl.notif_channels
        from f join cl on cl.id = f.client_id
       where f.next_action = 'awaiting_client_claim' and cl.invite_token is not null
      union all
      -- first open: claimed, program and nutrition live, never opened the app. Clock = the
      -- sign-in that claimed it (auth), else the claim's own row update.
      select f.client_id, f.display_name, cl.email,
             'first_open_reminder',
             cl.client_user_id::text,
             '/client',
             null::timestamptz,
             coalesce(cl.last_sign_in_at, cl.updated_at),
             'first_open',
             cl.push_subscription, cl.notif_enabled, cl.notif_channels
        from f join cl on cl.id = f.client_id
       where f.next_action = 'awaiting_first_open' and cl.client_user_id is not null
    ),
    aged as (
      select r.*, floor(extract(epoch from (now() - r.since)) / 86400)::int as days
        from raw r
    ),
    thresholded as (
      select a.*,
             case
               when a.template in ('intake_reminder', 'invite_reminder') and a.days between 10 and 12 then 10
               when a.template in ('intake_reminder', 'invite_reminder') and a.days between 3 and 9 then 3
               when a.template = 'first_open_reminder' and a.days >= 2 then 2
             end as threshold
        from aged a
    )
    select t.id, t.slug, th.client_id, th.display_name, th.email,
           th.template, th.threshold, th.ref, th.link_path, th.expires_at, th.since, th.days,
           coalesce((t.sw ->> th.switch_key)::boolean, false),
           t.sender_email,
           th.push_subscription,
           (coalesce(th.notif_enabled, false) and coalesce((th.notif_channels ->> 'push')::boolean, false)
             and th.push_subscription is not null)
      from thresholded th
     where th.threshold is not null
       and not exists (
         select 1 from notification_log n
          where n.client_id = th.client_id and n.template = th.template and n.status = 'sent'
            and n.consent_snapshot ->> 'threshold_day' = th.threshold::text
            and n.consent_snapshot ->> 'ref' = th.ref)
     order by th.template, th.days desc;
  end loop;
end $fn$;

revoke all on function public.onboarding_reminders_due() from public, anon, authenticated;
grant execute on function public.onboarding_reminders_due() to service_role;
comment on function public.onboarding_reminders_due() is
  'Slice 2: every reminder due today across all tenants, minus those already sent, each with switch/sender/email/push facts so the sender can act or log why not. Service role only. Read-only.';

-- ---------- 4. coach digest section (folds into send-digest) ----------
-- Everything owed BY THE COACH for 3+ days, bucketed the way the approved digest line reads.
-- "nutrition drafts without macros" is the release bucket split by the same macro rule
-- release_checklist() applies (target_* on client_meal_plans, calories/protein/fat/carb on the
-- legacy meal_plans) — so the digest never counts as "ready" something Release would refuse.
create or replace function public.onboarding_coach_digest(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public as $fn$
declare
  v_out jsonb;
begin
  if auth.uid() is not null and auth.role() is distinct from 'service_role' then
    if coalesce(current_app_role(), '') <> 'coach' or p_tenant_id is distinct from current_tenant_id() then
      raise exception 'onboarding_coach_digest: coach of this tenant only';
    end if;
  end if;

  with f as (
    select * from client_onboarding_facts(p_tenant_id) x
     where x.client_status not in ('paused', 'archived') and x.stalled_days >= 3
  ),
  splan as (
    select distinct on (m.client_id) m.client_id,
           (m.target_calories is null or m.target_protein_g is null or m.target_fat_g is null or m.target_carb_g is null) as no_macros
      from client_meal_plans m where m.tenant_id = p_tenant_id and m.status = 'draft'
     order by m.client_id, m.created_at desc
  ),
  lplan as (
    select distinct on (l.client_id) l.client_id,
           (l.calories is null or l.protein_g is null or l.fat_g is null or l.carb_g is null) as no_macros
      from meal_plans l where l.tenant_id = p_tenant_id and l.assigned_at is null and coalesce(l.status, 'draft') = 'draft'
     order by l.client_id, l.created_at desc
  ),
  owed as (
    select f.client_id, f.display_name, f.stalled_days,
           case
             when f.next_action = 'review_draft' then 'drafts_to_review'
             when f.next_action = 'assemble_nutrition' then 'no_nutrition_plan'
             when f.next_action = 'release' and coalesce(s.no_macros, l.no_macros, false) then 'drafts_without_macros'
             when f.next_action = 'release' then 'ready_to_release'
             when f.next_action = 'send_invite' then 'invite_not_sent'
             when f.next_action in ('intake_expired_resend', 'invite_expired_resend') then 'expired_links'
             when f.next_action = 'send_intake' then 'intake_never_sent'
           end as bucket
      from f left join splan s on s.client_id = f.client_id left join lplan l on l.client_id = f.client_id
  ),
  o as (select * from owed where bucket is not null)
  select jsonb_build_object(
    'owed', (select count(*) from o),
    'buckets', coalesce((
      select jsonb_agg(jsonb_build_object('key', b.bucket, 'label', b.label, 'n', b.n) order by b.ord)
        from (
          select bucket, count(*)::int as n,
                 case bucket
                   when 'drafts_without_macros' then 'nutrition drafts without macros'
                   when 'no_nutrition_plan' then 'no nutrition plan'
                   when 'invite_not_sent' then 'invite not sent'
                   when 'ready_to_release' then 'ready to release'
                   when 'drafts_to_review' then 'program drafts to review'
                   when 'expired_links' then 'expired links to resend'
                   when 'intake_never_sent' then 'intake never sent'
                 end as label,
                 case bucket
                   when 'drafts_without_macros' then 1 when 'no_nutrition_plan' then 2 when 'invite_not_sent' then 3
                   when 'ready_to_release' then 4 when 'drafts_to_review' then 5 when 'expired_links' then 6 else 7
                 end as ord
            from o group by bucket) b), '[]'::jsonb),
    'longest', (select jsonb_build_object('display_name', x.display_name, 'days', x.stalled_days)
                  from o x order by x.stalled_days desc, x.display_name limit 1),
    'switch_on', coalesce((select (tc.onboarding_reminders ->> 'coach_digest')::boolean
                             from tenant_config tc where tc.tenant_id = p_tenant_id), false)
  ) into v_out;
  return v_out;
end $fn$;

revoke all on function public.onboarding_coach_digest(uuid) from public, anon;
grant execute on function public.onboarding_coach_digest(uuid) to authenticated, service_role;
comment on function public.onboarding_coach_digest(uuid) is
  'Slice 2: what the coach owes for 3+ days, bucketed for the daily digest line. Service role, or the coach of that tenant. Read-only.';

-- ---------- 5. what the coach sees about reminders ----------
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
      -- (as applied 2026-09-07 this read `v` and errored; corrected in 20260907101000 — kept
      -- correct here so a fresh database gets the working body)
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
comment on function public.onboarding_reminder_status() is
  'Slice 2: the signed-in coach''s reminder switches, sender, last-24h send/skip counts and the last cron run. Coach only. Read-only.';
