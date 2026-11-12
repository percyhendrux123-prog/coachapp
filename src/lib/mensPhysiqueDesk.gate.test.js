import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../pages/Client.jsx", import.meta.url), "utf8");
const brief = readFileSync(new URL("../components/ClientBrief.jsx", import.meta.url), "utf8");

test("Brief only mounts the Men's Physique desk for prep clients", () => {
  assert.match(client, /showPrepDesk=\{classificationOf\(me\) === "prep"\}/);
  assert.match(brief, /showPrepDesk && <MensPhysiqueDesk/);
  assert.doesNotMatch(brief, /showPrepDesk = true/);
});
