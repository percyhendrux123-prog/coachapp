import React, { StrictMode } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { act, create } from "react-test-renderer";
import { useClientMessagePresence } from "../lib/useClientMessagePresence.js";
import { useClientAccountBranding } from "../lib/useClientAccountBranding.js";
import { readMessageLastSeen, writeMessageLastSeen } from "../lib/clientMessagePresence.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OLD_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const oldCursor = { sentAt: "2026-08-21T10:00:00.000Z", id: OLD_ID };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function storageFixture() {
  const values = new Map();
  const writes = [];
  return {
    writes,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.push({ key, value });
      values.set(key, value);
    },
  };
}

function message(id, body, sentAt = "2026-08-21T11:00:00.000Z") {
  return { id, sender_role: "coach", body, sent_at: sentAt };
}

function Harness({ capture, ...props }) {
  capture.current = useClientMessagePresence(props);
  return null;
}

function AccountBrandingHarness({ capture, presenceProps, ...brandingProps }) {
  const branding = useClientAccountBranding(brandingProps);
  const presence = useClientMessagePresence({
    ...presenceProps,
    enabled: branding.messagingOn,
  });
  capture.current = { branding, presence };
  return null;
}

async function mount(props, { strict = true } = {}) {
  const capture = { current: null };
  let renderer;
  const element = (nextProps) => React.createElement(
    strict ? StrictMode : React.Fragment,
    null,
    React.createElement(Harness, { ...nextProps, capture }),
  );
  await act(async () => {
    renderer = create(element(props), { unstable_strictMode: strict });
    await Promise.resolve();
  });
  return {
    capture,
    update: async (nextProps) => {
      await act(async () => {
        renderer.update(element(nextProps));
        await Promise.resolve();
      });
    },
    unmount: async () => act(async () => renderer.unmount()),
  };
}

function baseProps(overrides = {}) {
  return {
    messageKey: "user-a:client-a",
    enabled: true,
    clientId: "client-a",
    activeTabRef: { current: "program" },
    storage: storageFixture(),
    eventWindow: null,
    eventDocument: null,
    latestCoachCursorFn: async () => null,
    countUnreadFn: async () => 0,
    onPresenceError: () => {},
    ...overrides,
  };
}

test("account switch hides stale branding and cannot advance the new account pointer before its branding resolves", async () => {
  const brandingReads = { "user-a": deferred(), "user-b": deferred() };
  const storage = storageFixture();
  const activeTabRef = { current: "messages" };
  const capture = { current: null };
  const listCalls = [];
  let accountResets = 0;
  const loadBrandingFn = ({ userId }) => brandingReads[userId].promise;
  const listMessagesFn = async ({ messageKey }) => {
    listCalls.push(messageKey);
    return [message(NEW_ID, `${messageKey} private body`)];
  };

  const propsFor = (userId, clientId) => ({
    userId,
    role: "client",
    activeTabRef,
    loadBrandingFn,
    onAccountTransition: () => { accountResets += 1; },
    presenceProps: baseProps({
      messageKey: `${userId}:${clientId}`,
      clientId,
      activeTabRef,
      storage,
      listMessagesFn,
      latestCoachCursorFn: async () => ({ sentAt: "2026-08-21T11:00:00.000Z", id: NEW_ID }),
      countUnreadFn: async () => 1,
    }),
  });

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(AccountBrandingHarness, {
      ...propsFor("user-a", "client-a"),
      capture,
    }));
    await Promise.resolve();
  });

  await act(async () => {
    renderer.update(React.createElement(AccountBrandingHarness, {
      ...propsFor("user-b", "client-b"),
      capture,
    }));
    await Promise.resolve();
  });

  await act(async () => {
    brandingReads["user-a"].resolve({ messaging_on: true, payment_link: "account-a-private" });
    await Promise.resolve();
  });

  assert.equal(activeTabRef.current, "program", "a real account transition leaves Messages synchronously");
  assert.equal(accountResets, 1);
  assert.equal(listCalls.includes("user-b:client-b"), false, "B messages stay gated until B branding is owned and ready");
  assert.equal(readMessageLastSeen(storage, "user-b:client-b"), null, "B's local pointer cannot advance behind a later redirect");
  assert.equal(capture.current.branding.branding?.payment_link, undefined, "A branding is never visible in B's render");

  await act(async () => {
    brandingReads["user-b"].resolve({ messaging_on: false, payment_link: "account-b" });
    await Promise.resolve();
  });
  assert.equal(capture.current.branding.branding?.payment_link, "account-b");
  assert.equal(capture.current.branding.messagingOn, false);

  await act(async () => renderer.unmount());
});

