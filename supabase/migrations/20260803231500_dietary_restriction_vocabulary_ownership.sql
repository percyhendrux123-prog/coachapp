-- ============================================================================
-- client_dietary_restrictions: give the vocabulary an owner.
-- ============================================================================
--
-- WHY
--
-- restriction_key has never had a canonical source. The automated parser can
-- only ever write a key that already exists in allergen_dictionary or
-- dietary_pattern_dictionary (it INSERTs by joining against them), so it is
-- safe by construction. But two hand-written paths bypassed that entirely and
-- free-typed keys straight onto Cheryl Moye's record:
--
--   'peanuts', 'brussels_sprouts', 'squash', 'strawberries', 'watermelon',
--   'cantaloupe'   (source='intake_form', an older/manual ingestion path)
--   'dairy'        (source='coach', a direct hand entry)
--
-- Two different failure shapes, both real:
--
--   1. Plain duplication. 'peanuts' and 'strawberries' are alternate spellings
--      of restriction keys that ALREADY exist correctly on her record in
--      canonical form ('peanut', 'strawberry' -- both source='intake', the
--      real parser). Same food, two live rows. The 20260731173000 migration
--      crosswalked both spellings to the same meal tag so filtering still
--      worked, but the underlying duplication was never resolved.
--
--   2. A synonym mistaken for a key. 'dairy' is not a canonical key anywhere
--      -- it is a TERM that already resolves to k='milk' in allergen_dictionary
--      (see the milk row: term IN ('dairy','lactose','casein','whey','milk',
--      'cheese')). Whoever hand-entered this typed the word a person would say,
--      not the system's internal key, and nothing caught the mismatch.
--
-- THE FIX
--
--   1. Backfill dictionary entries (with synonym terms) for the five foods
--      that generated their own new keys on 2026-07-31 without ever getting
--      dictionary backing: brussels_sprouts, cantaloupe, squash, strawberry,
--      watermelon. 'peanut' already exists; it just gains 'peanuts' as a term
--      so a future free-text mention in that plural form still parses.
--
--   2. Correct the two failure shapes on Cheryl's existing record, additively:
--      - 'dairy' -> remapped in place to the canonical key 'milk'. No row is
--        deleted; the same row now carries the key the rest of the system
--        already recognizes.
--      - 'peanuts' and 'strawberries' -> deactivated (active=false), each
--        already duplicated by a canonical, active row on the same client
--        ('peanut', 'strawberry'). History is preserved; nothing is deleted.
--
--   3. canonical_food_keys: a view exposing the one legitimate key set --
--      allergen_dictionary.k UNION dietary_pattern_dictionary.k UNION
--      {'unparsed'} -- so any future tooling (a coach-facing picker, a report)
--      has one place to read "what keys actually mean something" rather than
--      re-deriving the union ad hoc.
--
--   4. A trigger, not a foreign key (canonical_food_keys is a view spanning
--      two source tables; Postgres FKs can't target a view). Functionally the
--      same guarantee: BEFORE INSERT OR UPDATE OF restriction_key, the new
--      value must already be in canonical_food_keys or the write is refused
--      with the offending key named. A typo becomes a loud error at write
--      time instead of a silent new vocabulary term nobody chose.
--
-- Blast radius verified before writing this: exactly one client (Cheryl) has
-- any restriction_key outside the dictionary today. No other active row is
-- touched. The automated parser path is unaffected -- it was already
-- dictionary-bound and will never trip the new trigger.
-- ============================================================================

-- ─── 1. Dictionary backfill ─────────────────────────────────────────────────
insert into public.allergen_dictionary (k, label, term, priority) values
  ('brussels_sprouts', 'Brussels sprouts', 'brussels sprouts',  100),
  ('brussels_sprouts', 'Brussels sprouts', 'brussel sprouts',   100),
  ('cantaloupe',       'Cantaloupe',       'cantaloupe',        100),
  ('cantaloupe',       'Cantaloupe',       'cantelope',         100),
  ('cantaloupe',       'Cantaloupe',       'muskmelon',         100),
  ('squash',           'Squash',           'squash',            100),
  ('squash',           'Squash',           'courgette',         100),
  ('squash',           'Squash',           'zucchini',          100),
  ('strawberry',       'Strawberry',       'strawberry',        100),
  ('strawberry',       'Strawberry',       'strawberries',      100),
  ('watermelon',       'Watermelon',       'watermelon',        100),
  ('peanut',           'Peanut',           'peanuts',           100)
on conflict (k, term) do nothing;

-- (A one-off data correction for a single existing record was removed from the public copy.)

-- ─── 3. The one legitimate key set, exposed for anything that wants it ─────
create or replace view public.canonical_food_keys as
  select k from public.allergen_dictionary
  union
  select k from public.dietary_pattern_dictionary
  union
  select 'unparsed';

comment on view public.canonical_food_keys is
  'The only restriction_key / allergen_key values with real meaning in this '
  'system -- the union of both dictionaries plus the literal escape hatch '
  '''unparsed''. Enforced on client_dietary_restrictions by '
  'trg_dietary_restriction_key_is_canonical.';

-- ─── 4. Enforcement: a typo becomes a loud error, not a new vocabulary ─────
create or replace function public.dietary_restriction_key_is_canonical()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.canonical_food_keys c where c.k = new.restriction_key) then
    raise exception
      'restriction_key % is not in canonical_food_keys (allergen_dictionary + '
      'dietary_pattern_dictionary + ''unparsed''). Add it to the dictionary first '
      '-- a typo or a synonym is not a new key.', new.restriction_key
      using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_dietary_restriction_key_is_canonical on public.client_dietary_restrictions;
create trigger trg_dietary_restriction_key_is_canonical
  before insert or update of restriction_key on public.client_dietary_restrictions
  for each row execute function public.dietary_restriction_key_is_canonical();
