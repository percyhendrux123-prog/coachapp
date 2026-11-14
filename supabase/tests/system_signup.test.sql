-- P33: the free self-serve signup. system_signup_gate() limits and provision_system_signup().
-- Run against a database with every migration applied. ONE transaction, ends with ROLLBACK.
-- A clean run prints 'ok 1' .. 'ok 9'; any 'TEST FAILED' raise stops the script.
begin;

-- The gate's counters are global: start this transaction from an empty table.
delete from public.system_signup_attempts;

-- The self-serve tenant the provisioner looks up by slug (created here if this database has none).
insert into public.tenants (slug) select 'self-serve' where not exists (select 1 from public.tenants where slug = 'self-serve');
insert into public.tenant_config (tenant_id, mode) select id, 'self_serve' from public.tenants where slug = 'self-serve'
  on conflict (tenant_id) do update set mode = 'self_serve';

create temp table h (k text primary key, v text) on commit drop;
insert into h values ('e1', repeat('a', 64)), ('e2', repeat('b', 64)), ('e3', repeat('c', 64)), ('ip1', repeat('1', 64)), ('ip2', repeat('2', 64));

-- 1. first try is ok; the same address again inside 24 h is email_recent (nothing to send).
do $$ declare g jsonb; begin
  g := public.system_signup_gate((select v from h where k='e1'), (select v from h where k='ip1'), 50);
  if g->>'decision' <> 'ok' or g->>'attempt_id' is null then raise exception 'TEST FAILED 1: %', g; end if;
  update public.system_signup_attempts set decision = 'sent' where id = (g->>'attempt_id')::uuid;
  g := public.system_signup_gate((select v from h where k='e1'), (select v from h where k='ip2'), 50);
  if g->>'decision' <> 'email_recent' then raise exception 'TEST FAILED 1: %', g; end if;
  raise notice 'ok 1 - one email per address per 24 h';
end $$;

-- 2. a failed send does not lock the address out.
do $$ declare g jsonb; begin
  g := public.system_signup_gate((select v from h where k='e2'), (select v from h where k='ip2'), 50);
  update public.system_signup_attempts set decision = 'send_failed' where id = (g->>'attempt_id')::uuid;
  g := public.system_signup_gate((select v from h where k='e2'), (select v from h where k='ip2'), 50);
  if g->>'decision' <> 'ok' then raise exception 'TEST FAILED 2: %', g; end if;
  raise notice 'ok 2 - send_failed does not count as sent';
end $$;

-- 3. 5 attempts an hour from one network address, then ip_limited.
do $$ declare g jsonb; i int; begin
  for i in 1..10 loop
    g := public.system_signup_gate(md5('p33-ip-' || i) || md5('x'), repeat('9', 64), 50);
    if i <= 5 and g->>'decision' = 'ip_limited' then raise exception 'TEST FAILED 3: limited at %', i; end if;
    if i > 5 and g->>'decision' <> 'ip_limited' then raise exception 'TEST FAILED 3: not limited at %: %', i, g; end if;
  end loop;
  raise notice 'ok 3 - per-IP limit is 5 an hour';
end $$;

-- 4. the daily cap pauses signups; cap 0 pauses everything.
do $$ declare g jsonb; n int; begin
  select count(*) into n from public.system_signup_attempts where decision in ('ok', 'sent') and created_at > now() - interval '24 hours';
  g := public.system_signup_gate((select v from h where k='e3'), repeat('8', 64), n);
  if g->>'decision' <> 'paused' then raise exception 'TEST FAILED 4: %', g; end if;
  g := public.system_signup_gate(repeat('d', 64), repeat('7', 64), 0);
  if g->>'decision' <> 'paused' then raise exception 'TEST FAILED 4b: %', g; end if;
  g := public.system_signup_gate(repeat('d', 64), repeat('7', 64), n + 1);
  if g->>'decision' <> 'ok' then raise exception 'TEST FAILED 4c: %', g; end if;
  raise notice 'ok 4 - the daily cap pauses signups';
end $$;

-- 5. the gate refuses missing hashes.
do $$ begin
  begin perform public.system_signup_gate('short', repeat('1', 64), 50); raise exception 'TEST FAILED 5';
  exception when others then if sqlerrm like 'TEST FAILED%' then raise; end if; end;
  raise notice 'ok 5 - hashes required';
end $$;

-- 6. provision: a new address gets one client (origin system) and a 14-day token; again → same client, same token.
do $$ declare a jsonb; b jsonb; n int; begin
  a := public.provision_system_signup('  P33.Signup@Example.invalid ');
  b := public.provision_system_signup('p33.signup@example.invalid');
  if a->>'kind' <> 'intake' or not (a->>'new_client')::boolean or (b->>'new_client')::boolean
     or a->>'client_id' <> b->>'client_id' or a->>'intake_token' <> b->>'intake_token' then
    raise exception 'TEST FAILED 6: % / %', a, b; end if;
  select count(*) into n from public.clients where lower(email) = 'p33.signup@example.invalid';
  if n <> 1 then raise exception 'TEST FAILED 6: % clients', n; end if;
  if (select origin from public.clients where id = (a->>'client_id')::uuid) <> 'system' then raise exception 'TEST FAILED 6: origin'; end if;
  if (select expires_at from public.intake_forms where token = a->>'intake_token') < now() + interval '13 days' then raise exception 'TEST FAILED 6: expiry'; end if;
  raise notice 'ok 6 - one client per address, the pending token is reused';
end $$;

-- 7. someone who already submitted an intake gets no new token from the public form.
do $$ declare a jsonb; begin
  update public.intake_forms set status = 'submitted', submitted_at = now()
   where client_id = (select id from public.clients where lower(email) = 'p33.signup@example.invalid');
  a := public.provision_system_signup('p33.signup@example.invalid');
  if a->>'kind' <> 'existing' or a ? 'intake_token' then raise exception 'TEST FAILED 7: %', a; end if;
  raise notice 'ok 7 - an existing plan gets a sign-in email, not a new intake token';
end $$;

-- 8. bad addresses are refused.
do $$ begin
  begin perform public.provision_system_signup('not-an-email'); raise exception 'TEST FAILED 8';
  exception when others then if sqlerrm like 'TEST FAILED%' then raise; end if; end;
  raise notice 'ok 8 - provision refuses a non-address';
end $$;

-- 9. grants: server-only, closed to anon and authenticated.
do $$ begin
  if has_function_privilege('anon', 'public.system_signup_gate(text, text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.system_signup_gate(text, text, integer)', 'execute')
     or has_function_privilege('anon', 'public.provision_system_signup(text)', 'execute')
     or has_function_privilege('authenticated', 'public.provision_system_signup(text)', 'execute')
     or not has_function_privilege('service_role', 'public.provision_system_signup(text)', 'execute')
     or has_table_privilege('anon', 'public.system_signup_sources', 'select')
     or has_table_privilege('authenticated', 'public.system_signup_attempts', 'select') then
    raise exception 'TEST FAILED 9: grants';
  end if;
  raise notice 'ok 9 - signup functions and tables are server-only';
end $$;

rollback;
