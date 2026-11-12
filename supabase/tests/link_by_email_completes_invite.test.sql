-- link_client_by_email() (run by the auth trigger when an invited client confirms their
-- email with their first code) must leave the row exactly as claim_client_invite() would:
-- attached and 'invited' -> 'active'. Paused rows keep their status. The claim page that
-- runs next must then answer 'already_yours' to the client and 'already_claimed' to anyone else.
-- One transaction, ends with ROLLBACK. A clean run prints one NOTICE per passed test.
begin;

create temp table fx (k text primary key, v uuid) on commit drop;
insert into fx values ('tenant', gen_random_uuid()), ('c1', gen_random_uuid()), ('c2', gen_random_uuid()),
                      ('u1', gen_random_uuid()), ('u2', gen_random_uuid());
insert into public.tenants (id, slug) values ((select v from fx where k='tenant'), 'link-test');
insert into auth.users (id, email) values
  ((select v from fx where k='u1'), 'link-one@example.invalid'),
  ((select v from fx where k='u2'), 'link-two@example.invalid');
insert into public.clients (id, tenant_id, display_name, email, status, invite_token, invite_expires_at) values
  ((select v from fx where k='c1'), (select v from fx where k='tenant'), 'Link One', 'Link-One@example.invalid', 'invited', repeat('a', 64), now() + interval '1 day'),
  ((select v from fx where k='c2'), (select v from fx where k='tenant'), 'Link Two', 'link-two@example.invalid', 'paused',  repeat('b', 64), now() + interval '1 day');

do $$
declare c public.clients; n int; r text;
begin
  n := public.link_client_by_email((select v from fx where k='u1'), 'link-one@example.invalid');
  select * into c from public.clients where id = (select v from fx where k='c1');
  if n <> 1 or c.client_user_id is distinct from (select v from fx where k='u1') then
    raise exception 'TEST FAILED: row not attached (n=%)', n; end if;
  raise notice 'ok 1 - confirmed email attaches the invited row';
  if c.status <> 'active' then raise exception 'TEST FAILED: status % (want active)', c.status; end if;
  raise notice 'ok 2 - invited becomes active';
  if c.invite_token is null then
    raise exception 'TEST FAILED: token cleared, so the claim page would say invalid'; end if;
  raise notice 'ok 3 - invite token kept for the claim page';
  if not exists (select 1 from public.profiles where user_id = (select v from fx where k='u1') and role = 'client') then
    raise exception 'TEST FAILED: no client profile'; end if;
  raise notice 'ok 4 - client profile minted';

  n := public.link_client_by_email((select v from fx where k='u2'), 'link-two@example.invalid');
  select * into c from public.clients where id = (select v from fx where k='c2');
  if c.status <> 'paused' then raise exception 'TEST FAILED: paused row changed to %', c.status; end if;
  raise notice 'ok 5 - paused status left alone';

  -- the claim page then calls claim_client_invite with the same token
  update auth.users set email_confirmed_at = now()
   where id in ((select v from fx where k='u1'), (select v from fx where k='u2'));
  perform set_config('request.jwt.claims', json_build_object('sub', (select v from fx where k='u1'))::text, true);
  r := public.claim_client_invite(repeat('a', 64));
  if r <> 'already_yours' then raise exception 'TEST FAILED: client claim answered %', r; end if;
  raise notice 'ok 6 - the invited client lands on "all set"';
  perform set_config('request.jwt.claims', json_build_object('sub', (select v from fx where k='u2'))::text, true);
  r := public.claim_client_invite(repeat('a', 64));
  if r <> 'already_claimed' then raise exception 'TEST FAILED: another account answered %', r; end if;
  raise notice 'ok 7 - a forwarded link cannot attach anyone else';
end $$;

rollback;
