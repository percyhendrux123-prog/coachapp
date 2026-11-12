// node --test src/lib/challengeRunFlow.test.js
//
// The participant's daily flow against the SERVER CONTRACT of challenge-log and
// challenge-day-close, reproduced exactly by the synthetic server in
// challengeRunFixtures.js (20-hour gate measured from the most recent log; only the
// current day may be logged; the final tally reads real logs only). Nothing here
// touches Supabase. Every fixture is synthetic and labelled as such.
import test from "node:test";
import assert from "node:assert/strict";
import { createSyntheticChallenge, HOUR_MS } from "./challengeRunFixtures.js";
import {
  attemptClose, currentDayLog, functionError, isTooSoon, runIsDone, saveDay, tryAdvance,
} from "./challengeRunFlow.js";

const ALL = (s) => s.standards.map((x) => x.id);

async function enrolled() {
  const s = createSyntheticChallenge({ startAt: Date.parse("2026-09-21T02:00:00Z") });
  await s.api.enroll(s.challenge.id);
  return s;
}

test("defect record: the old log-then-close sequence is refused by the 20-hour gate every time", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  await s.api.logDay(run.id, 1, ALL(s));
  await assert.rejects(() => s.api.closeDay(run.id), (e) => isTooSoon(e) && e.status === 429);
  const after = await s.api.getMyRun(s.challenge.id);
  assert.equal(after.current_day_index, 1, "the day must not have advanced");
});

test("saveDay logs the day, reports not-advanced, and surfaces the unlock time instead of an error", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  const out = await saveDay({ api: s.api, runId: run.id, day: 1, standardsHit: ALL(s) });
  assert.equal(out.advanced, false);
  assert.equal(out.saved.all_standards_met, true);
  assert.equal(out.lockedUntil, new Date(s.clock.now() + 20 * HOUR_MS).toISOString());
  const logs = await s.api.getDayLogs(run.id);
  assert.equal(logs.length, 1);
  assert.equal(currentDayLog(logs, 1)?.all_standards_met, true);
});

test("tryAdvance never closes a day that has no log (an unlogged day is the server's call, not the client's)", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  s.clock.advance(30 * HOUR_MS);
  const out = await tryAdvance({ api: s.api, runId: run.id, day: 1, logs: [] });
  assert.deepEqual(out, { advanced: false, lockedUntil: null, skipped: "unlogged" });
  assert.equal(s.calls.closeDay, 0, "closeDay must not be called for an unlogged day");
});

test("after 20 hours tryAdvance closes the logged day and the run moves to the next day", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  await saveDay({ api: s.api, runId: run.id, day: 1, standardsHit: ALL(s) });
  s.clock.advance(19 * HOUR_MS + 59 * 60 * 1000);
  let logs = await s.api.getDayLogs(run.id);
  let out = await tryAdvance({ api: s.api, runId: run.id, day: 1, logs });
  assert.equal(out.advanced, false, "one minute early is still locked");
  s.clock.advance(2 * 60 * 1000);
  logs = await s.api.getDayLogs(run.id);
  out = await tryAdvance({ api: s.api, runId: run.id, day: 1, logs });
  assert.equal(out.advanced, true);
  assert.equal((await s.api.getMyRun(s.challenge.id)).current_day_index, 2);
});

test("re-logging the current day resets the unlock clock (documented, not hidden)", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  await saveDay({ api: s.api, runId: run.id, day: 1, standardsHit: ALL(s) });
  s.clock.advance(2 * HOUR_MS);
  const again = await saveDay({ api: s.api, runId: run.id, day: 1, standardsHit: ALL(s).slice(0, 4) });
  assert.equal(again.saved.all_standards_met, false);
  assert.equal(again.lockedUntil, new Date(s.clock.now() + 20 * HOUR_MS).toISOString());
});

test("seven perfect logged days, each closed on the return visit, end rewarded — set by the server, never by the client", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  for (let day = 1; day <= 7; day++) {
    const out = await saveDay({ api: s.api, runId: run.id, day, standardsHit: ALL(s) });
    assert.equal(out.advanced, false, `day ${day} cannot close on the same visit`);
    s.clock.advance(24 * HOUR_MS);
    const logs = await s.api.getDayLogs(run.id);
    const adv = await tryAdvance({ api: s.api, runId: run.id, day, logs });
    assert.equal(adv.advanced, true, `day ${day} closes on the next visit`);
  }
  const final = await s.api.getMyRun(s.challenge.id);
  assert.equal(final.status, "rewarded");
  assert.equal(final.perfect_week, true);
  assert.equal(runIsDone(final), true);
  assert.equal(s.state.logs.length, 7, "exactly the seven real logs — nothing fabricated");
  assert.equal(s.state.stripeCalls, 0, "the reward path creates no Stripe activity");
});

test("a day closed without a log ends the run incomplete, and no not-met log is fabricated for it", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  for (let day = 1; day <= 7; day++) {
    if (day !== 4) await saveDay({ api: s.api, runId: run.id, day, standardsHit: ALL(s) });
    s.clock.advance(24 * HOUR_MS);
    // Day 4 was never logged: the client refuses to close it, so the direct server call
    // stands in for whatever will eventually close a skipped day.
    if (day === 4) await attemptClose(s.api, run.id);
    else assert.equal((await tryAdvance({ api: s.api, runId: run.id, day, logs: await s.api.getDayLogs(run.id) })).advanced, true);
  }
  const final = await s.api.getMyRun(s.challenge.id);
  assert.equal(final.status, "incomplete");
  assert.equal(final.perfect_week, false);
  assert.equal(s.state.logs.length, 6);
  assert.equal(s.state.logs.find((l) => l.day_index === 4), undefined, "no fabricated day-4 row");
});

test("a fully logged week with one imperfect day ends completed, not rewarded", async () => {
  const s = await enrolled();
  const run = await s.api.getMyRun(s.challenge.id);
  for (let day = 1; day <= 7; day++) {
    await saveDay({ api: s.api, runId: run.id, day, standardsHit: day === 3 ? ALL(s).slice(1) : ALL(s) });
    s.clock.advance(24 * HOUR_MS);
    await tryAdvance({ api: s.api, runId: run.id, day, logs: await s.api.getDayLogs(run.id) });
  }
  const final = await s.api.getMyRun(s.challenge.id);
  assert.equal(final.status, "completed");
  assert.equal(final.perfect_week, false);
});

test("only a 429 'too soon' is treated as a lock; any other close failure is surfaced", async () => {
  const api = { closeDay: async () => { throw functionError("run not found", { status: 404 }); } };
  await assert.rejects(() => attemptClose(api, "x"), /run not found/);
  assert.equal(isTooSoon(functionError("too soon", { status: 429 })), true);
  assert.equal(isTooSoon(new Error("too soon")), true, "message alone still counts, for older error shapes");
  assert.equal(isTooSoon(new Error("bad json")), false);
});

test("enrollment is idempotent on the synthetic server, matching unique(challenge_id, participant_user_id)", async () => {
  const s = await enrolled();
  const first = await s.api.getMyRun(s.challenge.id);
  const again = await s.api.enroll(s.challenge.id);
  assert.equal(again.already_enrolled, true);
  assert.equal(again.run_id, first.id);
});
