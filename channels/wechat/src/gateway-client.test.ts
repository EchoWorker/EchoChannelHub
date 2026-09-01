/**
 * gateway-client.test.ts — protocol conformance test for GatewayClient.
 *
 * Spins a mock EchoAI gateway (hand-rolled RFC6455 WS server, no deps), then:
 *   - asserts the client sends auth + plugin.connect{plugin_type:"channel",
 *     disable_questions:true, NO headless}
 *   - on chat.completions, asserts modes:['headless'] + optional model/workspace
 *     are forwarded; streams back token deltas then turn/end
 *   - asserts subagent_task_id deltas are NOT included in the accumulated reply
 *   - covers model.list (used by --model validation at startup)
 *
 * Run: node --test dist/gateway-client.test.js   (after build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

import { GatewayClient, type GatewayReply } from "./gateway-client.js";

function acceptKey(key: string): string {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function decodeFrame(buf: Buffer): string {
  const len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) off = 4;
  else if (len === 127) off = 10;
  const mask = buf.subarray(off, off + 4);
  off += 4;
  const data = buf.subarray(off);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i % 4];
  return out.toString("utf8");
}

function encodeFrame(str: string): Buffer {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, payload]);
}

type GatewayRequest = { method: string; params: Record<string, unknown> };

type MockGatewayOpts = {
  /** If set, replied to `model.list` with this. Otherwise model.list returns the default scaffold. */
  models?: { models: Array<{ id: string }>; default_model: string };
  /** If true, mock gateway streams reply on chat.completions (default). */
  streamReply?: boolean;
  /**
   * Custom chat.event sequence to stream on chat.completions, instead of the
   * default Hello-world script. Each item's `session_key` is injected
   * automatically. Use to exercise segmentation / error / status handling.
   */
  script?: Array<Record<string, unknown>>;
};

type MockGateway = {
  server: Server;
  url: string;
  /** All RPCs the gateway received, in order, with full params. */
  requests: GatewayRequest[];
  close: () => void;
};

async function startMockGateway(opts: MockGatewayOpts = {}): Promise<MockGateway> {
  const requests: GatewayRequest[] = [];
  const streamReply = opts.streamReply !== false;
  const server = createServer();

  server.on("upgrade", (req, socket: Socket) => {
    const key = req.headers["sec-websocket-key"] as string;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const send = (obj: unknown) => socket.write(encodeFrame(JSON.stringify(obj)));

    socket.on("data", (chunk: Buffer) => {
      let text: string;
      try {
        text = decodeFrame(chunk);
      } catch {
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      const method = msg.method as string;
      const id = msg.id as number;
      const params = (msg.params as Record<string, unknown>) ?? {};
      requests.push({ method, params });

      if (method === "auth") {
        send({ jsonrpc: "2.0", id, result: { ok: true } });
      } else if (method === "plugin.connect") {
        send({ jsonrpc: "2.0", id, result: { status: "connected" } });
      } else if (method === "model.list") {
        const payload = opts.models ?? {
          models: [{ id: "anthropic/claude-sonnet-4.6" }, { id: "openai/gpt-5.4" }],
          default_model: "anthropic/claude-sonnet-4.6",
        };
        send({ jsonrpc: "2.0", id, result: payload });
      } else if (method === "chat.completions") {
        const sk = params.session_key as string;
        send({ jsonrpc: "2.0", id, result: { session_key: sk, turn_id: "t1" } });
        if (opts.script) {
          for (const ev of opts.script) {
            send({ jsonrpc: "2.0", method: "chat.event", params: { ...ev, session_key: sk } });
          }
        } else if (streamReply) {
          // Stream: a subagent delta (must be ignored) + two main deltas, then end.
          send({ jsonrpc: "2.0", method: "chat.event", params: { type: "token", event: "append", content: "SUBAGENT", session_key: sk, subagent_task_id: "bg_1" } });
          send({ jsonrpc: "2.0", method: "chat.event", params: { type: "token", event: "append", content: "Hello ", session_key: sk } });
          send({ jsonrpc: "2.0", method: "chat.event", params: { type: "token", event: "append", content: "world", session_key: sk } });
          send({ jsonrpc: "2.0", method: "chat.event", params: { type: "turn", event: "end", turn_id: "t1", status: "done", session_key: sk } });
        }
      }
    });
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    url: `ws://127.0.0.1:${port}`,
    requests,
    close: () => server.close(),
  };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor: timed out");
}

// ── tests ────────────────────────────────────────────────────────────

test("GatewayClient: connect → submit → accumulate deltas → flush on turn end", async () => {
  const gw = await startMockGateway();
  const replies: Array<{ sessionKey: string; text: string }> = [];

  const client = new GatewayClient({
    url: gw.url,
    token: "test-token",
    pluginName: "channel.wechat.test",
    onReply: (r) => {
      replies.push(r);
    },
  });
  void client.start();
  await waitFor(() => gw.requests.some((r) => r.method === "plugin.connect"), 3000);

  // plugin.connect contract: register as channel, suppress questions, NO
  // headless (that flag is per-turn on chat.completions; setting it here
  // implies it works connection-wide which it doesn't).
  const connect = gw.requests.find((r) => r.method === "plugin.connect")!;
  assert.equal(connect.params.plugin_type, "channel");
  assert.equal(connect.params.disable_questions, true);
  assert.equal(connect.params.headless, undefined, "plugin.connect must NOT set headless");

  await client.submit("peer-1", "hi");
  await waitFor(() => replies.length > 0, 3000);

  // chat.completions contract: must set modes:['headless'] (no UI to answer
  // tool-approval / plan-review prompts).
  const chat = gw.requests.find((r) => r.method === "chat.completions")!;
  assert.equal(chat.params.session_key, "peer-1");
  assert.equal(chat.params.content, "hi");
  assert.deepEqual(chat.params.modes, ["headless"], "chat.completions must set modes:['headless']");
  // model/workspace not set when submitOpts is empty.
  assert.equal(chat.params.model, undefined);
  assert.equal(chat.params.workspace, undefined);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].sessionKey, "peer-1");
  assert.equal(replies[0].text, "Hello world", "subagent delta excluded, main deltas joined");

  client.close();
  gw.close();
});

