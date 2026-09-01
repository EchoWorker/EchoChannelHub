/**
 * outbound-queue.test.ts — unit tests for the serial paced retry queue.
 *
 * Uses a fake clock: `now()` reads a counter that `sleep(ms)` advances, then
 * yields a microtask so the drain loop can make progress. This makes pacing /
 * backoff deterministic without real timers.
 *
 * Run: node --test dist/outbound-queue.test.js   (after build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { OutboundQueue } from "./outbound-queue.js";

/** Fake clock: sleep advances a virtual `now` and yields to the event loop. */
function fakeClock() {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
      // Yield repeatedly so chained awaits in the drain loop settle.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    sleeps,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

test("OutboundQueue: preserves FIFO order", async () => {
  const clock = fakeClock();
  const order: number[] = [];
  const q = new OutboundQueue({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 5; i++) {
    q.enqueue(async () => {
      order.push(i);
    }, `t${i}`);
  }
  await q.onIdle();

  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test("OutboundQueue: paces sends by at least minIntervalMs", async () => {
  const clock = fakeClock();
  const startTimes: number[] = [];
  const q = new OutboundQueue({ minIntervalMs: 1500, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 3; i++) {
    q.enqueue(async () => {
      startTimes.push(clock.now());
    }, `t${i}`);
  }
  await q.onIdle();

  assert.equal(startTimes.length, 3);
  // First send immediate; each subsequent gap ≥ 1500ms (fake clock).
  assert.ok(startTimes[1] - startTimes[0] >= 1500, `gap0=${startTimes[1] - startTimes[0]}`);
  assert.ok(startTimes[2] - startTimes[1] >= 1500, `gap1=${startTimes[2] - startTimes[1]}`);
});

test("OutboundQueue: retries a retryable failure then succeeds (no loss)", async () => {
  const clock = fakeClock();
  let attempts = 0;
  let delivered = false;
  const errors: string[] = [];
  const q = new OutboundQueue({
    minIntervalMs: 0,
    backoffBaseMs: 100,
    isRetryable: () => true,
    onError: (m) => errors.push(m),
    now: clock.now,
    sleep: clock.sleep,
  });

  q.enqueue(async () => {
    attempts++;
    if (attempts < 3) throw new Error("rate limited");
    delivered = true;
  }, "flaky");
  await q.onIdle();

  assert.equal(attempts, 3, "should retry until success");
  assert.equal(delivered, true, "message delivered, not dropped");
  assert.equal(errors.length, 0, "no give-up error on eventual success");
});

test("OutboundQueue: gives up after maxRetries and logs exactly once", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const errors: string[] = [];
  const q = new OutboundQueue({
    minIntervalMs: 0,
    maxRetries: 3,
    backoffBaseMs: 100,
    isRetryable: () => true,
    onError: (m) => errors.push(m),
    now: clock.now,
    sleep: clock.sleep,
  });

  q.enqueue(async () => {
    attempts++;
    throw new Error("rate limited forever");
  }, "doomed");
  await q.onIdle();

  // initial try + 3 retries = 4 attempts
  assert.equal(attempts, 4, `attempts=${attempts}`);
  assert.equal(errors.length, 1, "loud failure exactly once (never silent)");
  assert.match(errors[0], /gave up/);
});

test("OutboundQueue: drops a non-retryable failure immediately and continues", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const errors: string[] = [];
  const after: string[] = [];
  const q = new OutboundQueue({
    minIntervalMs: 0,
    isRetryable: () => false,
    onError: (m) => errors.push(m),
    now: clock.now,
    sleep: clock.sleep,
  });

  q.enqueue(async () => {
    attempts++;
    throw new Error("non-retryable");
  }, "bad");
  q.enqueue(async () => {
    after.push("next ran");
  }, "good");
  await q.onIdle();

  assert.equal(attempts, 1, "no retries for non-retryable");
  assert.equal(errors.length, 1, "logged loudly once");
  assert.match(errors[0], /non-retryable/);
  assert.deepEqual(after, ["next ran"], "queue keeps draining after a drop");
});

test("OutboundQueue: rejects tasks past maxPending loudly", async () => {
  const clock = fakeClock();
  const drops: string[] = [];
  const q = new OutboundQueue({
    minIntervalMs: 1000,
    maxPending: 1,
    now: clock.now,
    sleep: clock.sleep,
    onDrop: (m) => drops.push(m),
  });
  let release!: () => void;
  q.enqueue(async () => new Promise<void>((resolve) => { release = resolve; }), "in-flight");
  await Promise.resolve();
  q.enqueue(async () => {}, "queued");
  q.enqueue(async () => {}, "overflow");
  assert.equal(q.pending, 1);
  assert.equal(drops.length, 1);
  assert.match(drops[0], /overflow.*1 tasks/);
  release();
  await q.onIdle();
});
test("OutboundQueue: stop() halts draining and clears the queue", async () => {
  const clock = fakeClock();
  const ran: number[] = [];
  const q = new OutboundQueue({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

  q.enqueue(async () => {
    ran.push(0);
  });
  q.enqueue(async () => {
    ran.push(1);
  });
  q.stop();
  await q.onIdle();

  // After stop, the queue is cleared; nothing new starts. (The first task may
  // or may not have begun, but no further tasks run and pending is 0.)
  assert.equal(q.pending, 0);
});
