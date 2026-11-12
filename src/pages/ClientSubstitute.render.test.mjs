import React from "react";
import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { p13FixturePlugin } from "../../scripts/p13-fixture-plugin.mjs";
import { createFixture, ctx } from "../../scripts/p13-fixtures.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = { innerHeight: 844, location: { origin: "https://example.invalid" } };
const server = await createServer({ configFile: false, root: new URL("../..", import.meta.url).pathname,
  envDir: "/nonexistent-p13-env", envPrefix: "P13_UNUSED_", logLevel: "error", appType: "custom",
  server: { middlewareMode: true, hmr: false }, esbuild: { jsx: "automatic" }, plugins: [p13FixturePlugin()] });
after(() => server.close());
const { __ProgramTab: ProgramTab, __MessagesTab: MessagesTab } = await server.ssrLoadModule("/src/pages/Client.jsx");
const { default: CoachInbox } = await server.ssrLoadModule("/src/pages/CoachInbox.jsx");
const { default: Composer } = await server.ssrLoadModule("/src/components/ClientMessageComposer.jsx");
let fixture, renderer;
beforeEach(() => { fixture = createFixture(); globalThis.__p13 = fixture; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });
const text = (node) => typeof node === "string" ? node : (node?.children ?? []).map(text).join("");
const has = (value) => text(renderer.toJSON()).includes(value);
const buttons = (value, root = renderer.root) => root.findAllByType("button").filter((b) => text(b).includes(value));
const button = (value, root) => { const matches = buttons(value, root); assert.ok(matches.length, `button ${value}`); return matches[0]; };
const click = async (value, root) => act(async () => { const b = button(value, root); assert.ok(!b.props.disabled); b.props.onClick({ currentTarget: { isConnected: true, focus() {} } }); });
const edit = async (value) => act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value } }));
const submit = async () => act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
async function mount(element = React.createElement(ProgramTab, { ctx, mode: "coached", messagingOn: true })) {
  await act(async () => { renderer = create(element, { createNodeMock: (el) => el.type === "dialog" ? { showModal() {}, close() {} } : null }); });
}
const draft = () => renderer.root.findByType("textarea").props.value;
const dialog = () => renderer.root.findByType("dialog");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("eligible prestart entry opens contextual unsent draft with lazy read, no writes", async () => {
  await mount();
  assert.equal(buttons("Ask coach for substitute").length, 2);
  assert.equal(fixture.reads, 0);
  await click("Ask coach for substitute");
  assert.match(draft(), /Bench press[\s\S]*Upper body[\s\S]*Available equipment/);
  assert.equal(dialog().props["aria-labelledby"], "substitute-title");
  assert.equal(fixture.reads, 1);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.activities, []);
  assert.ok(has("No messages yet"));
});

for (const props of [{ mode: "self_serve", messagingOn: true }, { mode: "coached", messagingOn: false }]) {
  test(`no request for ${JSON.stringify(props)}`, async () => {
    await mount(React.createElement(ProgramTab, { ctx, ...props }));
    assert.equal(buttons("Ask coach for substitute").length, 0);
    assert.equal(fixture.reads, 0);
  });
}

test("past, future and rest cards offer no request", async () => {
  fixture.pack.assignment.current_day_index = 1;
  await mount();
  const select = (i) => act(async () => renderer.root.find((n) => n.type?.name === "ProgramDayStrip").props.onSelect(i));
  await select(0); assert.equal(buttons("Ask coach for substitute").length, 0);
  await select(2); assert.equal(buttons("Ask coach for substitute").length, 0);
  await select(1); assert.equal(buttons("Ask coach for substitute").length, 1);
});

