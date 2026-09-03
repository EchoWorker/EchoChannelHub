import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { QQClient, QQMiddleware } from "../qq/client.js";
import { parseTarget } from "../qq/target.js";
import { ReplyBudget } from "../qq/reply-budget.js";
import { QQOutbound } from "../qq/outbound.js";
import { EventDedupe } from "../storage/event-dedupe.js";
import { installInboundPipeline } from "../qq/middleware.js";

function fakeClient(fail = false): QQClient & { middlewares: QQMiddleware[]; sent: unknown[] } {
  const middlewares: QQMiddleware[] = []; const sent: unknown[] = [];
  return { middlewares, sent, use: (m) => { middlewares.push(m); }, on: () => undefined,
    start: async () => undefined, stop: async () => undefined,
    sendText: async (target, text) => { sent.push({ target, text }); if (fail) throw new Error("API failed"); return { id: "ok" }; },
    sendImage: async () => ({ id: "image" }) };
}

test("targets only accept c2c and group and fail loudly", () => {
  assert.deepEqual(parseTarget("c2c:user"), { scope: "c2c", targetId: "user" });
  assert.throws(() => parseTarget("channel:x"), /Unsupported/);
  assert.throws(() => parseTarget("bad"), /Invalid/);
});

test("reply budget reserves sequences and rolls API failures back", async () => {
  const budget = new ReplyBudget({ maxReplies: 1 });
  const bad = new QQOutbound(fakeClient(true), budget);
  await assert.rejects(bad.sendText({ scope: "c2c", targetId: "u" }, "x", { scene: "s", msgId: "m" }));
  const client = fakeClient();
  await new QQOutbound(client, budget).sendText({ scope: "c2c", targetId: "u" }, "ok", { scene: "s", msgId: "m" });
  assert.deepEqual((client.sent[0] as {target: object}).target, { scope: "c2c", targetId: "u", msgId: "m", msgSeq: 1 });
  assert.throws(() => budget.reserve("s", "m"), /exhausted/);
});

test("dedupe persists committed bounded entries and rolls reservations back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qq-dedupe-")); const file = join(dir, "d.json");
  try {
    const one = new EventDedupe({ file, maxEntries: 1 }); await one.load();
    assert.equal(one.reserve("a"), true); one.rollback("a"); assert.equal(one.reserve("a"), true); await one.commit("a");
    assert.equal(one.reserve("b"), true); await one.commit("b");
    const two = new EventDedupe({ file, maxEntries: 1 }); await two.load();
    assert.equal(two.has("a"), false); assert.equal(two.has("b"), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pipeline installs required middleware in security order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qq-pipeline-"));
  try {
    const client = fakeClient(); const dedupe = new EventDedupe({ file: join(dir, "d.json") });
    assert.deepEqual(installInboundPipeline(client, { dedupe, onMessage: async () => undefined }),
      ["error", "dedupe", "mention-gate", "sanitize", "rate-limit", "peer-serial"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
