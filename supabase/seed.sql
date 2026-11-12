-- Reference vocabulary for intake parsing and meal-library filtering.
-- Generic data, no client or coach content. Safe to re-run (on conflict do nothing).
-- Applied automatically by `supabase db reset` (config: [db.seed]); on a hosted project run it once
-- with `psql "$DATABASE_URL" -f supabase/seed.sql` or paste it into the SQL editor.
--
-- Note on allergen_tag_crosswalk: a row there is a safety claim that your meal library has been
-- reviewed for that allergen. Read the table comment in the initial schema before adding meals.

-- Meal tag vocabulary (allergens, diets, attributes).
insert into public.meal_tags (key, label, kind, sort_order) values
  ('gluten',     'Gluten',      'allergen', 10),
  ('dairy',      'Dairy',       'allergen', 20),
  ('egg',        'Egg',         'allergen', 30),
  ('soy',        'Soy',         'allergen', 40),
  ('peanut',     'Peanut',      'allergen', 50),
  ('tree_nut',   'Tree nut',    'allergen', 60),
  ('fish',       'Fish',        'allergen', 70),
  ('shellfish',  'Shellfish',   'allergen', 80),
  ('sesame',     'Sesame',      'allergen', 90),
  ('mustard',    'Mustard',     'allergen', 100),
  ('celery',     'Celery',      'allergen', 110),
  ('sulphites',  'Sulphites',   'allergen', 120),
  ('lupin',      'Lupin',       'allergen', 130),
  ('molluscs',   'Molluscs',    'allergen', 140),
  ('gluten_free',    'Gluten free',    'diet', 10),
  ('dairy_free',     'Dairy free',     'diet', 20),
  ('nut_free',       'Nut free',       'diet', 30),
  ('egg_free',       'Egg free',       'diet', 40),
  ('soy_free',       'Soy free',       'diet', 50),
  ('shellfish_free', 'Shellfish free', 'diet', 60),
  ('vegetarian',     'Vegetarian',     'diet', 70),
  ('vegan',          'Vegan',          'diet', 80),
  ('pescatarian',    'Pescatarian',    'diet', 90),
  ('low_fodmap',     'Low FODMAP',     'diet', 100)
on conflict (kind, key) do nothing;

-- Additional food-preference tags.
insert into public.meal_tags (key, label, kind, sort_order) values
  ('brussels_sprouts', 'Contains Brussels sprouts', 'attribute', 300),
  ('cantaloupe',       'Contains cantaloupe',       'attribute', 301),
  ('squash',           'Contains squash',           'attribute', 302),
  ('strawberry',       'Contains strawberry',       'attribute', 303),
  ('watermelon',       'Contains watermelon',       'attribute', 304)
on conflict (key) do nothing;

-- Allergen dictionary used by the intake parser (term -> allergen key).
insert into public.allergen_dictionary (k, label, term, priority) values
 ('shellfish','Shellfish','shellfish',1),('shellfish','Shellfish','shell fish',1),('shellfish','Shellfish','shrimp',1),
 ('shellfish','Shellfish','prawn',1),('shellfish','Shellfish','crab',1),('shellfish','Shellfish','lobster',1),
 ('shellfish','Shellfish','crawfish',1),('shellfish','Shellfish','crayfish',1),
 ('mollusc','Molluscs','mollusc',2),('mollusc','Molluscs','mollusk',2),('mollusc','Molluscs','oyster',2),
 ('mollusc','Molluscs','clam',2),('mollusc','Molluscs','mussel',2),('mollusc','Molluscs','scallop',2),
 ('mollusc','Molluscs','squid',2),('mollusc','Molluscs','calamari',2),('mollusc','Molluscs','octopus',2),
 ('fish','Fish','fish',5),('fish','Fish','salmon',5),('fish','Fish','tuna',5),('fish','Fish','cod',5),
 ('fish','Fish','tilapia',5),('fish','Fish','anchov',5),('fish','Fish','sardine',5),
 ('peanut','Peanut','peanut',1),('peanut','Peanut','groundnut',1),
 ('treenut','Tree nuts','tree nut',3),('treenut','Tree nuts','almond',3),('treenut','Tree nuts','cashew',3),
 ('treenut','Tree nuts','walnut',3),('treenut','Tree nuts','pecan',3),('treenut','Tree nuts','pistachio',3),
 ('treenut','Tree nuts','hazelnut',3),('treenut','Tree nuts','macadamia',3),('treenut','Tree nuts','brazil nut',3),
 ('milk','Milk / dairy','dairy',2),('milk','Milk / dairy','lactose',2),('milk','Milk / dairy','casein',2),
 ('milk','Milk / dairy','whey',2),('milk','Milk / dairy','milk',4),('milk','Milk / dairy','cheese',6),
 ('egg','Egg','egg',2),
 ('wheat','Wheat / gluten','gluten',2),('wheat','Wheat / gluten','celiac',2),('wheat','Wheat / gluten','coeliac',2),
 ('wheat','Wheat / gluten','wheat',3),('wheat','Wheat / gluten','barley',5),('wheat','Wheat / gluten','rye',5),
 ('soy','Soy','soy',2),('soy','Soy','soya',2),('soy','Soy','edamame',3),('soy','Soy','tofu',4),
 ('sesame','Sesame','sesame',2),('sesame','Sesame','tahini',2),
 ('mustard','Mustard','mustard',3),
 ('celery','Celery','celery',3),('celery','Celery','celeriac',3),
 ('sulphite','Sulphites','sulphite',3),('sulphite','Sulphites','sulfite',3),
 ('corn','Corn','corn',5),('corn','Corn','maize',5),
 ('coconut','Coconut','coconut',3),
 ('mushroom','Mushroom','mushroom',2),
 ('nightshade','Nightshades','nightshade',3),
 ('kiwi','Kiwi','kiwi',3),('banana','Banana','banana',3),('avocado','Avocado','avocado',3),
 ('strawberry','Strawberry','strawberr',3),
 ('chocolate','Chocolate','chocolate',5),('chocolate','Chocolate','cocoa',5),
 ('caffeine','Caffeine','caffeine',4),
 ('fodmap','FODMAPs','fodmap',3),
 ('artificial_sweetener','Artificial sweeteners','sweetener',2),
 ('artificial_sweetener','Artificial sweeteners','sucralose',2),
 ('artificial_sweetener','Artificial sweeteners','aspartame',2),
 ('artificial_sweetener','Artificial sweeteners','erythritol',2),
 ('artificial_sweetener','Artificial sweeteners','xylitol',2),
 ('artificial_sweetener','Artificial sweeteners','sorbitol',2)