test("Close and Escape preserve draft, different exercise requires keep/discard", async () => {
  await mount(); await click("Ask coach for substitute"); await edit("Keep my equipment detail");
  await click("Close"); await click("Ask coach for substitute"); assert.equal(draft(), "Keep my equipment detail");
  await act(async () => dialog().props.onCancel({ preventDefault() {} }));
  await act(async () => buttons("Ask coach for substitute")[1].props.onClick({ currentTarget: {} }));
  assert.ok(has("Keep it, or discard")); assert.equal(draft(), "Keep my equipment detail");
  await click("Keep current request"); assert.equal(draft(), "Keep my equipment detail");
  await click("Close");
  await act(async () => buttons("Ask coach for substitute")[1].props.onClick({ currentTarget: {} }));
  await click("Discard draft and switch"); assert.match(draft(), /Cable row/);
  assert.deepEqual(fixture.writes, []);
});

test("failed thread is not empty, draft editable, Retry recovers", async () => {
  fixture.failRead = true; await mount(); await click("Ask coach for substitute");
  assert.ok(has("Could not load messages")); assert.equal(has("No messages yet"), false);
  await edit("Retained despite read outage");
  assert.equal(button("Send").props.disabled, true);
  fixture.failRead = false; await click("Retry messages");
  assert.equal(draft(), "Retained despite read outage"); assert.equal(button("Send").props.disabled, false);
});

test("loading is distinct and send waits for thread scope readiness", async () => {
  const wait = deferred(); fixture.readWait = wait.promise;
  await mount(); await click("Ask coach for substitute");
  assert.ok(has("Loading messages")); assert.equal(has("No messages yet"), false);
  await submit(); assert.equal(fixture.writes.length, 0);
  await act(async () => wait.resolve()); assert.ok(has("No messages yet"));
});

test("insert failure retains draft; successful retry clears it once and records activity", async () => {
  fixture.failSend = true; await mount(); await click("Ask coach for substitute");
  await edit("Bench press substitute. Available equipment: bands."); await submit();
  assert.ok(has("Message not sent")); assert.match(draft(), /bands/); assert.equal(fixture.activities.length, 0);
  fixture.failSend = false; await submit();
  assert.equal(draft(), ""); assert.ok(has("Message sent")); assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.activities.length, 1); assert.equal(fixture.activities[0].template, "client_message_sent");
  assert.deepEqual(fixture.writes.at(-1), { kind: "message", ...ctx, body: "Bench press substitute. Available equipment: bands." });
});

test("double submit in same event turn is single insert; close/reopen cannot resend pending draft", async () => {
  const wait = deferred(); fixture.sendWait = wait.promise;
  await mount(); await click("Ask coach for substitute");
  await act(async () => { const send = renderer.root.findByType("form").props.onSubmit; send({ preventDefault() {} }); send({ preventDefault() {} }); });
  assert.equal(fixture.writes.length, 1);
  await click("Close"); await click("Ask coach for substitute"); assert.equal(button("Sending…").props.disabled, true);
  await act(async () => wait.resolve()); assert.equal(fixture.messages.length, 1);
});

test("post-insert read failure is confirmed send plus read Retry, never resend", async () => {
  await mount(); await click("Ask coach for substitute"); fixture.failRead = true; await submit();
  assert.ok(has("Message sent")); assert.ok(has("Could not load messages"));
  assert.equal(has("Message not sent"), false); assert.equal(draft(), "");
  fixture.failRead = false; await click("Retry messages");
  assert.equal(fixture.messages.length, 1); assert.equal(fixture.activities.length, 1);
});

test("a newly edited draft after a confirmed send survives Close/reopen", async () => {
  await mount(); await click("Ask coach for substitute"); await submit();
  await edit("Follow-up equipment detail, not sent"); await click("Close");
  await click("Ask coach for substitute");
  assert.equal(draft(), "Follow-up equipment detail, not sent");
  assert.equal(fixture.messages.length, 1);
});

