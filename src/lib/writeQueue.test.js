import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedWriteQueue } from "./writeQueue.js";

// Deferred helper: lets a test start a task and resolve/reject it on its own
// schedule, so ordering can be forced deterministically instead of hoping timers
// land in a particular order.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("two writes for the same key run strictly in call order, even when the first is slower", async () => {
  const queue = createKeyedWriteQueue();
  const started = [];
  const finished = [];
  const first = deferred();

  const p1 = queue.enqueue("set:0", async () => {
    started.push("A");
    await first.promise;
    finished.push("A");
    return "A";
  });
  const p2 = queue.enqueue("set:0", async () => {
    started.push("B");
    finished.push("B");
    return "B";
  });

  // B must not even START until A settles — that's the whole point: A's slow
  // network call cannot be overtaken by B's fast one.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ["A"]);

  first.resolve();
  assert.equal(await p1, "A");
  assert.equal(await p2, "B");
  assert.deepEqual(started, ["A", "B"]);
  assert.deepEqual(finished, ["A", "B"]);
});

test("a failed write does not block or skip the write queued behind it", async () => {
  const queue = createKeyedWriteQueue();
  const order = [];

  const p1 = queue.enqueue("k", async () => {
    order.push("A-start");
    throw new Error("network blip");
  });
  const p2 = queue.enqueue("k", async () => {
    order.push("B-start");
    return "ok";
  });

  await assert.rejects(p1, /network blip/);
  assert.equal(await p2, "ok");
  assert.deepEqual(order, ["A-start", "B-start"]);
});

test("writes under different keys do not block each other", async () => {
  const queue = createKeyedWriteQueue();
  const slow = deferred();
  const order = [];

  const pSlow = queue.enqueue("set:0", async () => {
    order.push("slow-start");
    await slow.promise;
    order.push("slow-end");
  });
  const pFast = queue.enqueue("set:1", async () => {
    order.push("fast-start-and-end");
  });

  // The fast write (different key) must resolve without waiting for the slow one —
  // it is not blocked behind an unrelated key's in-flight write.
  await pFast;
  assert.ok(order.includes("fast-start-and-end"));
  assert.ok(!order.includes("slow-end"), "slow write must not have finished yet");
  slow.resolve();
  await pSlow;
  assert.deepEqual(order.filter((e) => e.startsWith("slow")), ["slow-start", "slow-end"]);
});

test("three queued writes for one key still run in strict call order", async () => {
  const queue = createKeyedWriteQueue();
  const order = [];
  const gates = [deferred(), deferred(), deferred()];

  const tasks = [0, 1, 2].map((i) =>
    queue.enqueue("k", async () => {
      order.push(`start-${i}`);
      await gates[i].promise;
      order.push(`end-${i}`);
    }),
  );

  // Release out of order — the queue's own serialization, not resolution order,
  // must determine execution order.
  gates[2].resolve();
  gates[1].resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["start-0"]); // 1 and 2 haven't started — still behind 0

  gates[0].resolve();
  await Promise.all(tasks);
  assert.deepEqual(order, ["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"]);
});
