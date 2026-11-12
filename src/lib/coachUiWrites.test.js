// Source-contract: coach UI writes go through server-stamped RPCs.
// The browser must not insert tenant_id. That is what produced
// "new row violates row-level security policy" on Inbox send / Add client.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("./coachClients.js", import.meta.url), "utf8");
const sql = fs.readFileSync(new URL("../../supabase/migrations/20260824153000_coach_ui_writes.sql", import.meta.url), "utf8");

function fn(name) {
  const start = src.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = src.indexOf("export ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("createClient uses create_coach_client and does not insert tenant_id", () => {
  const body = fn("createClient");
  assert.match(body, /rpc\("create_coach_client"/);
  assert.doesNotMatch(body, /\.from\("clients"\)\.insert/);
  assert.doesNotMatch(body, /tenant_id:\s*tenantId/);
});

test("sendCoachMessage uses send_coach_message and stays a pure append", () => {
  const body = fn("sendCoachMessage");
  assert.match(body, /rpc\("send_coach_message"/);
  assert.doesNotMatch(body, /\.from\("messages"\)\.insert/);
  assert.doesNotMatch(body, /mark_thread_read|read_at|message_reads/);
});

test("SQL stamps tenant from the session and does not mark threads read", () => {
  assert.match(sql, /current_tenant_id\(\)/);
  assert.match(sql, /create or replace function public.send_coach_message/);
  assert.match(sql, /create or replace function public.create_coach_client/);
  assert.doesNotMatch(sql, /mark_thread_read|message_reads|read_at/);
  assert.match(sql, /grant execute on function public.send_coach_message/);
  assert.match(sql, /grant execute on function public.create_coach_client/);
});
