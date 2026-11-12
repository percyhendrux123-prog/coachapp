import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("MCP tools/list advertises read-only tools to untrusted clients", () => {
  assert.match(
    source,
    /\.map\(\(\{ name, description, inputSchema, write \}\)\s*=>\s*\(\{[\s\S]*annotations:\s*\{\s*readOnlyHint:\s*!write\s*\}/,
  );
});

test("the five owner-scope client tools are all write:true, scope:\"owner\"", () => {
  const OWNER_TOOLS = ["update_my_program", "set_my_macros", "set_my_meals", "add_my_meal", "regenerate_my_plan"];
  for (const name of OWNER_TOOLS) {
    const at = source.indexOf(`name: "${name}",`);
    assert.ok(at >= 0, `${name} not found in index.ts`);
    const nextToolAt = source.indexOf('\n    name: "', at + 1);
    const body = source.slice(at, nextToolAt > 0 ? nextToolAt : at + 2000);
    assert.match(body, /write: true, scope: "owner",/, `${name} must declare write: true, scope: "owner"`);
  }
});
