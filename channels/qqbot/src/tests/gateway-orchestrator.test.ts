import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { QQGatewayOrchestrator, parseQQSessionKey, qqSessionKey, type QQClient, type QQInboundMessage } from "../bridge/orchestrator.js";

class FakeGateway {
  submits: Array<{ session: string; content: string; options: unknown }> = [];
  async submit(session: string, content: string, options: unknown) {
    this.submits.push({ session, content, options });
    return { sessionKey: session, turnId: `turn-${this.submits.length}`, started: true };
  }
}

function fakeQQ(): QQClient & { sent: Array<{ context: unknown; text?: string; media?: string }> } {
  const sent: Array<{ context: unknown; text?: string; media?: string }> = [];
  return { sent, start: async () => undefined, stop: async () => undefined,
    sendText: async (context, text) => { sent.push({ context, text }); },
    sendMedia: async (context, media) => { sent.push({ context, media }); } };
}

function inbound(eventId: string, scope: "c2c" | "group", targetId: string): QQInboundMessage {
  return { eventId, msgId: `msg-${eventId}`, scope, targetId, text: eventId };
}

test("session keys are deterministic, reversible, and scope-separated", () => {
  const c2c = qqSessionKey("profile", "c2c", "user:a");
  assert.deepEqual(parseQQSessionKey(c2c), { profileId: "profile", scope: "c2c", targetId: "user:a" });
  assert.notEqual(c2c, qqSessionKey("profile", "group", "user:a"));
  assert.equal(parseQQSessionKey("wechat:x"), null);
});

test("interleaved turns remain pinned to immutable QQ reply contexts", async () => {
  const gateway = new FakeGateway(); const qq = fakeQQ(); const claimed = new Set<string>();
  const orchestrator = new QQGatewayOrchestrator({ profileId: "p", accountId: "a", qq, gateway,
    dedupe: { claim: (id) => !claimed.has(id) && !!claimed.add(id), rollback: (id) => { claimed.delete(id); } },
    replyBudget: { reserve: (ctx) => ({ ctx }), commit: () => undefined, rollback: () => undefined } });
  await orchestrator.handleInbound(inbound("one", "c2c", "user-1"));
  await orchestrator.handleInbound(inbound("two", "group", "group-2"));
  await orchestrator.handleInbound(inbound("one", "c2c", "user-1"));
  assert.equal(gateway.submits.length, 2, "duplicate event must not reach EchoAI");
  await orchestrator.onGatewayReply({ sessionKey: gateway.submits[1].session, turnId: "turn-2", text: "reply two" });
  await orchestrator.onGatewayReply({ sessionKey: gateway.submits[0].session, turnId: "turn-1", text: "reply one" });
  assert.deepEqual(qq.sent.map((item) => [(item.context as {targetId:string}).targetId, item.text]), [["group-2", "reply two"], ["user-1", "reply one"]]);
});

test("reply budget commits only after send and rolls back failures", async () => {
  const gateway = new FakeGateway(); const qq = fakeQQ(); const calls: string[] = [];
  let fail = true; qq.sendText = async () => { if (fail) throw new Error("qq failed"); };
  const orchestrator = new QQGatewayOrchestrator({ profileId: "p", accountId: "a", qq, gateway,
    dedupe: { claim: () => true }, replyBudget: { reserve: () => { calls.push("reserve"); return {}; }, commit: () => { calls.push("commit"); }, rollback: () => { calls.push("rollback"); } } });
  await orchestrator.handleInbound(inbound("one", "c2c", "u"));
  await assert.rejects(orchestrator.onGatewayReply({ sessionKey: gateway.submits[0].session, turnId: "turn-1", text: "x" }), /qq failed/);
  assert.deepEqual(calls, ["reserve", "rollback"]);
  fail = false; await orchestrator.onGatewayReply({ sessionKey: gateway.submits[0].session, turnId: "turn-1", text: "x" });
  assert.deepEqual(calls, ["reserve", "rollback", "reserve", "commit"]);
});