for (const cardio of [false, true]) for (const fail of [false, true]) {
  test(`dirty ${cardio ? "cardio" : "strength"} blur → Ask/Close, save ${fail ? "fails recoverably" : "succeeds"}, no Mark`, async () => {
    if (cardio) fixture.pack.assignment.current_day_index = 1;
    fixture.failLog = fail;
    await mount(); await click("Start workout");
    const input = renderer.root.findAllByType("input").find((n) => n.props.id.startsWith(cardio ? "dur-" : "wt-"));
    await act(async () => input.props.onBlur({ target: { value: "25" } }));
    await click("Ask coach for substitute");
    assert.equal(fixture.writes.filter((w) => w.kind === "log").length, 1);
    assert.equal(fixture.writes.at(-1).done, false);
    assert.ok(has("Step 1 of"));
    if (fail) {
      assert.ok(has("Workout input did not save")); fixture.failLog = false;
      await click("Retry workout save", dialog());
      assert.equal(has("Workout input did not save"), false);
    }
    await click("Close"); assert.ok(has("Step 1 of"));
    assert.equal(fixture.messages.length, 0); assert.equal(fixture.activities.length, 0);
  });
}

test("runner remains mounted at same step and rest timer across request open/close", async () => {
  await mount(); await click("Start workout"); await click("Mark");
  const before = renderer.root.find((n) => n.type?.name === "DayCard");
  assert.ok(has("Step 2 of")); assert.ok(has("Rest 1:30"));
  await click("Ask coach for substitute"); await click("Close");
  assert.equal(renderer.root.find((n) => n.type?.name === "DayCard"), before);
  assert.ok(has("Step 2 of")); assert.ok(has("Rest 1:30"));
});

test("a stale Retry cannot enqueue the failed value after a newer blur save", async () => {
  fixture.failLog = true; await mount(); await click("Start workout");
  const input = () => renderer.root.findAllByType("input").find((n) => n.props.id.startsWith("wt-"));
  await act(async () => input().props.onBlur({ target: { value: "25" } }));
  const oldRetry = button("Retry workout save").props.onClick;
  const wait = deferred();
  fixture.workouts.logSet = async (payload) => { fixture.writes.push({ kind: "log", ...payload }); await wait.promise; };
  await act(async () => { input().props.onBlur({ target: { value: "30" } }); oldRetry(); });
  assert.deepEqual(fixture.writes.filter((w) => w.kind === "log").map((w) => w.weight), ["25", "30"]);
  assert.ok(has("Saving workout input"));
  await act(async () => wait.resolve());
  assert.equal(buttons("Retry workout save").length, 0);
});

test("another set success cannot hide an unresolved failure in the modal", async () => {
  fixture.failLog = true; await mount(); await click("Start workout");
  const blur = () => renderer.root.findAllByType("input").find((n) => n.props.id.startsWith("wt-")).props.onBlur({ target: { value: "25" } });
  await act(async () => blur()); await click("Next ›");
  fixture.failLog = false; await act(async () => blur());
  await click("Ask coach for substitute");
  assert.ok(text(dialog()).includes("Workout input did not save"));
  await click("Retry workout save", dialog());
  assert.equal(text(dialog()).includes("Workout input did not save"), false);
  assert.equal(fixture.writes.at(-1).setIndex, 0);
});

test("each failed set remains recoverable until its own retry succeeds", async () => {
  fixture.failLog = true; await mount(); await click("Start workout");
  const blur = () => renderer.root.findAllByType("input").find((n) => n.props.id.startsWith("wt-")).props.onBlur({ target: { value: "25" } });
  await act(async () => blur()); await click("Next ›"); await act(async () => blur());
  await click("Ask coach for substitute"); fixture.failLog = false;
  await click("Retry workout save", dialog()); assert.ok(text(dialog()).includes("Workout input did not save"));
  await click("Retry workout save", dialog()); assert.equal(text(dialog()).includes("Workout input did not save"), false);
});

