import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstUnseenCheckinHref, openCheckinHref } from "./coachCockpitNav.js";
import { getCockpitFixture, PREVIEW_COACH } from "./coachCockpitFixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("unseen cockpit fixture is coach-auth data with two clients and one unseen check-in", () => {
  const data = getCockpitFixture("unseen");
  assert.equal(PREVIEW_COACH.role, "coach");
  assert.ok(PREVIEW_COACH.user?.id);
  assert.ok(Array.isArray(data.clients) && data.clients.length >= 2);
  const unseen = data.clients.filter((row) => row.latestCheckin && !row.latestCheckin.coach_seen);
  assert.equal(unseen.length, 1);
  assert.equal(data.stats.unseenCheckins, 1);
  const fixtureId = unseen[0].client.id;
  assert.equal(
    firstUnseenCheckinHref(data.stats, data.clients),
    `/coach/clients?client=${fixtureId}&tab=checkins`,
  );
  assert.equal(openCheckinHref(unseen[0]), `/coach/clients?client=${fixtureId}&tab=checkins`);
});

test("preview route and fixture stay out of production and never mutate", () => {
  const app = source("src/App.jsx");
  const cockpit = source("src/pages/CoachCockpit.jsx");
  const fixtures = source("src/lib/coachCockpitFixtures.js");

  assert.match(app, /PREVIEW_ROUTES_ENABLED && \([\s\S]*path="\/__preview\/coach-cockpit"/);
  assert.match(cockpit, /previewName/);
  assert.match(cockpit, /coachCockpitFixtures/);
  assert.doesNotMatch(fixtures, /from ["'].*supabase["']/);
  assert.doesNotMatch(fixtures, /markCheckinSeen|sendCoachMessage/);
  assert.match(cockpit, /previewName[\s\S]*allowMutations=\{false\}|allowMutations=\{!previewName\}/);
});
