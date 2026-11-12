// A tiny per-key write serializer. Two async writes to the SAME key (e.g. a
// weight/reps blur-save racing a Mark-done click-save for one workout set) must
// never have their network responses land on the server out of order — the older
// payload, if it lands last, silently wins and clobbers the newer one. This queue
// guarantees writes enqueued under one key run strictly one at a time, in call
// order, regardless of how long any individual write takes.
//
// Pure, dependency-free, and deliberately dumb: it does not know what a "write" is,
// only that it must run after every earlier write for the same key has settled —
// success or failure. A failed write never blocks or skips the writes queued behind
// it. See the implementation specification, Part A item 2 / finding
// B1.1. src/pages/Client.jsx's DayCard is the only current caller.
export function createKeyedWriteQueue() {
  const tails = new Map(); // key -> Promise (the tail of that key's chain)

  return {
    // Runs `task` once every write already queued under `key` has settled (however
    // it settled). Returns a promise that resolves/rejects with THIS task's own
    // outcome — the caller still sees its own write's success or failure — but the
    // NEXT enqueue for this key is never skipped just because this one failed.
    enqueue(key, task) {
      const prevTail = tails.get(key) ?? Promise.resolve();
      const run = prevTail.then(task, task);
      tails.set(key, run.catch(() => {}));
      return run;
    },
  };
}
