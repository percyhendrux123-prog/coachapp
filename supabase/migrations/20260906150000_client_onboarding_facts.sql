-- Slice 1 of the original design notes (not included) — the status view.
--
-- client_onboarding_facts(): one row per non-archived client, every onboarding fact derived
-- from tables that already exist, and ONE next_action per client by fixed precedence. Nothing
-- here writes. Twin-facts rules are enforced in the OUTPUT, not the UI:
--   * 'none' (never sent) and 'pending' (sent, not done) are different values;
--   * paid_via_platform is true or NULL (not tracked) — never false, because paying outside
--     this platform (every client before 2026-09-06, every external payment link) is unknowable;
--   * a client with a LIVE program is never told to redo an intake: an old expired form is not
--     the thing blocking someone who is already training (deviation from the plan's first
--     draft of the precedence, recorded 2026-09-06).
-- Security invoker: a coach session reads through RLS; the MCP service role passes the tenant.

create or replace function public.client_onboarding_facts(p_tenant_id uuid default null)
returns table (
  client_id uuid,
  display_name text,
  client_status text,
  paid_via_platform boolean,
  intake_state text,
  intake_sent_at timestamptz,
  intake_expires_at timestamptz,
  intake_submitted_at timestamptz,
  draft_state text,
  program_live boolean,
  nutrition_state text,
  invite_state text,
  invite_expires_at timestamptz,
  opened_app boolean,
  first_set_logged boolean,
  first_checkin boolean,
  stalled_since timestamptz,
  stalled_days integer,
  next_action text
)
language plpgsql stable security invoker
set search_path = public as $fn$
declare
  v_tenant uuid := coalesce(p_tenant_id, current_tenant_id());
begin
  if v_tenant is null then
    raise exception 'client_onboarding_facts: no tenant in session';
  end if;
  -- A signed-in user (coach JWT) may only read their own tenant. The service role and a
  -- direct database session (SQL editor, migrations) may pass any tenant.
  if auth.uid() is not null and auth.role() is distinct from 'service_role'
     and v_tenant is distinct from current_tenant_id() then
    raise exception 'client_onboarding_facts: tenant mismatch';
  end if;

  return query
  with c as (
    select cl.* from clients cl where cl.tenant_id = v_tenant and cl.status <> 'archived'
  ),
  intake as (
    select distinct on (i.client_id) i.client_id, i.status, i.created_at, i.expires_at, i.submitted_at
    from intake_forms i where i.tenant_id = v_tenant order by i.client_id, i.created_at desc
  ),
  draft as (
    select distinct on (d.client_id) d.client_id, d.status, d.generated_at, d.decided_at
    from program_drafts d where d.tenant_id = v_tenant order by d.client_id, d.generated_at desc
  ),
  asg as (
    select a.client_id, bool_or(a.active) as live, max(a.assigned_at) as assigned_at
    from assignments a where a.tenant_id = v_tenant group by a.client_id
  ),
  -- Nutrition lives in TWO tables: client_meal_plans (structured, current) and meal_plans
  -- (the older uploaded/legacy plans, still assigned for some clients — 5 of 35 on
  -- 2026-09-06 had a plan ONLY there). A client is "assigned" if either table says so.
  mp_all as (
    select m.client_id, m.status, m.assigned_at, m.updated_at
    from client_meal_plans m where m.tenant_id = v_tenant
    union all
    select l.client_id,
           case when l.assigned_at is not null or l.status = 'assigned' then 'assigned' else 'draft' end,
           l.assigned_at, l.updated_at
    from meal_plans l where l.tenant_id = v_tenant
  ),
  mp as (
    select x.client_id,
           bool_or(x.status = 'assigned') as assigned,
           bool_or(x.status = 'draft') as drafted,
           max(x.assigned_at) as assigned_at,
           max(x.updated_at) as updated_at
    from mp_all x group by x.client_id
  ),
  -- A logged set lives in workout_logs (done = true). history_workout_sets is the Trainerize
  -- import table and was empty for every client on 2026-09-06 — the plan named it, the data
  -- said otherwise. Both are read so an imported history still counts.
  sets as (
    select x.client_id, true as any_set from (
      select l.client_id from workout_logs l where l.tenant_id = v_tenant and l.done
      union all
      select h.client_id from history_workout_sets h where h.tenant_id = v_tenant
    ) x group by x.client_id
  ),
  sess as (
    select w.client_id, max(w.session_date) as last_session from workout_sessions w where w.tenant_id = v_tenant group by w.client_id
  ),
  ck as (
    select k.client_id, max(k.submitted_at) as last_checkin from checkins k where k.tenant_id = v_tenant group by k.client_id
  ),
  facts as (
    select
      c.id,
      c.display_name,
      c.status::text as client_status,
      case when c.stripe_checkout_session_id is not null then true else null end as paid_via_platform,
      case
        when i.client_id is null then 'none'
        when i.status = 'submitted' then 'submitted'
        when i.expires_at < now() then 'expired'
        else 'pending' end as intake_state,
      i.created_at as intake_sent_at,
      i.expires_at as intake_expires_at,
      i.submitted_at as intake_submitted_at,
      coalesce(d.status::text, 'none') as draft_state,
      coalesce(a.live, false) as program_live,
      case when m.assigned then 'assigned' when m.drafted then 'draft' else 'none' end as nutrition_state,
      case
        when c.client_user_id is not null then 'claimed'
        when c.invite_token is null then 'none'
        when c.invite_expires_at < now() then 'expired'
        else 'pending' end as invite_state,
      c.invite_expires_at,
      coalesce(c.welcome_seen, false) as opened_app,
      coalesce(s.any_set, false) as first_set_logged,
      (ck.last_checkin is not null) as first_checkin,
      greatest(c.joined_at, c.updated_at, i.created_at, i.submitted_at, d.generated_at, d.decided_at,
               a.assigned_at, m.assigned_at, m.updated_at, se.last_session::timestamptz, ck.last_checkin) as stalled_since
    from c
    left join intake i on i.client_id = c.id
    left join draft  d on d.client_id = c.id
    left join asg    a on a.client_id = c.id
    left join mp     m on m.client_id = c.id
    left join sets   s on s.client_id = c.id
    left join sess   se on se.client_id = c.id
    left join ck     on ck.client_id = c.id
  )
  select
    f.id, f.display_name, f.client_status, f.paid_via_platform,
    f.intake_state, f.intake_sent_at, f.intake_expires_at, f.intake_submitted_at,
    f.draft_state, f.program_live, f.nutrition_state,
    f.invite_state, f.invite_expires_at,
    f.opened_app, f.first_set_logged, f.first_checkin,
    f.stalled_since,
    greatest(0, floor(extract(epoch from (now() - coalesce(f.stalled_since, now()))) / 86400))::int as stalled_days,
    case
      when not f.program_live and f.intake_state = 'none'    then 'send_intake'
      when not f.program_live and f.intake_state = 'expired' then 'intake_expired_resend'
      when not f.program_live and f.intake_state = 'pending' then 'awaiting_client_intake'
      when not f.program_live and f.draft_state in ('draft', 'held_medical') then 'review_draft'
      when not f.program_live                                then 'unclassified'
      when f.nutrition_state = 'none'                        then 'assemble_nutrition'
      when f.nutrition_state = 'draft'                       then 'release'
      when f.invite_state = 'none'                           then 'send_invite'
      when f.invite_state = 'expired'                        then 'invite_expired_resend'
      when f.invite_state = 'pending'                        then 'awaiting_client_claim'
      when not f.opened_app                                  then 'awaiting_first_open'
      when not f.first_set_logged                            then 'awaiting_first_set'
      else 'onboarded' end as next_action
  from facts f
  order by f.display_name;
