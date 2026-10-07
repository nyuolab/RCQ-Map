import test from "node:test";
import assert from "node:assert/strict";
import { createSaveQueue, isRetryableSaveError } from "../lib/save-queue.js";

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await settle();
      }
      now = target;
      await settle();
    },
    pendingTimers: () => timers.size,
  };
}

// Let promise chains inside the queue run to completion.
async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function harness({ saveImpl } = {}) {
  const clock = fakeClock();
  const calls = [];
  const events = [];
  const controllers = [];
  const queue = createSaveQueue({
    debounceMs: 450,
    retryDelaysMs: [1000, 2000],
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    save: (key, snapshot) => {
      calls.push({ key, snapshot });
      if (saveImpl) return saveImpl(key, snapshot, calls.length);
      return new Promise((resolve, reject) => controllers.push({ key, snapshot, resolve, reject }));
    },
    onSaving: (key, info) => events.push({ type: "saving", key, version: info.version }),
    onSaved: (key, info) => events.push({ type: "saved", key, version: info.version, isLatest: info.isLatest, snapshot: info.snapshot }),
    onError: (key, error, info) => events.push({ type: "error", key, status: error?.status, retryable: info.retryable, attempt: info.attempt }),
  });
  return { clock, calls, events, controllers, queue };
}

test("debounces edits and sends only the latest snapshot", async () => {
  const { clock, calls, controllers, queue } = harness();
  queue.enqueue("q1", { v: 1 });
  await clock.advance(200);
  queue.enqueue("q1", { v: 2 });
  await clock.advance(200);
  queue.enqueue("q1", { v: 3 });
  assert.equal(calls.length, 0);
  await clock.advance(450);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].snapshot, { v: 3 });
  controllers[0].resolve({ ok: true });
  await settle();
  assert.deepEqual(queue.pendingKeys(), []);
});

test("an edit made while a save is in flight is not reported clean, and is sent afterwards", async () => {
  const { clock, calls, events, controllers, queue } = harness();
  queue.enqueue("q1", { fields: ["A"] });
  await clock.advance(450);
  assert.equal(calls.length, 1);

  // Edit B while PUT #1 is in flight, then PUT #1 returns.
  queue.enqueue("q1", { fields: ["A", "B"] });
  controllers[0].resolve({ ok: true, labels: ["A"] });
  await settle();

  const saved = events.filter((event) => event.type === "saved");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].isLatest, false, "stale response must not mark the record clean");
  assert.deepEqual(queue.pendingKeys(), ["q1"], "record stays pending until B is saved");
  assert.equal(calls.length, 1, "second save waits for the debounce, it is not fired eagerly");

  await clock.advance(450);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].snapshot, { fields: ["A", "B"] });
  controllers[1].resolve({ ok: true });
  await settle();
  assert.equal(events.filter((event) => event.type === "saved").at(-1).isLatest, true);
  assert.deepEqual(queue.pendingKeys(), []);
});

test("never has more than one request in flight per record, so commits cannot reorder", async () => {
  const { clock, calls, controllers, queue } = harness();
  queue.enqueue("q1", { v: 1 });
  await clock.advance(450);
  queue.enqueue("q1", { v: 2 });
  await clock.advance(450); // debounce for v2 elapses while v1 is still in flight
  queue.enqueue("q1", { v: 3 });
  await clock.advance(450);
  assert.equal(calls.length, 1, "v2/v3 must wait for v1 to finish");
  assert.equal(queue.inFlightCount(), 1);
  controllers[0].resolve({ ok: true });
  await settle();
  assert.equal(calls.length, 2, "one follow-up request carrying the newest snapshot");
  assert.deepEqual(calls[1].snapshot, { v: 3 });
  controllers[1].resolve({ ok: true });
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(queue.pendingKeys(), []);
});

test("different records save independently and concurrently", async () => {
  const { clock, calls, controllers, queue } = harness();
  queue.enqueue("q1", { v: 1 });
  queue.enqueue("q2", { v: 1 });
  await clock.advance(450);
  assert.equal(calls.length, 2);
  assert.equal(queue.inFlightCount(), 2);
  controllers[0].resolve({ ok: true });
  controllers[1].resolve({ ok: true });
  await settle();
  assert.deepEqual(queue.pendingKeys(), []);
});

