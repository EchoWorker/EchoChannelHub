import assert from "node:assert/strict";
import { test } from "node:test";

import { QQGatewayOrchestrator, qqSessionKey, type QQInboundMessage, type QQReplyContext } from "../src/bridge/orchestrator.js";
import type { GatewayReply, SubmitOptions, SubmitResult } from "../src/gateway/echoai-client.js";

class FakeQQ {
  handler?: (message: QQInboundMessage) => void | Promise<void>;
  sent: Array<{ context: QQReplyContext; text?: string; media?: string; allocation?: unknown }> = [];
  async start(handler: (message: QQInboundMessage) => void | Promise<void>): Promise<void> { this.handler = handler; }
  async stop(): Promise<void> {}
  async sendText(context: QQReplyContext, text: string, allocation?: unknown): Promise<void> { this.sent.push({ context, text, allocation }); }
  async sendMedia(context: QQReplyContext, media: string, allocation?: unknown): Promise<void> { this.sent.push({ context, media, allocation }); }
}

class FakeGateway {
  calls: Array<{ sessionKey: string; content: string; options: SubmitOptions }> = [];
  pending = new Map<string, (result: SubmitResult) => void>();
  submit(sessionKey: string, content: string, options: SubmitOptions): Promise<SubmitResult> {
    this.calls.push({ sessionKey, content, options });
    return new Promise((resolve) => this.pending.set(content, resolve));
  }
}

function fixture() {
  const qq = new FakeQQ();
  const gateway = new FakeGateway();
  const claimed = new Set<string>();
  const committed: unknown[] = [];
  const orchestrator = new QQGatewayOrchestrator({
    profileId: "work profile",
    accountId: "app-1",
    qq,
    gateway,
    dedupe: { claim: (id) => claimed.has(id) ? false : !!claimed.add(id) },
    replyBudget: {
      reserve: (context, kind) => ({ msgId: context.msgId, kind }),
      commit: (allocation) => { committed.push(allocation); },
    },
  });
  return { qq, gateway, orchestrator, committed };
}

const inbound = (eventId: string, msgId: string, scope: "c2c" | "group", targetId: string, text: string): QQInboundMessage =>
  ({ eventId, msgId, scope, targetId, text, receivedAt: 123 });

test("deterministic c2c/group session keys and event dedupe", async () => {
  assert.equal(qqSessionKey("work profile", "c2c", "user:1"), "qqbot:work%20profile:c2c:user%3A1");
  assert.equal(qqSessionKey("work profile", "group", "g1"), "qqbot:work%20profile:group:g1");
  const { orchestrator, gateway } = fixture();
  const message = inbound("event-1", "msg-1", "c2c", "user:1", "hello");
  const first = orchestrator.handleInbound(message);
  await Promise.resolve();
  const duplicate = orchestrator.handleInbound(message);
  gateway.pending.get("hello")!({ sessionKey: gateway.calls[0].sessionKey, turnId: "t1", started: true });
  await Promise.all([first, duplicate]);
  assert.equal(gateway.calls.length, 1);
});

test("interleaved turns retain immutable reply contexts", async () => {
  const { orchestrator, gateway, qq, committed } = fixture();
  const a = orchestrator.handleInbound(inbound("ea", "msg-a", "c2c", "alice", "A"));
  const b = orchestrator.handleInbound(inbound("eb", "msg-b", "group", "team", "B"));
  await Promise.resolve();
  const aSession = qqSessionKey("work profile", "c2c", "alice");
  const bSession = qqSessionKey("work profile", "group", "team");
  gateway.pending.get("B")!({ sessionKey: bSession, turnId: "turn-b", started: true });
  gateway.pending.get("A")!({ sessionKey: aSession, turnId: "turn-a", started: true });
  await Promise.all([a, b]);

  await Promise.all([
    orchestrator.onGatewayReply({ sessionKey: bSession, turnId: "turn-b", text: "reply B" }),
    orchestrator.onGatewayReply({ sessionKey: aSession, turnId: "turn-a", text: "reply A" }),
  ]);
  assert.deepEqual(qq.sent.map((s) => [s.context.targetId, s.context.msgId, s.text]).sort(), [
    ["alice", "msg-a", "reply A"],
    ["team", "msg-b", "reply B"],
  ]);
  assert.equal(committed.length, 2);
  assert.ok(Object.isFrozen(qq.sent[0].context));
});

test("event-before-completions response is held and media uses same turn context", async () => {
  const { orchestrator, gateway, qq } = fixture();
  const handling = orchestrator.handleInbound(inbound("e1", "original", "c2c", "alice", "ask"));
  await Promise.resolve();
  const sessionKey = qqSessionKey("work profile", "c2c", "alice");
  const early: GatewayReply = { sessionKey, turnId: "fast", text: "done", media: ["x.png"] };
  await orchestrator.onGatewayReply(early);
  assert.equal(qq.sent.length, 0);
  gateway.pending.get("ask")!({ sessionKey, turnId: "fast", started: true });
  await handling;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(qq.sent.map((s) => [s.context.msgId, s.text ?? s.media]), [
    ["original", "done"],
    ["original", "x.png"],
  ]);
});

test("plugin.message fallback is scoped to the latest context for its own session", async () => {
  const { orchestrator, gateway, qq } = fixture();
  const handling = orchestrator.handleInbound(inbound("e1", "m1", "group", "g", "hello"));
  await Promise.resolve();
  const sessionKey = qqSessionKey("work profile", "group", "g");
  gateway.pending.get("hello")!({ sessionKey, turnId: "t", started: true });
  await handling;
  await orchestrator.onGatewayReply({ sessionKey, text: "proactive" });
  await orchestrator.onGatewayReply({ sessionKey: "qqbot:other:group:g", text: "wrong profile" });
  assert.deepEqual(qq.sent.map((s) => s.text), ["proactive"]);
});
