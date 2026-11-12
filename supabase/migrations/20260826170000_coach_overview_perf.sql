-- ---------------------------------------------------------------------------
-- Coach Home performance fix, safe tier only (2026-08-26).
--
-- Found while testing the "Refresh signals" button: rm_coach_overview() runs
-- ~2.4s on average and up to ~8s over 282 real calls (pg_stat_statements),
-- occasionally hitting the statement timeout outright. Measured live as the
-- real owner-tenant coach account (not superuser): 1.66s. As superuser/service role
-- (which bypasses RLS), the same call runs in single-digit milliseconds —
-- proving the cost is RLS-path work, not data volume (37 clients, low
-- hundreds of rows per table).
--
-- Two changes here, both additive/subtractive only — same JSON output,
-- verified byte-for-byte against a live call before and after:
--
-- 1. rm__cfg_text(tenant_id, 'surface_mode' | 'type_key') ran a live
--    information_schema.columns existence check on every single call, for
--    two columns that have existed for weeks (confirmed: no other function
--    calls rm__cfg_text). Replaced with a direct column read.
--
-- 2. rm_attention_candidates() — the full 9-signal severity/recency/scoring
--    pipeline — was called twice per page load: once to build the ranked
--    queue, once again from scratch to compute the suppressed-signal counts.
--    Confirmed by counting call sites in the live function body. Now
--    computed once into a CTE (cand_raw) and reused by both blocks.
--
-- The bigger, higher-payoff cause (every table carries two separate RLS
-- policies — a client-ownership check and a coach-tenant check — so a coach
-- read still pays for an expensive, always-false client lookup on every row;
-- confirmed against pg_policies and independently flagged 900+ times by
-- Supabase's own performance advisor across this schema) is NOT touched
-- here. That fix rewrites RLS policies across most of the database and
-- needs its own written plan and the platform owner's explicit approval before any code
-- is touched — this migration is deliberately the safe, no-security-surface
-- half only.
-- ---------------------------------------------------------------------------

create index if not exists workout_sessions_tenant_session_date_idx
  on public.workout_sessions (tenant_id, session_date);

create index if not exists workout_sessions_tenant_completed_at_idx
  on public.workout_sessions (tenant_id, completed_at);

create index if not exists checkins_tenant_submitted_at_idx
  on public.checkins (tenant_id, submitted_at);

create index if not exists workout_logs_tenant_logged_at_idx
  on public.workout_logs (tenant_id, logged_at);

create index if not exists messages_tenant_sent_at_idx
  on public.messages (tenant_id, sent_at);

-- meal_plans already has a (tenant_id, client_id) unique index, but the
-- no_meal_plan decision's NOT EXISTS subquery filters by client_id alone —
-- tenant_id leading the composite index doesn't serve a client_id-only
-- lookup. A dedicated index on the trailing column does.
create index if not exists meal_plans_client_id_idx
  on public.meal_plans (client_id);

create or replace function public.rm_coach_overview()
returns jsonb
language plpgsql stable security invoker
set search_path = public as $fn$
declare
  v_tenant  uuid := current_tenant_id();
  v_sources jsonb;
  v_conf    jsonb;
  v_out     jsonb;
begin
  if v_tenant is null then
    raise exception 'rm_coach_overview: no tenant in session';
  end if;

  -- Sources first. Nothing below is readable without them.
  select jsonb_agg(to_jsonb(s) order by
           case s.key when 'training' then 1 when 'checkins' then 2
                      when 'messages' then 3 else 4 end)
    into v_sources
  from rm_source_health() s;

  select jsonb_object_agg(s->>'key', (s->>'confidence')::numeric)
    into v_conf
  from jsonb_array_elements(v_sources) s;

  with cand_raw as (
    -- Computed once. Previously called a second time, from scratch, by the
    -- suppressed-signal count below — the whole severity/recency/scoring
    -- pipeline ran twice per page load for one page.
    select * from rm_attention_candidates()
  ),
  cand as (
    select c.*, coalesce((v_conf->>c.source_key)::numeric, 0) as conf
    from cand_raw c
  ),
  scored as (
    select cand.*, round(severity * recency * conf, 4) as score from cand
  ),
  banded as (
    select scored.*,
      case
        -- 'decide' is not a score band. It is any item whose resolution is a
        -- coach decision with a deadline, and it always renders.
        when is_decision then 'decide'
        when score >= 0.7 then 'act'
        when score >= 0.4 then 'watch'
        else 'hold'
      end as band
    from scored
    -- RULE 1: a signal from a source that is not live or stale cannot produce
    -- an attention item. conf = 0 for unavailable / not_configured.
    where conf > 0
  ),
  -- ---------------- grouping ----------------
  -- The mockup collapses a repeated signal into one card ("6 clients — Active
  -- assignment, no meal plan") rather than printing six. Without this the queue
  -- is 33 rows deep on the current data and stops being a ranking at all.
  -- Threshold 3: up to three named clients read as individuals; four or more is
  -- a pattern, and for a pattern the coach wants a list, not a queue.
  sized as (
    select b.*, count(*) over (partition by b.signal_type) as sig_n from banded b
  ),
  singles as (
    select client_id, display_name, band, score, signal_type, source_key,
           mechanism, evidence, actions, since, deadline, 1 as member_count
    from sized where sig_n <= 3
  ),
  grouped as (
    select
      null::uuid as client_id,
      rm__n(count(*), 'client') as display_name,
      -- A group is at least as urgent as its most urgent member.
      (array_agg(band order by score desc))[1] as band,
      max(score) as score,
      signal_type, source_key,
      -- Plural copy per signal, in SQL, so the connector reads the same sentence
      -- The coach reads.
      case signal_type
        when 'training_silent' then
          'No logged session in over three days against an active assignment.'
        when 'account_unreachable' then
          'Client records with no account attached and no invite issued. They cannot open the app.'
        when 'no_meal_plan' then
          'Active assignment with no meal plan attached. The nutrition surface is blank on their side.'
        when 'unread_message' then 'Messages waiting over 24 hours, unanswered.'
        when 'overreach' then
          'More sessions logged in seven days than the program prescribes.'
        when 'paused_no_resume' then
          'Paused with no resume date recorded, so nothing will surface them again on its own.'
        when 'load_regression' then
          'Top-set load falling across three sessions running while volume holds.'
        when 'first_week_strong' then
          'First full week complete, every prescribed session logged.'
        else 'Multiple clients on the same signal.'
      end as mechanism,
      jsonb_build_array(
        jsonb_build_object('label', 'clients', 'value', count(*)::text),
        jsonb_build_object('label', 'longest waiting',
          'value', (array_agg(display_name order by score desc, display_name))[1]
                   || case when count(*) > 1 then ' +' || (count(*) - 1) else '' end)
      ) as evidence,
      jsonb_build_array(
        jsonb_build_object('key','review_list','label','Review list','primary',true)
      ) as actions,
      min(since) as since,
      min(deadline) as deadline,
      count(*)::int as member_count
    from sized where sig_n > 3
    group by signal_type, source_key
  ),
  queue as (
    select * from singles
    union all
    select * from grouped
  )
  select jsonb_build_object(
    'schema_version', 1,
    'generated_at',   now(),

    -- ---------------- tenant brand ----------------
    'tenant', (
      select jsonb_build_object(
        'tenant_id',          t.id,
        'slug',               t.slug,
        'app_name',           coalesce(tc.app_name, 'Coach App'),
        'coach_display_name', tc.coach_display_name,
        'logo_url',           tc.logo_url,
        'brand_color',        tc.brand_color,
        'theme_key',          tc.theme_key,
        -- Direct column reads. Previously routed through rm__cfg_text(), which
        -- ran a live information_schema.columns existence check on every call
        -- for two columns that have existed since the schema-gap migration —
        -- see 2026-08-26 perf fix note at the top of this migration.
        'surface_mode',       coalesce(tc.surface_mode, 'dark'),
        'type_key',           coalesce(tc.type_key, 'grotesk'),
        'weight_unit',        tc.weight_unit,
        'features', jsonb_build_object(
          'messaging',       tc.messaging_on,
          'progress_photos', tc.progress_photos_on,
          'progress_weight', tc.progress_weight_on,
          'approval_gate',   tc.program_approval_gate
        ))
      from tenant_config tc join tenants t on t.id = tc.tenant_id
      where tc.tenant_id = v_tenant
    ),

    'sources', v_sources,

    -- ---------------- roster pulse ----------------
    -- A metric whose backing source is unhealthy is returned as JSON null, NOT
    -- 0. The UI renders null as a hatched em-dash. A false zero here is the
    -- specific failure this page exists to prevent: 0 reads as "nobody trained"
    -- and would have a coach message a client who did train.
    'roster', (
      select jsonb_build_object(
        'total',   count(*),
        'active',  count(*) filter (where status = 'active'),
        'paused',  count(*) filter (where status = 'paused'),
        'invited', count(*) filter (where status = 'invited'),
        'trained_7d', case when (v_conf->>'training')::numeric > 0 then (
            select count(distinct ws.client_id) from workout_sessions ws
            where ws.tenant_id = v_tenant
              and ws.session_date > (now() - interval '7 days')::date) end,
        'silent_7d', case when (v_conf->>'training')::numeric > 0 then (
            select count(*) from assignments a
            join clients cc on cc.id = a.client_id and cc.status = 'active'
            where a.tenant_id = v_tenant and a.active
              and not exists (select 1 from workout_sessions ws
                where ws.client_id = a.client_id
                  and ws.session_date > (now() - interval '7 days')::date)) end,
        'checked_in_7d', case when (v_conf->>'checkins')::numeric > 0 then (
            select count(distinct ck.client_id) from checkins ck
            where ck.tenant_id = v_tenant
              and ck.submitted_at > now() - interval '7 days') end
      )
      from clients where tenant_id = v_tenant
    ),

    -- ---------------- ranked attention ----------------
    'attention', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', client_id, 'display_name', display_name,
        'band', band, 'score', score,
        'signal_type', signal_type, 'source_key', source_key,
        'mechanism', mechanism, 'evidence', evidence, 'actions', actions,
        'since', since, 'deadline', deadline,
        -- >1 means this card stands for a group, not one person. The UI uses it
        -- to label the action button and to avoid implying a single client.
        'member_count', member_count)
      order by case band when 'act' then 1 when 'decide' then 2
                         when 'watch' then 3 else 4 end,
               score desc, display_name)
      from queue), '[]'::jsonb),

    -- ---------------- suppression ----------------
    -- RULE 2: an unhealthy source yields a count, never a flag. RULE 3: the UI
    -- renders this hatched, and never as an empty queue.
    'suppressed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source_key', x.source_key, 'withheld_count', x.n,
        'reason', x.reason, 'since', x.since) order by x.n desc)
      from (
        select c.source_key, count(*)::int as n,
          (select s->>'note' from jsonb_array_elements(v_sources) s
            where s->>'key' = c.source_key) as reason,
          (select (s->>'last_event_at')::timestamptz from jsonb_array_elements(v_sources) s
            where s->>'key' = c.source_key) as since
        from cand_raw c
        where coalesce((v_conf->>c.source_key)::numeric, 0) = 0
        group by c.source_key
      ) x), '[]'::jsonb),

    -- ---------------- decisions ----------------
    -- Roster-derived, so this card never empties just because a feed died.
    'decisions', coalesce((
      select jsonb_agg(d order by d->>'ord')
      from (
        select jsonb_build_object('ord','1','kind','draft_approval',
          'title','Program drafts awaiting approval',
          'detail', case when (select program_approval_gate from tenant_config
                               where tenant_id = v_tenant)
                    then 'Approval gate is on. Nothing reaches a client until you release it.'
                    else 'Approval gate is off — drafts publish without review.' end,
          'count', (select count(*) from program_drafts
                     where tenant_id = v_tenant and status = 'draft')) as d
        union all
        select jsonb_build_object('ord','2','kind','no_meal_plan',
          'title','Active clients without a meal plan',
          'detail','Assignment live, nutrition surface blank on their side.',
          'count', (select count(*) from assignments a
                     join clients c on c.id = a.client_id and c.status = 'active'
                     where a.tenant_id = v_tenant and a.active
                       and not exists (select 1 from meal_plans mp
                         where mp.client_id = c.id)))
        union all
        -- Drafted but never released. One click each, and the client currently
        -- sees a blank nutrition surface despite the work already being done.
        select jsonb_build_object('ord','3','kind','meal_plan_unreleased',
          'title','Meal plans drafted, never released',
          'detail','The work is done. Until it is assigned, the client cannot see it.',
          'count', (select count(*) from meal_plans
                     where tenant_id = v_tenant and assigned_at is null))
        union all
        select jsonb_build_object('ord','4','kind','account_unreachable',
          'title','Clients with no account attached',
          'detail','Record created, no invite issued. They cannot open the app.',
          'count', (select count(*) from clients where tenant_id = v_tenant
                     and client_user_id is null and status <> 'paused'),
          'deadline', (select min(invite_expires_at) from clients where tenant_id = v_tenant
                     and client_user_id is null))
        union all
        select jsonb_build_object('ord','5','kind','paused_no_resume',
          'title','Paused without a resume date',
          'detail','Will not resurface on its own until a resume date is set.',
          'count', (select count(*) from clients
                     where tenant_id = v_tenant and status = 'paused'
                       and pause_resume_date is null))
      ) dec_rows
      where (d->>'count')::int > 0), '[]'::jsonb),

    -- ---------------- prep timelines ----------------
    -- clients.show_date now exists (20260729120100). Undated clients are EXCLUDED
    -- from this rail, never ranked lower on it. With every show_date still null
    -- this returns [] with unavailable=false, so the UI shows the SOLID "no dates
    -- set" empty state -- we know, and there are none -- not the hatched
    -- "cannot see" state. That distinction is the whole point of the page.
    'timelines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', c.id, 'display_name', c.display_name,
        'event_date', c.show_date,
        'weeks_out', ceil((c.show_date - now()::date) / 7.0),
        'phase', case
          when c.show_date - now()::date <= 7  then 'peak week'
          when c.show_date - now()::date <= 28 then 'final month'
          else 'build' end,
        'note', coalesce(c.show_name, 'no show name set'))
      order by c.show_date)
      from clients c
      where c.tenant_id = v_tenant and c.status = 'active'
        and c.show_date is not null and c.show_date >= now()::date
    ), '[]'::jsonb),
    'timelines_unavailable', false,
    'timelines_note', null,

    -- Signals the read model knows about but cannot compute on this schema.
    -- Reported so the page can be honest instead of silently omitting them.
    -- program_ending is now computable: assignments.ends_on exists and the
    -- signal is live in rm_attention_candidates. Nothing is currently
    -- uncomputable, so this list is empty and the UI hides the block.
    'unavailable_signals', '[]'::jsonb,

    -- ---------------- activity ----------------
    -- Chronological, deliberately last, capped at 8.
    'activity', coalesce((
      select jsonb_agg(e order by (e->>'at') desc)
      from (
        select jsonb_build_object('at', ws.completed_at, 'client_id', ws.client_id,
          'display_name', c.display_name, 'kind','session_complete',
          'summary','completed a session'
            || coalesce((select ' — ' || count(*) || ' sets' from workout_logs wl
                 where wl.session_id = ws.id and wl.done
                 having count(*) > 0), '')) as e
        from workout_sessions ws join clients c on c.id = ws.client_id
        where ws.tenant_id = v_tenant and ws.completed_at > now() - interval '24 hours'
        union all
        select jsonb_build_object('at', wl.logged_at, 'client_id', wl.client_id,
          'display_name', c.display_name, 'kind','set_logged',
          'summary','logged a set'
            || coalesce(' — ' || wl.weight || ' x ' || wl.reps, ''))
        from workout_logs wl join clients c on c.id = wl.client_id
        where wl.tenant_id = v_tenant and wl.logged_at > now() - interval '24 hours'
        union all
        select jsonb_build_object('at', m.sent_at, 'client_id', m.client_id,
          'display_name', c.display_name, 'kind','message', 'summary','messaged you')
        from messages m join clients c on c.id = m.client_id
        where m.tenant_id = v_tenant and m.sender_role = 'client'
          and m.sent_at > now() - interval '24 hours'
        union all
        select jsonb_build_object('at', ck.submitted_at, 'client_id', ck.client_id,
          'display_name', c.display_name, 'kind','checkin','summary','submitted a check-in')
        from checkins ck join clients c on c.id = ck.client_id
        where ck.tenant_id = v_tenant and ck.submitted_at > now() - interval '24 hours'
        order by 1 desc
        limit 8
      ) ev), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$fn$;