test("same-user auth refresh does not reset the active tab or restart branding", async () => {
  const branding = deferred();
  const activeTabRef = { current: "messages" };
  const capture = { current: null };
  let loads = 0;
  let accountResets = 0;
  const stableProps = {
    userId: "user-a",
    role: "client",
    activeTabRef,
    loadBrandingFn: () => { loads += 1; return branding.promise; },
    onAccountTransition: () => { accountResets += 1; },
    presenceProps: baseProps({ enabled: false }),
  };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(AccountBrandingHarness, { ...stableProps, capture, authEvent: 1 }));
    await Promise.resolve();
  });
  await act(async () => {
    renderer.update(React.createElement(AccountBrandingHarness, { ...stableProps, capture, authEvent: 2 }));
    await Promise.resolve();
  });

  assert.equal(loads, 1);
  assert.equal(accountResets, 0);
  assert.equal(activeTabRef.current, "messages");
  await act(async () => renderer.unmount());
});

test("mounted account switch never commits the previous account's message bodies", async () => {
  const reads = { "user-a:client-a": deferred(), "user-b:client-b": deferred() };
  const props = baseProps({
    listMessagesFn: ({ messageKey }) => reads[messageKey].promise,
  });
  const mounted = await mount(props, { strict: true });

  const nextProps = {
    ...props,
    messageKey: "user-b:client-b",
    clientId: "client-b",
  };
  await mounted.update(nextProps);
  await act(async () => {
    reads["user-a:client-a"].resolve([message(OLD_ID, "account A private body")]);
    await Promise.resolve();
  });
  assert.deepEqual(mounted.capture.current.rows, []);
  assert.notEqual(mounted.capture.current.rows[0]?.body, "account A private body");

  await act(async () => {
    reads["user-b:client-b"].resolve([message(OTHER_ID, "account B body")]);
    await Promise.resolve();
  });
  assert.equal(mounted.capture.current.rows[0]?.body, "account B body");
  await mounted.unmount();
});

test("effect cleanup and remount invalidate work from the discarded mount", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const props = baseProps({
    listMessagesFn: () => (++calls === 1 ? first.promise : second.promise),
  });
  const discarded = await mount(props, { strict: false });
  await discarded.unmount();
  const current = await mount(props, { strict: false });

  await act(async () => {
    first.resolve([message(OLD_ID, "discarded mount body")]);
    await Promise.resolve();
  });
  assert.equal(props.storage.writes.some(({ value }) => value.includes(OLD_ID)), false);

  await act(async () => {
    second.resolve([message(NEW_ID, "current mount body")]);
    await Promise.resolve();
  });
  assert.equal(current.capture.current.rows[0]?.body, "current mount body");
  assert.notEqual(current.capture.current.rows[0]?.body, "discarded mount body");
  assert.equal(readMessageLastSeen(props.storage, props.messageKey)?.id, NEW_ID);
  await current.unmount();
});

test("leaving Messages before a delayed response resolves does not advance last seen", async () => {
  const read = deferred();
  const storage = storageFixture();
  const key = "user-a:client-a";
  writeMessageLastSeen(storage, key, oldCursor);
  const activeTabRef = { current: "messages" };
  const props = baseProps({
    messageKey: key,
    storage,
    activeTabRef,
    listMessagesFn: () => read.promise,
    latestCoachCursorFn: async () => ({ sentAt: "2026-08-21T11:00:00.000Z", id: NEW_ID }),
    countUnreadFn: async () => 1,
  });
  const mounted = await mount(props, { strict: false });
  activeTabRef.current = "program";
  await act(async () => {
    read.resolve([message(NEW_ID, "new unread")]);
    await Promise.resolve();
  });

  assert.equal(mounted.capture.current.unreadCount, 1);
  assert.deepEqual(readMessageLastSeen(storage, key), oldCursor);
  await mounted.unmount();
});

test("Messages marks seen through a complete short thread and retains a concurrent newer unread", async () => {
  const read = deferred();
  const storage = storageFixture();
  const key = "user-a:client-a";
  writeMessageLastSeen(storage, key, oldCursor);
  const props = baseProps({
    messageKey: key,
    storage,
    activeTabRef: { current: "messages" },
    listMessagesFn: () => read.promise,
    latestCoachCursorFn: async () => ({ sentAt: "2026-08-21T12:00:00.000Z", id: OTHER_ID }),
    countUnreadFn: async () => 2,
  });
  const mounted = await mount(props, { strict: false });
  await act(async () => {
    read.resolve([message(NEW_ID, "visible in thread")]);
    await Promise.resolve();
  });

  assert.deepEqual(readMessageLastSeen(storage, key), {
    sentAt: "2026-08-21T11:00:00.000Z",
    id: NEW_ID,
  });
  assert.notEqual(readMessageLastSeen(storage, key).id, OTHER_ID);
  assert.equal(mounted.capture.current.unreadCount, 1);
  await mounted.unmount();
});

