# Starter content

**Sample content, edit before use.**

Three sample training programs and one sample meal plan, so a new coach has something to assign
in the first hour. They were written for this repository as generic starting points. They are
not prescriptions for any person, they are not from any coach's or company's paid programs, and
the calorie numbers are rough estimates. Check each client's health screen and intake before you
assign anything, and change exercises, sets, reps and foods to fit them.

| File | What it is |
| --- | --- |
| `sample_programs.sql` | Paste-in file. Adds the three programs below to your coach account. |
| `sample_meal_plan.sql` | Paste-in file. Adds the sample meal plan to one client as a draft. |
| `programs.json` | The programs in plain text. Edit this, not the SQL. |
| `meal-plan-template.json` | The meal plan in plain text. Edit this, not the SQL. |

## How they get into the app

The app has no import button for programs or meal plans. (The only importer is **Import from
Trainerize** on the Clients page, which imports one client's export.) So the two `.sql` files use
the same path SETUP.md already uses: the Supabase **SQL Editor**.

**Programs** (do this once, after SETUP.md is finished):

1. Open `sample_programs.sql` on GitHub and click **Raw**. Select all and copy.
2. In Supabase, open **SQL Editor** and a new, empty query tab. Paste and click **Run**.
3. You should see a table titled **Sample programs in your account** with three rows. In the app
   they are under **More > Programs**, each name starting with `Sample:`.

Running it again adds nothing new. If you do not want one, open **More > Programs**, click
**Edit** and change it, or leave it unassigned.

**Meal plan** (per client, optional):

1. Add the client in the app first (**Clients > Add client**).
2. Copy `sample_meal_plan.sql` the same way and paste it into a new, empty SQL Editor tab.
3. Replace `client@example.com` near the top with that client's email. Keep the quote marks.
4. Click **Run**. You should see the client's email next to `Sample: 3 meals and a snack` and
   the word `draft`. The client cannot see a draft.
5. In the app, open the client, then **Nutrition > Edit / re-assign**. Change the foods and
   numbers to fit them, then **Save draft**.

The client sees the plan once you click **Release** on the client (or **Assign to client** in
the meal plan editor). **Release assigns whatever draft is there**, so edit it first.

If you would rather type it in, every value is in `meal-plan-template.json`, and the app's own
meal plan generator is on the client's **Nutrition** tab (it needs the client's sex, age,
height, weight and activity level on their **Profile** first).

## The programs

**Sample: Full Body Basics (3 days).** Three full-body days on a 7-day week (A, rest, B, rest, C,
rest, rest). Squat, push, pull and hinge patterns at 8-12 reps, plus a plank, a glute bridge and
one 15-minute walk. For a client new to a gym.

**Sample: Upper / Lower (4 days).** Upper 1, Lower 1, rest, Upper 2, Lower 2, rest, rest. Two main lifts
a day at 5-10 reps, then one or two smaller exercises. For a client who already trains.

**Sample: Walk and Strength Starter.** Two short strength circuits and two 20-minute walks a week,
with sit-to-stand, wall push-ups and step-ups. For a client starting from little or no exercise.

None of the exercises has a demo video. Add your own links in the program builder (**Edit**, the
**demo URL** box next to each exercise).

## The meal plan

**Sample: 3 meals and a snack.** Breakfast, lunch, a snack and dinner, about 2,000 kcal
(protein 150 g, fat 65 g, carbohydrate 205 g), built from common foods. It does not check
allergies or diets. The client sees the plan's note, "Sample content, edit before use", until
you change it.

## Changing the files

Edit `programs.json` or `meal-plan-template.json`, then run
`node scripts/build-starter-sql.mjs` to rebuild the two `.sql` files. `npm test` fails if they
are out of date, if a program has a shape the app cannot read, or if the meal plan would fail
the app's release check (macros set, at least one meal).
