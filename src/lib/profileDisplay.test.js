import test from "node:test";
import assert from "node:assert/strict";
import { formatHeight, formatWeight, roundForDisplay, KEEP_CASE } from "./profileDisplay.js";

// Measured on a fresh install: a coach saved 5 ft 6 in / 160 lb / goal 150 lb and the
// client's Profile tab showed "65.98 In", "160.06 Lb", "149.91 Lb" and a title-cased email
// (hosted run: "5 Ft 4 In", "132.1 Lb").
test("height reads as feet and inches, not conversion noise", () => {
  assert.equal(formatHeight({ imperial: true, height_in: 65.98, height_cm: 167.6 }), "5 ft 6 in");
  assert.equal(formatHeight({ imperial: true, height_in: "71.5", height_cm: 181.6 }), "6 ft 0 in");
  assert.equal(formatHeight({ imperial: false, height_in: 65.98, height_cm: 167.6 }), "168 cm");
  assert.equal(formatHeight({ imperial: true, height_in: null, height_cm: null }), null);
});

test("pounds round to the whole pound, kilograms to one decimal", () => {
  assert.equal(formatWeight({ imperial: true, lb: 160.06, kg: 72.6 }), "160 lb");
  assert.equal(formatWeight({ imperial: true, lb: "132.06", kg: 59.9 }), "132 lb");
  assert.equal(formatWeight({ imperial: false, lb: 160.06, kg: "72.600" }), "72.6 kg");
  assert.equal(formatWeight({ imperial: true, lb: 160, kg: null }), "160 lb");
  assert.equal(formatWeight({ imperial: true, lb: null, kg: null }), null);
  assert.equal(roundForDisplay("abc"), null);
});

test("email and measurements keep their case on the Profile tab", () => {
  assert.ok(KEEP_CASE.has("Email"));
  assert.ok(KEEP_CASE.has("Height") && KEEP_CASE.has("Weight") && KEEP_CASE.has("Goal weight"));
  assert.ok(!KEEP_CASE.has("Status"));
});