test("first load cannot seed beyond the coach rows returned by the thread read", async () => {
  const read = deferred();
  const storage = storageFixture();
  const key = "user-a:client-a";
  const props = baseProps({
    messageKey: key,
    storage,
    activeTabRef: { current: "messages" },
    listMessagesFn: () => read.promise,
    latestCoachCursorFn: async () => ({ sentAt: "2026-08-21T12:00:00.000Z", id: OTHER_ID }),
  });
  const mounted = await mount(props, { strict: false });
  await act(async () => {
    read.resolve([message(NEW_ID, "first returned row")]);
    await Promise.resolve();
  });

  assert.deepEqual(readMessageLastSeen(storage, key), {
    sentAt: "2026-08-21T11:00:00.000Z",
    id: NEW_ID,
  });
  assert.equal(mounted.capture.current.unreadCount, 1);
  await mounted.unmount();
});

test("empty first-load rows seed before an externally confirmed coach message", async () => {
  const storage = storageFixture();
  const key = "user-a:client-a";
  const externalCursor = {
    sentAt: new Date(Date.now() - 1000).toISOString(),
    id: OTHER_ID,
  };
  const props = baseProps({
    messageKey: key,
    storage,
    activeTabRef: { current: "messages" },
    listMessagesFn: async () => [],
    latestCoachCursorFn: async () => externalCursor,
  });
  const mounted = await mount(props, { strict: false });
  await act(async () => { await Promise.resolve(); });

  const persisted = readMessageLastSeen(storage, key);
  assert.ok(Date.parse(persisted.sentAt) < Date.parse(externalCursor.sentAt));
  assert.equal(mounted.capture.current.unreadCount, 1);
  await mounted.unmount();
});

test("a forced post-send refresh supersedes an older in-flight read", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const props = baseProps({
    listMessagesFn: () => (++calls === 1 ? first.promise : second.promise),
  });
  const mounted = await mount(props, { strict: false });
  let forced;
  await act(async () => {
    forced = mounted.capture.current.refreshMessages({ force: true });
    await Promise.resolve();
  });
  await act(async () => {
    second.resolve([message(NEW_ID, "new response")]);
    await forced;
  });
  assert.equal(mounted.capture.current.rows[0]?.body, "new response");

  await act(async () => {
    first.resolve([message(OLD_ID, "stale response")]);
    await Promise.resolve();
  });
  assert.equal(mounted.capture.current.rows[0]?.body, "new response");
  await mounted.unmount();
});

test("ancillary presence failures do not hide a successfully loaded thread", async () => {
  const storage = storageFixture();
  const key = "user-a:client-a";
  writeMessageLastSeen(storage, key, oldCursor);
  const errors = [];
  const props = baseProps({
    messageKey: key,
    storage,
    listMessagesFn: async () => [message(NEW_ID, "thread still loads")],
    latestCoachCursorFn: () => { throw new Error("cursor unavailable"); },
    countUnreadFn: () => { throw new Error("count unavailable"); },
    onPresenceError: (label) => errors.push(label),
  });
  const mounted = await mount(props, { strict: false });
  await act(async () => { await Promise.resolve(); });

  assert.equal(mounted.capture.current.loadState, "ready");
  assert.equal(mounted.capture.current.rows[0]?.body, "thread still loads");
  assert.equal(mounted.capture.current.unreadCount, 1);
  assert.deepEqual(errors.sort(), ["exact unread count failed", "latest coach message cursor failed"]);
  await mounted.unmount();
});

test("legacy timestamp migration does not recount the message at the seen timestamp", async () => {
  const storage = storageFixture();
  const key = "user-a:client-a";
  storage.setItem(key, oldCursor.sentAt);
  let countedFilterCursor = null;
  const props = baseProps({
    messageKey: key,
    storage,
    listMessagesFn: async () => [message(OLD_ID, "already seen", oldCursor.sentAt)],
    latestCoachCursorFn: async () => oldCursor,
    countUnreadFn: async (seen) => {
      countedFilterCursor = seen;
      return 0;
    },
  });
  const mounted = await mount(props, { strict: false });
  await act(async () => { await Promise.resolve(); });

  assert.deepEqual(countedFilterCursor, { sentAt: oldCursor.sentAt, id: "" });
  assert.equal(mounted.capture.current.unreadCount, 0);
  await mounted.unmount();
});