end $fn$;

revoke all on function public.client_onboarding_facts(uuid) from public, anon;
grant execute on function public.client_onboarding_facts(uuid) to authenticated, service_role;
comment on function public.client_onboarding_facts(uuid) is
  'Slice 1 status view: one row per non-archived client with every onboarding fact and one next_action by fixed precedence. Security invoker (RLS); service role may pass any tenant. Read-only.';

-- ---------- rm_coach_overview: decisions card reads the facts function ----------
-- Verbatim copy of 20260826170000's body with ONE change: the ord-4 account_unreachable row
-- is replaced by four onboarding rows (see the Slice 1 comment inline). Everything else is
-- byte-identical so the deploy diff shows exactly that.
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
        -- Slice 1 (2026-09-06): the single account_unreachable row became four rows fed by
        -- client_onboarding_facts(), one per place a client can be stuck. Each is a real
        -- count from the same function the Clients page and the connector read.
        select jsonb_build_object('ord','4a','kind','intakes_unanswered',
          'title','Intakes out, unanswered',
          'detail','Sent and not submitted, or expired before it was. Resend from the client profile.',
          'count', (select count(*) from client_onboarding_facts(v_tenant) f
                     where f.client_status <> 'paused'
                       and f.next_action in ('awaiting_client_intake','intake_expired_resend')),
          'deadline', (select min(f.intake_expires_at) from client_onboarding_facts(v_tenant) f
                     where f.client_status <> 'paused' and f.next_action = 'awaiting_client_intake'))
        union all
        select jsonb_build_object('ord','4b','kind','released_no_invite',
          'title','Released, invite not sent',
          'detail','Program and nutrition are live. They have no way into the app yet.',
          'count', (select count(*) from client_onboarding_facts(v_tenant) f
                     where f.client_status <> 'paused' and f.next_action = 'send_invite'))
        union all
        select jsonb_build_object('ord','4c','kind','invites_unclaimed',
          'title','Invites out, unclaimed',
          'detail','Invited and never signed in, or the invite expired first.',
          'count', (select count(*) from client_onboarding_facts(v_tenant) f
                     where f.client_status <> 'paused'
                       and f.next_action in ('awaiting_client_claim','invite_expired_resend')),
          'deadline', (select min(f.invite_expires_at) from client_onboarding_facts(v_tenant) f
                     where f.client_status <> 'paused' and f.next_action = 'awaiting_client_claim'))
        union all
        select jsonb_build_object('ord','4d','kind','never_trained',
          'title','In the app, never trained',
          'detail','Signed in, program live, not one set logged. A real zero, not a gap.',
          'count', (select count(*) from client_onboarding_facts(v_tenant) f
                     where f.client_status <> 'paused'
                       and f.next_action in ('awaiting_first_open','awaiting_first_set')))
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
