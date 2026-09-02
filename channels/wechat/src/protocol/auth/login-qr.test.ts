import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWeixinAccountId, saveWeixinAccount } from "./accounts.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "./login-qr.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function withState(run: (requests: Array<{ url: string; body?: unknown }>) => Promise<void>): Promise<void> {
  const oldState = process.env.ECHO_WECHAT_STATE_DIR;
  const oldFetch = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-login-qr-"));
  const requests: Array<{ url: string; body?: unknown }> = [];
  process.env.ECHO_WECHAT_STATE_DIR = dir;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldState === undefined) delete process.env.ECHO_WECHAT_STATE_DIR;
    else process.env.ECHO_WECHAT_STATE_DIR = oldState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("add sends no local tokens and binded_redirect fails closed", { concurrency: false }, async () => withState(async (requests) => {
  saveWeixinAccount("existing-im-bot", { token: "existing-secret" });
  registerWeixinAccountId("existing-im-bot");
  let call = 0;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return call++ === 0
      ? json({ qrcode: "qr-1", qrcode_img_content: "https://example.test/qr-1" })
      : json({ status: "binded_redirect" });
  };

  const started = await startWeixinLoginWithQr({ mode: "add", accountId: "new-slot", apiBaseUrl: "https://ignored.test", force: true });
  assert.deepEqual(requests[0].body, { local_token_list: [] });
  const result = await waitForWeixinLogin({ sessionKey: started.sessionKey, apiBaseUrl: "https://ignored.test" });
  assert.equal(result.connected, false);
  assert.equal(result.alreadyConnected, undefined);
  assert.match(result.message, /新增模式不会复用/);
}));

test("restore sends only the selected token and reuses it after a healthy binded_redirect", { concurrency: false }, async () => withState(async (requests) => {
  saveWeixinAccount("selected-im-bot", { token: "selected-secret", baseUrl: "https://account.test", userId: "selected-user" });
  registerWeixinAccountId("selected-im-bot");
  saveWeixinAccount("other-im-bot", { token: "other-secret" });
  registerWeixinAccountId("other-im-bot");
  let call = 0;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    call++;
    if (call === 1) return json({ qrcode: "qr-1", qrcode_img_content: "https://example.test/qr-1" });
    if (call === 2) return json({ status: "binded_redirect" });
    return json({ ret: 0 });
  };

  const started = await startWeixinLoginWithQr({ mode: "restore", accountId: "selected-im-bot", apiBaseUrl: "https://ignored.test", force: true });
  assert.deepEqual(requests[0].body, { local_token_list: ["selected-secret"] });
  const result = await waitForWeixinLogin({ sessionKey: started.sessionKey, apiBaseUrl: "https://ignored.test" });
  assert.equal(result.connected, true);
  assert.equal(result.alreadyConnected, true);
  assert.equal(result.accountId, "selected-im-bot");
  assert.equal(result.botToken, "selected-secret");
  assert.match(requests[2].url, /^https:\/\/account\.test\/ilink\/bot\/getconfig/);
  assert.equal((requests[2] as { body?: unknown }).body !== undefined, true);
}));

test("restore binded_redirect fails when selected candidate is unhealthy", { concurrency: false }, async () => withState(async () => {
  saveWeixinAccount("selected-im-bot", { token: "selected-secret", userId: "selected-user" });
  registerWeixinAccountId("selected-im-bot");
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return json({ qrcode: "qr-1", qrcode_img_content: "https://example.test/qr-1" });
    if (call === 2) return json({ status: "binded_redirect" });
    return json({ ret: -14, errmsg: "invalid token" });
  };

  const started = await startWeixinLoginWithQr({ mode: "restore", accountId: "selected-im-bot", apiBaseUrl: "https://ignored.test", force: true });
  const result = await waitForWeixinLogin({ sessionKey: started.sessionKey, apiBaseUrl: "https://ignored.test" });
  assert.equal(result.connected, false);
  assert.match(result.message, /健康检查失败/);
}));

test("QR refresh preserves the restore candidate", { concurrency: false }, async () => withState(async (requests) => {
  saveWeixinAccount("selected-im-bot", { token: "selected-secret", userId: "selected-user" });
  registerWeixinAccountId("selected-im-bot");
  let call = 0;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    call++;
    if (call === 1) return json({ qrcode: "qr-1", qrcode_img_content: "https://example.test/qr-1" });
    if (call === 2) return json({ status: "expired" });
    if (call === 3) return json({ qrcode: "qr-2", qrcode_img_content: "https://example.test/qr-2" });
    if (call === 4) return json({ status: "binded_redirect" });
    return json({ ret: 0 });
  };

  const started = await startWeixinLoginWithQr({ mode: "restore", accountId: "selected-im-bot", apiBaseUrl: "https://ignored.test", force: true });
  const result = await waitForWeixinLogin({ sessionKey: started.sessionKey, apiBaseUrl: "https://ignored.test" });
  assert.equal(result.connected, true);
  assert.deepEqual(requests[0].body, { local_token_list: ["selected-secret"] });
  assert.deepEqual(requests[2].body, { local_token_list: ["selected-secret"] });
}));
