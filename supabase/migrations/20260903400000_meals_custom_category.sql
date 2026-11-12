-- A buyer's own meal (owner tool add_my_meal) is not a library food type. The platform owner, 2026-09-03:
-- custom meals are "seamless but included" — so they get their own category instead of
-- borrowing a library one, and the owner tool no longer has to ask the AI to pick.
-- Live CHECK before this: breakfast | chicken | beef | fish | eggs | carb_side | vegetable |
-- no_cook | freezer. This adds `custom`; nothing existing changes.
alter table public.meals drop constraint if exists meals_category_check;
alter table public.meals add constraint meals_category_check check (
  category = any (array['breakfast','chicken','beef','fish','eggs','carb_side','vegetable','no_cook','freezer','custom'])
);
