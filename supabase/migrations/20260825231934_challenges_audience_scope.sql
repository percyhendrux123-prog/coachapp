-- Challenges: who's allowed to enroll.
--
-- Until now, challenge-enroll let any signed-in person join any published
-- challenge, with zero distinction between an existing client and a stranger.
-- That's wrong for a lead-gen challenge like the 7-Day Standard Challenge,
-- whose reward is a free month of coaching -- an existing client claiming
-- that reward isn't the intended audience. It's equally wrong for a
-- client-exclusive bonus challenge to be open to the public.
--
-- 'open' is the default so every already-published challenge keeps its
-- current behavior (anyone can join) until a coach deliberately narrows it.
alter table public.challenges
  add column audience text not null default 'open';

alter table public.challenges
  add constraint challenges_audience_ck
  check (audience in ('open', 'clients_only', 'non_clients_only'));
