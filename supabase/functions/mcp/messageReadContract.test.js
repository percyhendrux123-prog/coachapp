// Source-contract tests for the message-read acknowledgment contract.
// HONEST LABEL: these parse source text — they are contract guards, not
// integration tests. Behavioral coverage for the mark core lives in
// markThreadRead.test.ts (Deno, injected fake db).
//
// Contract:
//   - Sending a coach reply is a PURE APPEND. It never acknowledges unread
//     inbound messages, in the UI wrapper or in MCP send_message.
//   - Only explicit thread acknowledgment clears unread state: the UI
//     openThread/deep-link path, the explicit markThreadRead wrapper, or the
//     coach-only read_write MCP mark_thread_read tool.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const mcpSource = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const safetySource = fs.readFileSync(new URL("./safety.ts", import.meta.url), "utf8");
const coachClientsSource = fs.readFileSync(new URL("../../../src/lib/coachClients.js", import.meta.url), "utf8");
const coachInboxSource = fs.readFileSync(new URL("../../../src/pages/CoachInbox.jsx", import.meta.url), "utf8");

function toolBlock(source, name) {
  const start = source.indexOf(`name: "${name}"`);
  assert.notEqual(start, -1, `tool ${name} must exist`);
  const nextTool = source.indexOf('name: "', start + 1);
  return source.slice(start, nextTool === -1 ? undefined : nextTool);
}

// ---- UI send purity ----

test("sendCoachMessage is a pure append: no mark_thread_read side effect", () => {
  const start = coachClientsSource.indexOf("export async function sendCoachMessage");
  assert.notEqual(start, -1, "sendCoachMessage must exist");
  const end = coachClientsSource.indexOf("export ", start + 1);
  const body = coachClientsSource.slice(start, end);
  assert.match(body, /rpc\("send_coach_message"/, "send must stamp tenant on the server");
  assert.doesNotMatch(body, /\.from\("messages"\)\.insert/, "send must not browser-insert tenant_id");
  assert.doesNotMatch(body, /mark_thread_read/, "sending a reply must not acknowledge unread inbound messages");
  assert.doesNotMatch(body, /read_at/, "sending a reply must not stamp read_at");
  assert.doesNotMatch(body, /message_reads/, "sending a reply must not advance the read pointer");
  assert.doesNotMatch(body, /catch\s*\{\s*\}/, "sendCoachMessage must not swallow failures");
});

test("explicit markThreadRead wrapper still exists and surfaces failures", () => {
  const start = coachClientsSource.indexOf("export async function markThreadRead");
  assert.notEqual(start, -1, "explicit markThreadRead wrapper must remain");
  const end = coachClientsSource.indexOf("export ", start + 1);
  const body = coachClientsSource.slice(start, end === -1 ? undefined : end);
  assert.match(body, /rpc\("mark_thread_read"/, "wrapper must call the mark_thread_read RPC");
  assert.match(body, /if \(error\) throw error/, "an explicit mark failure must throw, never be swallowed");
});

test("Inbox open and deep-link acknowledgment paths are preserved", () => {
  const calls = coachInboxSource.match(/markThreadRead\(/g) ?? [];
  assert.ok(calls.length >= 2, "openThread and deep-link must both still mark explicitly");
});

// ---- MCP send purity ----

test("MCP send_message is a pure append", () => {
  const block = toolBlock(mcpSource, "send_message");
  const runBody = block.slice(block.indexOf("run:"));
  assert.doesNotMatch(runBody, /markThreadReadCore|mark_thread_read/, "send_message must not acknowledge the thread");
  assert.doesNotMatch(runBody, /read_at/, "send_message must not stamp read_at");
  assert.doesNotMatch(runBody, /message_reads/, "send_message must not advance the read pointer");
  assert.match(block, /does NOT mark the thread read/i, "the tool description must state the pure-append contract");
});

test("MCP message_coach (client send) stays a pure append", () => {
  const block = toolBlock(mcpSource, "message_coach");
  assert.doesNotMatch(block, /mark_thread_read|read_at|message_reads/);
});

// ---- explicit MCP mark tool ----

test("mark_thread_read tool exists in the coach surface and is classified as a write", () => {
  const coachTools = mcpSource.slice(mcpSource.indexOf("const COACH_TOOLS"), mcpSource.indexOf("const CLIENT_TOOLS"));
  const block = toolBlock(coachTools, "mark_thread_read");
  assert.match(block, /write:\s*true/, "mark_thread_read must be write-classified (read_write gate + readOnlyHint:false)");
  assert.match(block, /client_id:\s*S\.id/, "mark_thread_read must take exactly a client_id uuid");
});

test("mark_thread_read is not exposed to client tokens", () => {
  const clientTools = mcpSource.slice(mcpSource.indexOf("const CLIENT_TOOLS"));
  assert.doesNotMatch(clientTools, /name: "mark_thread_read"/, "client token surface must not contain the coach ack tool");
});

test("mark_thread_read run validates client ownership and delegates to the tested core", () => {
  const coachTools = mcpSource.slice(mcpSource.indexOf("const COACH_TOOLS"), mcpSource.indexOf("const CLIENT_TOOLS"));
  const block = toolBlock(coachTools, "mark_thread_read");
  assert.match(block, /ownedClient\(ctx, a\.client_id\)/, "must resolve the client inside the token tenant first");
  assert.match(block, /markThreadReadCore\(/, "must delegate to the behaviorally-tested core");
});

// ---- reader identity ----

test("authenticate() carries the connector token creator as reader identity", () => {
  assert.match(mcpSource, /created_by/, "authenticate must select created_by from connector_tokens");
  assert.match(mcpSource, /createdBy/, "Ctx must surface the creator id");
  const ctxType = mcpSource.slice(mcpSource.indexOf("type Ctx"), mcpSource.indexOf("// ---------- auth ----------"));
  assert.match(ctxType, /createdBy:\s*string \| null/, "Ctx type must declare createdBy");
});

// ---- audit ----

test("mark_thread_read audits only the client_id uuid", () => {
  assert.match(safetySource, /mark_thread_read:\s*\{\s*client_id:\s*"uuid"\s*\}/, "AUDIT_RULES must log client_id only for mark_thread_read");
});
