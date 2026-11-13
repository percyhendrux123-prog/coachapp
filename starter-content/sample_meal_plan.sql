-- Coach app sample meal plan. SAMPLE CONTENT, EDIT BEFORE USE.
-- Generated from starter-content/meal-plan-template.json by scripts/build-starter-sql.mjs. Do not edit by hand.
--
-- Sample content, edit before use. A generic layout, not advice for any person. Calories are rough estimates. Check the client's intake (allergies, diet, health screen) and set their own targets before you assign a plan.
--
-- How to use: add the client in the app first (Clients > Add client). Paste this whole file into
-- a new, empty Supabase SQL Editor tab, replace client@example.com below with that client's
-- email (keep the quote marks), and click Run. It saves the plan as a DRAFT on that client:
-- the client cannot see it. Open the client in the app, edit the plan to fit them, and release
-- it from there. If the client already has a meal plan, this changes nothing.

do $starter$
declare
  client_email text := 'client@example.com';
  owner_tenant uuid;
  target_client uuid;
begin
  select id into owner_tenant from public.tenants where slug = 'owner';
  if owner_tenant is null then
    raise exception 'No coach account yet. Finish SETUP.md step 25 first, then run this again.';
  end if;
  select c.id into target_client from public.clients c
   where c.tenant_id = owner_tenant and lower(c.email) = lower(client_email)
   limit 1;
  if target_client is null then
    raise exception 'No client with the email % in your account. Add the client in the app first, or check the email.', client_email;
  end if;

  insert into public.meal_plans (tenant_id, client_id, title, calories, protein_g, fat_g, carb_g, meals, notes, status)
  values (owner_tenant, target_client, 'Sample: 3 meals and a snack', 2000, 150, 65, 205,
          $json$[{"name":"Breakfast","note":"Can be made the night before.","items":[{"food":"Plain Greek yogurt","qty":"250 g","kcal":240},{"food":"Rolled oats","qty":"40 g","kcal":150},{"food":"Berries","qty":"1 cup","kcal":70}]},{"name":"Lunch","note":"","items":[{"food":"Chicken breast, cooked","qty":"150 g","kcal":250},{"food":"Rice, cooked","qty":"1 cup","kcal":205},{"food":"Mixed vegetables","qty":"2 cups","kcal":90},{"food":"Olive oil","qty":"1 tbsp","kcal":120}]},{"name":"Snack","note":"","items":[{"food":"Apple","qty":"1 medium","kcal":95},{"food":"Peanut butter","qty":"2 tbsp","kcal":190}]},{"name":"Dinner","note":"","items":[{"food":"Salmon fillet, cooked","qty":"150 g","kcal":310},{"food":"Potatoes, baked","qty":"250 g","kcal":230},{"food":"Green salad with dressing","qty":"1 bowl","kcal":50}]}]$json$::jsonb,
          'Sample content, edit before use. Swap any food for one the client already eats and likes.', 'draft')
  on conflict (tenant_id, client_id) do nothing;
end
$starter$;

select c.email as client, m.title, m.status
from public.meal_plans m join public.clients c on c.id = m.client_id
where m.tenant_id = (select id from public.tenants where slug = 'owner')
order by m.updated_at desc
limit 5;