for (const cardio of [false, true]) {
  test(`failed ${cardio ? "duration" : "weight"} is merged into a later successful field save`, async () => {
    if (cardio) fixture.pack.assignment.current_day_index = 1;
    fixture.failLog = true; await mount(); await click("Start workout");
    const field = (prefix) => renderer.root.findAllByType("input").find((n) => n.props.id.startsWith(prefix));
    await act(async () => field(cardio ? "dur-" : "wt-").props.onBlur({ target: { value: "25" } }));
    await click("Ask coach for substitute"); await click("Close");
    fixture.failLog = false;
    await act(async () => field(cardio ? "dist-" : "reps-").props.onBlur({ target: { value: "10" } }));
    const write = fixture.writes.at(-1);
    assert.equal(write[cardio ? "durationSeconds" : "weight"], cardio ? 1500 : "25");
    assert.equal(write[cardio ? "distanceMeters" : "reps"], cardio ? 10000 : "10");
    assert.equal(write.done, false);
    await click("Ask coach for substitute"); assert.equal(text(dialog()).includes("Workout input did not save"), false);
  });
}

test("an Ask/blur cannot silently retry a previously failed Mark", async () => {
  fixture.failLog = true; await mount(); await click("Start workout"); await click("Mark");
  fixture.failLog = false;
  await act(async () => renderer.root.findAllByType("input").find((n) => n.props.id.startsWith("wt-")).props.onBlur({ target: { value: "30" } }));
  await click("Ask coach for substitute");
  assert.equal(fixture.writes.at(-1).done, false); assert.ok(has("Step 1 of"));
  assert.ok(text(dialog()).includes("Set completion is still not saved"));
  await click("Retry workout save", dialog()); assert.equal(fixture.writes.at(-1).done, true);
  assert.ok(has("Step 2 of"));
});

test("general composer draft is independent from request state", async () => {
  function Both() { return React.createElement(React.Fragment, null,
    React.createElement(MessagesTab, { ctx, rows: [], loadState: "ready", reload: async () => {} }),
    React.createElement(ProgramTab, { ctx, mode: "coached", messagingOn: true })); }
  await mount(React.createElement(Both));
  await edit("Unrelated general draft"); await click("Ask coach for substitute");
  assert.equal(renderer.root.findAllByType("textarea")[0].props.value, "Unrelated general draft");
  assert.match(renderer.root.findAllByType("textarea")[1].props.value, /Bench press/);
});

test("account-keyed ProgramTab unmount invalidates late reads and discards former draft", async () => {
  const wait = deferred(); fixture.readWait = wait.promise;
  await mount(React.createElement(ProgramTab, { key: "a", ctx, mode: "coached", messagingOn: true }));
  await click("Ask coach for substitute"); await edit("Former account draft");
  await act(async () => renderer.update(React.createElement(ProgramTab, { key: "b", ctx: { clientId: "b", tenantId: "b" }, mode: "coached", messagingOn: true })));
  await act(async () => wait.resolve());
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
  await click("Ask coach for substitute"); assert.equal(draft().includes("Former account"), false);
});

test("coach reads exactly the confirmed request in the real Inbox and Thread", async () => {
  await mount(); await click("Ask coach for substitute"); await edit("Bench press · Upper body. Equipment: bands."); await submit();
  await act(async () => renderer.update(React.createElement(MemoryRouter, null, React.createElement(CoachInbox))));
  assert.ok(has("Bench press · Upper body. Equipment: bands.")); await click("Demo Client");
  assert.ok(has("Bench press · Upper body. Equipment: bands."));
});

test("shared general composer retains insert/read separation", async () => {
  let body = "General message";
  await mount(React.createElement(Composer, { ctx, body, setBody: (value) => { body = value; }, loadState: "ready", reload: async () => { throw new Error("read failed"); } }));
  await submit(); assert.equal(body, ""); assert.ok(has("Message sent")); assert.equal(fixture.activities.length, 1);
});
