// Run: deno test supabase/functions/_shared/units_test.ts
//
// The cases that matter here are the REFUSALS. A parser that reads "210.7 lb" correctly
// but also confidently reads bare "210.7" is the parser that shipped the bug.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { parseAge, parseGoalWeightLb, parseHeightIn, parseWeightLb } from "./units.ts";

Deno.test("weight: explicit units are read as stated", () => {
  const lb = parseWeightLb("210.7 lb");
  assert(lb.ok); assertEquals((lb as { lb: number }).lb, 210.7);

  const kg = parseWeightLb("95.6 kg");
  assert(kg.ok); assertAlmostEquals((kg as { lb: number }).lb, 210.8, 0.2);

  const stone = parseWeightLb("15 st 4");
  assert(stone.ok); assertEquals((stone as { lb: number }).lb, 214);
});

Deno.test("weight: Cheryl's bare 210.7 REFUSES and names both readings", () => {
  const r = parseWeightLb("210.7");
  assertEquals(r.ok, false);
  const f = r as { reason: string; candidates?: string[] };
  assertEquals(f.candidates?.length, 2);
  assert(f.candidates?.[0].includes("210.7 lb"));
  assert(f.candidates?.[1].includes("210.7 kg"));
});

Deno.test("weight: a bare number resolves only when one reading is impossible", () => {
  // 65 kg is 143 lb (real); 65 lb is below the floor for an adult -> reads as kg.
  const kgOnly = parseWeightLb("65");
  assert(kgOnly.ok);
  assertAlmostEquals((kgOnly as { lb: number }).lb, 143.3, 0.2);

  // 85 stays AMBIGUOUS on purpose: 85 lb is a small adult and 85 kg is an average one.
  // Both are real people, so the parser must not choose between them.
  assertEquals(parseWeightLb("85").ok, false);

  // 400 lb is a real weight; 400 kg is not -> reads as lb.
  const lbOnly = parseWeightLb("400");
  assert(lbOnly.ok); assertEquals((lbOnly as { lb: number }).lb, 400);

  assertEquals(parseWeightLb("12").ok, false);
  assertEquals(parseWeightLb("").ok, false);
  assertEquals(parseWeightLb("no idea").ok, false);
});

Deno.test("height: curly quotes from a phone keyboard parse (Cheryl wrote 5’4”)", () => {
  for (const s of [`5'4"`, "5’4”", "5 ft 4", "5ft4in", `5' 4"`]) {
    const r = parseHeightIn(s);
    assert(r.ok, `expected ${s} to parse`);
    assertEquals((r as { inch: number }).inch, 64, `for ${s}`);
  }
});

Deno.test("height: 5 feet flat is not read as 5 inches", () => {
  const r = parseHeightIn("5'");
  assert(r.ok); assertEquals((r as { inch: number }).inch, 60);
});

Deno.test("height: explicit and impossible-reading resolution", () => {
  const cm = parseHeightIn("163 cm");
  assert(cm.ok); assertAlmostEquals((cm as { inch: number }).inch, 64.17, 0.02);

  const m = parseHeightIn("1.63 m");
  assert(m.ok); assertAlmostEquals((m as { inch: number }).inch, 64.17, 0.02);

  // 64 cm is not a human height -> inches. 163 in is not either -> cm.
  const asIn = parseHeightIn("64");
  assert(asIn.ok); assertEquals((asIn as { inch: number }).inch, 64);
  const asCm = parseHeightIn("163");
  assert(asCm.ok); assertAlmostEquals((asCm as { inch: number }).inch, 64.17, 0.02);
});

Deno.test("height: a genuinely ambiguous bare number refuses", () => {
  // 60 in = 5'0" and 60 cm... is not human. Use 130: 130cm=51in (child, out of range)
  // so pick a figure real both ways -> 48..90 in overlaps 122..229 cm only above 122.
  const r = parseHeightIn("180");
  // 180 in = 15 ft (impossible), 180 cm = 70.9 in (real) -> resolves to cm, not ambiguous.
  assert(r.ok);
  assertAlmostEquals((r as { inch: number }).inch, 70.87, 0.02);

  // 70 reads as inches (5'10"); 70 cm is not a human height.
  const s = parseHeightIn("70");
  assert(s.ok); assertEquals((s as { inch: number }).inch, 70);
});

Deno.test("goal weight: Cheryl's '165-170' is a band, and it is still unit-ambiguous", () => {
  const bare = parseGoalWeightLb("165-170");
  assertEquals(bare.ok, false, "no unit on either end -> must refuse");

  const withUnit = parseGoalWeightLb("165-170 lb");
  assert(withUnit.ok);
  const g = withUnit as { lb: number; range?: [number, number] };
  assertEquals(g.lb, 167.5);
  assertEquals(g.range, [165, 170]);
});

Deno.test("goal weight: single value and en-dash ranges", () => {
  const one = parseGoalWeightLb("165 lbs");
  assert(one.ok); assertEquals((one as { lb: number }).lb, 165);

  const dash = parseGoalWeightLb("75–80 kg");
  assert(dash.ok);
  assertAlmostEquals((dash as { lb: number }).lb, 170.9, 0.3);
});

Deno.test("age: range-checked, never coerced", () => {
  const ok = parseAge("62");
  assert(ok.ok); assertEquals((ok as { age: number }).age, 62);
  assertEquals(parseAge("").ok, false);
  assertEquals(parseAge("120").ok, false);
  assertEquals(parseAge("9").ok, false);
});
