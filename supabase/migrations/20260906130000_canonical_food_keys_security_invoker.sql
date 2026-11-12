-- Supabase security advisor (2026-09-06, level ERROR): view public.canonical_food_keys runs as
-- SECURITY DEFINER (the Postgres default for views), so it reads its base tables with the
-- view owner's rights, not the caller's. Real exposure: none — the view is the union of two
-- public vocabulary tables (allergen_dictionary, dietary_pattern_dictionary: 44 keys, no
-- client or tenant data) that anon and authenticated can already SELECT directly. Flipping
-- to security_invoker keeps behaviour identical and silences the finding honestly.
alter view public.canonical_food_keys set (security_invoker = on);