test("retries transient failures with backoff and keeps the record pending until it succeeds", async () => {
  let attempt = 0;
  const { clock, calls, events, queue } = harness({
    saveImpl: async () => {
      attempt += 1;
      if (attempt < 3) {
        const error = new Error("Server error");
        error.status = 503;
        throw error;
      }
      return { ok: true };
    },
  });
  queue.enqueue("q1", { v: 1 });
  await clock.advance(450);
  assert.equal(calls.length, 1);
  assert.deepEqual(queue.pendingKeys(), ["q1"]);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).retryable, true);

  await clock.advance(999);
  assert.equal(calls.length, 1, "first retry waits the full backoff delay");
  await clock.advance(1);
  assert.equal(calls.length, 2);
  await clock.advance(2000);
  assert.equal(calls.length, 3);
  assert.equal(events.at(-1).type, "saved");
  assert.deepEqual(queue.pendingKeys(), []);
});

test("network failures without a status are retried", async () => {
  let attempt = 0;
  const { clock, calls, queue } = harness({
    saveImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return { ok: true };
    },
  });
  queue.enqueue("q1", { v: 1 });
  await clock.advance(450);
  assert.equal(calls.length, 1);
  await clock.advance(1000);
  assert.equal(calls.length, 2);
  assert.deepEqual(queue.pendingKeys(), []);
});

test("permanent failures are not retried but the record remains pending", async () => {
  const { clock, calls, events, queue } = harness({
    saveImpl: async () => {
      const error = new Error("This query is not assigned to this annotator.");
      error.status = 403;
      throw error;
    },
  });
  queue.enqueue("q1", { v: 1 });
  await clock.advance(450);
  assert.equal(calls.length, 1);
  await clock.advance(60_000);
  assert.equal(calls.length, 1, "403 must not be retried");
  assert.equal(events.at(-1).retryable, false);
  assert.deepEqual(queue.pendingKeys(), ["q1"]);
  assert.equal(clock.pendingTimers(), 0);
});

test("a fresh edit after a permanent failure is attempted again", async () => {
  let attempt = 0;
  const { clock, calls, queue } = harness({
    saveImpl: async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("Bad request");
        error.status = 400;
        throw error;
      }
      return { ok: true };
    },
  });
  queue.enqueue("q1", { v: 1 });
  await clock.advance(450);
  assert.equal(calls.length, 1);
  queue.enqueue("q1", { v: 2 });
  await clock.advance(450);
  assert.equal(calls.length, 2);
  assert.deepEqual(queue.pendingKeys(), []);
});

test("flushAll resends every pending record immediately and resets backoff", async () => {
  let fail = true;
  const { clock, calls, queue } = harness({
    saveImpl: async () => {
      if (fail) {
        const error = new Error("offline");
        throw error;
      }
      return { ok: true };
    },
  });
  queue.enqueue("q1", { v: 1 });
  queue.enqueue("q2", { v: 1 });
  await clock.advance(450);
  assert.equal(calls.length, 2);
  await clock.advance(1000);
  assert.equal(calls.length, 4);
  fail = false;
  queue.flushAll(); // e.g. browser came back online
  await settle();
  assert.equal(calls.length, 6);
  assert.deepEqual(queue.pendingKeys(), []);
  assert.equal(clock.pendingTimers(), 0);
});

test("immediate enqueue skips the debounce (used for recovered local records)", async () => {
  const { calls, controllers, queue } = harness();
  queue.enqueue("q1", { v: 1 }, { immediate: true });
  await settle();
  assert.equal(calls.length, 1);
  controllers[0].resolve({ ok: true });
  await settle();
  assert.deepEqual(queue.pendingKeys(), []);
});

test("cancel drops a record's pending save and timers", async () => {
  const { clock, calls, queue } = harness();
  queue.enqueue("q1", { v: 1 });
  queue.cancel("q1");
  await clock.advance(1000);
  assert.equal(calls.length, 0);
  assert.deepEqual(queue.pendingKeys(), []);
});

test("retryable error classification", () => {
  assert.equal(isRetryableSaveError(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryableSaveError(Object.assign(new Error(), { status: 500 })), true);
  assert.equal(isRetryableSaveError(Object.assign(new Error(), { status: 503 })), true);
  assert.equal(isRetryableSaveError(Object.assign(new Error(), { status: 429 })), true);
  assert.equal(isRetryableSaveError(Object.assign(new Error(), { status: 408 })), true);
  assert.equal(isRetryableSaveError(Object.assign(new Error(), { status: 400 })), false);
  assert.equal(isRetryableSaveError(Object.assign(new Error(), { status: 401 })), false);
  assert.equal(isRetryableSaveError(Object.assign(new Error(), { status: 403 })), false);
});
