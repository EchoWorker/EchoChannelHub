/**
 * api-send.test.ts — proves sendMessage() surfaces rate-limit (ret=-2) instead
 * of swallowing it. Spins a throwaway HTTP server that returns a canned JSON
 * body for the sendmessage CGI.
 *
 * Run: node --test dist/api-send.test.js   (after build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sendMessage, WeixinSendError } from "./protocol/api/api.js";
import { MessageItemType, MessageType, MessageState } from "./protocol/api/types.js";

/** Start an HTTP server that replies to every POST with `body` (status 200). */
async function startServer(body: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    // Drain the request then reply.
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}/` };
}

function textBody() {
  return {
    msg: {
      from_user_id: "",
      to_user_id: "user123",
      client_id: "cid",
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hi" } }],
    },
  };
}

test("sendMessage: ret=-2 throws WeixinSendError with rateLimited=true", async () => {
  const { server, baseUrl } = await startServer(JSON.stringify({ ret: -2, errmsg: "rate limited" }));
  try {
    await assert.rejects(
      () => sendMessage({ baseUrl, token: "t", body: textBody() }),
      (err: unknown) => {
        assert.ok(err instanceof WeixinSendError, "is WeixinSendError");
        assert.equal(err.ret, -2);
        assert.equal(err.rateLimited, true);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("sendMessage: errmsg 'rate limited' without -2 still flags rateLimited", async () => {
  const { server, baseUrl } = await startServer(JSON.stringify({ ret: -99, errmsg: "Rate Limited" }));
  try {
    await assert.rejects(
      () => sendMessage({ baseUrl, token: "t", body: textBody() }),
      (err: unknown) => {
        assert.ok(err instanceof WeixinSendError);
        assert.equal(err.rateLimited, true);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("sendMessage: ret=-14 (session expired) throws non-retryable", async () => {
  const { server, baseUrl } = await startServer(JSON.stringify({ ret: -14, errmsg: "session expired" }));
  try {
    await assert.rejects(
      () => sendMessage({ baseUrl, token: "t", body: textBody() }),
      (err: unknown) => {
        assert.ok(err instanceof WeixinSendError);
        assert.equal(err.ret, -14);
        assert.equal(err.rateLimited, false);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("sendMessage: ret=0 resolves (happy path)", async () => {
  const { server, baseUrl } = await startServer(JSON.stringify({ ret: 0 }));
  try {
    await sendMessage({ baseUrl, token: "t", body: textBody() });
  } finally {
    server.close();
  }
});

test("sendMessage: empty object {} resolves (CGI success shape)", async () => {
  const { server, baseUrl } = await startServer("{}");
  try {
    await sendMessage({ baseUrl, token: "t", body: textBody() });
  } finally {
    server.close();
  }
});

test("sendMessage: empty body resolves (no false failure)", async () => {
  const { server, baseUrl } = await startServer("");
  try {
    await sendMessage({ baseUrl, token: "t", body: textBody() });
  } finally {
    server.close();
  }
});