on conflict do nothing;

-- Dietary pattern dictionary used by the intake parser.
insert into public.dietary_pattern_dictionary (k, label, term, priority) values
 ('vegan','Vegan','vegan',1),
 ('vegetarian','Vegetarian','vegetarian',2),
 ('pescatarian','Pescatarian','pescatarian',1),('pescatarian','Pescatarian','pescetarian',1),
 ('halal','Halal','halal',1),('kosher','Kosher','kosher',1),
 ('keto','Keto','ketogenic',1),('keto','Keto','keto',3),
 ('paleo','Paleo','paleo',1),('carnivore','Carnivore','carnivore',1),
 ('low_fodmap','Low FODMAP','low fodmap',1),('low_fodmap','Low FODMAP','low-fodmap',1),
 ('gluten_free','Gluten free','gluten free',1),('gluten_free','Gluten free','gluten-free',1),
 ('dairy_free','Dairy free','dairy free',1),('dairy_free','Dairy free','dairy-free',1),
 ('no_pork','No pork','no pork',1),('no_pork','No pork','pork free',1),
 ('no_red_meat','No red meat','no red meat',1),
 ('no_beef','No beef','no beef',1)
on conflict do nothing;

-- Crosswalk: intake allergen key -> meal-library tag.
insert into public.allergen_tag_crosswalk (allergen_key, tag_key, note) values
  ('wheat',     'gluten',     'Renamed concept: intake says wheat, library says gluten.'),
  ('milk',      'dairy',      'Renamed concept: intake says milk, library says dairy.'),
  ('treenut',   'tree_nut',   'Underscore mismatch only.'),
  ('mollusc',   'molluscs',   'Singular/plural mismatch only.'),
  ('sulphite',  'sulphites',  'Singular/plural mismatch only.'),
  ('egg',       'egg',        'Exact match.'),
  ('fish',      'fish',       'Exact match.'),
  ('peanut',    'peanut',     'Exact match.'),
  ('sesame',    'sesame',     'Exact match.'),
  ('shellfish', 'shellfish',  'Exact match.'),
  ('soy',       'soy',        'Exact match.'),
  ('celery',    'celery',     'Exact match.'),
  ('mustard',   'mustard',    'Exact match.')
on conflict (allergen_key) do nothing;

-- Crosswalk additions for plural and food-preference keys.
insert into public.allergen_tag_crosswalk (allergen_key, tag_key, note) values
  ('peanuts',          'peanut',           'Plural form produced by the hand-entry path. Same food as the canonical ''peanut'' key.'),
  ('brussels_sprouts', 'brussels_sprouts', 'Food-preference tag, not an allergen. No clinical weight.'),
  ('cantaloupe',       'cantaloupe',       'Food-preference tag, not an allergen. No clinical weight.'),
  ('squash',           'squash',           'Food-preference tag. Includes courgette/zucchini as a summer squash; excludes pumpkin SEEDS, which are not the flesh.'),
  ('strawberries',     'strawberry',       'Plural form produced by the hand-entry path. Same food as the canonical ''strawberry'' key.'),
  ('strawberry',       'strawberry',       'Canonical key produced by the parser.'),
  ('watermelon',       'watermelon',       'Food-preference tag, not an allergen. No clinical weight.')
on conflict (allergen_key) do nothing;