test("GatewayClient: submit forwards model + workspace from submitOpts", async () => {
  const gw = await startMockGateway();
  const replies: Array<{ sessionKey: string; text: string }> = [];

  const client = new GatewayClient({
    url: gw.url,
    token: "test-token",
    pluginName: "channel.wechat.test",
    onReply: (r) => {
      replies.push(r);
    },
  });
  // Mimic Orchestrator wiring: per-call overrides are read off submitOpts.
  client.submitOpts = {
    model: "anthropic/claude-opus-4.7-1m",
    workspace: "/abs/path/to/proj",
  };

  void client.start();
  await waitFor(() => gw.requests.some((r) => r.method === "plugin.connect"), 3000);

  await client.submit("peer-1", "hi");
  await waitFor(() => replies.length > 0, 3000);

  const chat = gw.requests.find((r) => r.method === "chat.completions")!;
  assert.equal(chat.params.model, "anthropic/claude-opus-4.7-1m", "model passed through");
  assert.equal(chat.params.workspace, "/abs/path/to/proj", "workspace passed through");
  assert.deepEqual(chat.params.modes, ["headless"]);

  client.close();
  gw.close();
});

test("GatewayClient.listModels: returns gateway-provided model.list result", async () => {
  const customModels = {
    models: [
      { id: "openai/gpt-5.5" },
      { id: "anthropic/claude-opus-4.7" },
      // ill-formed entries should be filtered out.
      { id: "" },
      { id: undefined as unknown as string },
    ],
    default_model: "anthropic/claude-opus-4.7",
  };
  const gw = await startMockGateway({ models: customModels, streamReply: false });

  const client = new GatewayClient({
    url: gw.url,
    token: "test-token",
    pluginName: "channel.wechat.test",
    onReply: () => {},
  });
  void client.start();
  await client.waitConnected(3000);

  const result = await client.listModels();
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["openai/gpt-5.5", "anthropic/claude-opus-4.7"],
    "ill-formed entries filtered, order preserved",
  );
  assert.equal(result.default_model, "anthropic/claude-opus-4.7");

  client.close();
  gw.close();
});

test("GatewayClient: small adjacent segments are coalesced into one message", async () => {
  // EchoAI emits many small Step::Text segments (new message_id when prose
  // resumes after a tool call). To avoid flooding WeChat's rate limit, small
  // adjacent segments are merged into a single message (joined by a blank line).
  const gw = await startMockGateway({
    script: [
      { type: "token", event: "append", message_id: "m1", content: "First " },
      { type: "token", event: "append", message_id: "m1", content: "paragraph." },
      // tool call in between (ignored by the channel) → new message_id
      { type: "tool", event: "create", message_id: "x", tool: "bash", tool_call_id: "c1" },
      { type: "token", event: "append", message_id: "m2", content: "Second one." },
      { type: "turn", event: "end", turn_id: "t1", status: "done" },
    ],
  });
  const replies: GatewayReply[] = [];
  const client = new GatewayClient({
    url: gw.url,
    token: "t",
    pluginName: "channel.wechat.test",
    onReply: (r) => {
      replies.push(r);
    },
  });
  void client.start();
  await waitFor(() => gw.requests.some((r) => r.method === "plugin.connect"), 3000);
  await client.submit("peer-1", "hi");
  await waitFor(() => replies.length >= 1, 3000);
  // Give any (incorrect) extra replies a chance to arrive before asserting count.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(replies.length, 1, "small segments merged into one message");
  assert.equal(
    replies[0].text,
    "First paragraph.\n\nSecond one.",
    "merged with a blank-line boundary, no trim",
  );

  client.close();
  gw.close();
});

test("GatewayClient: a segment over the merge limit is delivered on its own", async () => {
  // Once the buffer reaches the soft limit (1200 chars), the next new
  // message_id flushes it as its own message instead of merging further.
  const big = "x".repeat(1300);
  const gw = await startMockGateway({
    script: [
      { type: "token", event: "append", message_id: "m1", content: big },
      { type: "token", event: "append", message_id: "m2", content: "tail" },
      { type: "turn", event: "end", turn_id: "t1", status: "done" },
    ],
  });
  const replies: GatewayReply[] = [];
  const client = new GatewayClient({
    url: gw.url,
    token: "t",
    pluginName: "channel.wechat.test",
    onReply: (r) => {
      replies.push(r);
    },
  });
  void client.start();
  await waitFor(() => gw.requests.some((r) => r.method === "plugin.connect"), 3000);
  await client.submit("peer-1", "hi");
  await waitFor(() => replies.length >= 2, 3000);

  assert.equal(replies.length, 2, "oversized segment split from the following one");
  assert.equal(replies[0].text, big, "the large segment is flushed on its own");
  assert.equal(replies[1].text, "tail", "the next segment becomes a fresh message");

  client.close();
  gw.close();
});

test("GatewayClient: error during turn flushes prior text then sends error notice", async () => {
  const gw = await startMockGateway({
    script: [
      { type: "token", event: "append", message_id: "m1", content: "Partial answer" },
      { type: "error", event: "raise", message: "llm 400 boom" },
      { type: "turn", event: "end", turn_id: "t1", status: "error" },
    ],
  });
  const replies: GatewayReply[] = [];
  const client = new GatewayClient({
    url: gw.url,
    token: "t",
    pluginName: "channel.wechat.test",
    onReply: (r) => {
      replies.push(r);
    },
  });
  void client.start();
  await waitFor(() => gw.requests.some((r) => r.method === "plugin.connect"), 3000);
  await client.submit("peer-1", "hi");
  await waitFor(() => replies.length >= 2, 3000);

  // First the accumulated text (flushed on error/raise), then a terminal error notice.
  assert.equal(replies[0].text, "Partial answer");
  assert.equal(replies[0].isError, undefined);
  const errReply = replies.find((r) => r.isError);
  assert.ok(errReply, "an isError reply is emitted");
  assert.equal(errReply!.text, "", "error notice carries no model text (orchestrator supplies wording)");

  client.close();
  gw.close();
});

test("GatewayClient: cancelled turn still delivers already-accumulated text", async () => {
  const gw = await startMockGateway({
    script: [
      { type: "token", event: "append", message_id: "m1", content: "Half a thought" },
      { type: "turn", event: "end", turn_id: "t1", status: "cancelled" },
    ],
  });
  const replies: GatewayReply[] = [];
  const client = new GatewayClient({
    url: gw.url,
    token: "t",
    pluginName: "channel.wechat.test",
    onReply: (r) => {
      replies.push(r);
    },
  });
  void client.start();
  await waitFor(() => gw.requests.some((r) => r.method === "plugin.connect"), 3000);
  await client.submit("peer-1", "hi");
  await waitFor(() => replies.length >= 1, 3000);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "Half a thought");
  assert.equal(replies[0].isError, undefined, "cancelled is not an error");

  client.close();
  gw.close();
});

test("GatewayClient: blank-only segment is not delivered", async () => {
  const gw = await startMockGateway({
    script: [
      { type: "token", event: "append", message_id: "m1", content: "   \n  " },
      { type: "turn", event: "end", turn_id: "t1", status: "done" },
    ],
  });
  const replies: GatewayReply[] = [];
  const client = new GatewayClient({
    url: gw.url,
    token: "t",
    pluginName: "channel.wechat.test",
    onReply: (r) => {
      replies.push(r);
    },
  });
  void client.start();
  await waitFor(() => gw.requests.some((r) => r.method === "plugin.connect"), 3000);
  await client.submit("peer-1", "hi");
  // give the stream time to arrive
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(replies.length, 0, "whitespace-only segment must not produce a message");

  client.close();
  gw.close();
});
