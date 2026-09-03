import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { startSetupServer } from "../setup/loopback-server.js";
import { renderSetupPage } from "../setup/page.js";
import { listProfileIds, loadProfile, profileIdForAppId, resolveProfileIndexPath, resolveProfilePath, restoreProfile, saveProfile } from "../profile/store.js";

function request(url: URL, options: { method?: string; host?: string; type?: string; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers.Host = options.host;
    if (options.type !== undefined) headers["Content-Type"] = options.type;
    const req = http.request({ hostname: "127.0.0.1", port: url.port, path: url.pathname, method: options.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test("setup page script is valid and never contains submitted credentials", () => {
  const page = renderSetupPage();
  const script = page.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(page, /type="password"/);
});

test("loopback setup uses a capability URL and strict HTTP protections", async () => {
  const received: Array<{ appId: string; appSecret: string }> = [];
  const server = await startSetupServer((credentials) => { received.push(credentials); });
  const url = new URL(server.url);
  try {
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.pathname, /^\/setup\/[A-Za-z0-9_-]{43}$/);
    const page = await fetch(server.url);
    const pageText = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.doesNotMatch(pageText, /test-secret-value/);
    assert.equal((await fetch(`${url.origin}/`)).status, 404);
    assert.equal((await fetch(`${server.url}?x=1`)).status, 404);
    for (const host of ["localhost", `localhost:${url.port}`, `127.0.0.1:${url.port}.example`]) {
      assert.equal((await request(url, { host })).status, 400);
    }
    assert.equal((await request(url, { host: `127.0.0.1:${url.port}` })).status, 200);

    const verifyUrl = new URL(`${server.url}/verify`);
    const statusUrl = new URL(`${server.url}/status`);
    const cancelUrl = new URL(`${server.url}/cancel`);
    assert.equal((await request(statusUrl, { host: `127.0.0.1:${url.port}` })).status, 200);
    assert.equal((await request(cancelUrl, { method: "POST", type: "application/json", body: "{}" })).status, 204);
    for (const type of [undefined, "text/plain", "application/json; charset=utf-8", "Application/JSON"]) {
      assert.equal((await request(verifyUrl, { method: "POST", type, body: "{}" })).status, 415);
    }
    for (const body of ["", "null", "[]", "{}", "{", '{"appId":"1"}', '{"appId":"1","appSecret":"s","extra":1}']) {
      assert.equal((await request(verifyUrl, { method: "POST", type: "application/json", body })).status, 400);
    }
    assert.equal((await request(verifyUrl, { method: "POST", type: "application/json", body: " ".repeat(4097) })).status, 400);
    const secret = "test-secret-value";
    const valid = await request(verifyUrl, { method: "POST", type: "application/json", body: JSON.stringify({ appId: "123456", appSecret: secret }) });
    assert.equal(valid.status, 204);
    assert.doesNotMatch(valid.body, new RegExp(secret));
    assert.deepEqual(received, [{ appId: "123456", appSecret: secret }]);
  } finally {
    await server.close();
  }
});

test("profile and index are atomic 0600, stable, and restore does not rewrite", (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-profile-"));
  const previous = process.env.ECHO_QQBOT_STATE_DIR;
  process.env.ECHO_QQBOT_STATE_DIR = state;
  t.after(() => {
    if (previous === undefined) delete process.env.ECHO_QQBOT_STATE_DIR;
    else process.env.ECHO_QQBOT_STATE_DIR = previous;
    fs.rmSync(state, { recursive: true, force: true });
  });

  const profile = saveProfile(" 123456 ", " test-secret-value ");
  assert.equal(profile.profileId, profileIdForAppId("123456"));
  assert.deepEqual(listProfileIds(), [profile.profileId]);
  assert.deepEqual(loadProfile(profile.profileId), profile);
  const profilePath = resolveProfilePath(profile.profileId);
  const indexPath = resolveProfileIndexPath();
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(profilePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(path.dirname(profilePath)).some((name) => name.endsWith(".tmp")), false);
  const profileBefore = fs.readFileSync(profilePath);
  const indexBefore = fs.readFileSync(indexPath);
  const profileTime = fs.statSync(profilePath).mtimeMs;
  const indexTime = fs.statSync(indexPath).mtimeMs;
  assert.deepEqual(restoreProfile(profile.profileId), profile);
  assert.deepEqual(fs.readFileSync(profilePath), profileBefore);
  assert.deepEqual(fs.readFileSync(indexPath), indexBefore);
  assert.equal(fs.statSync(profilePath).mtimeMs, profileTime);
  assert.equal(fs.statSync(indexPath).mtimeMs, indexTime);
  assert.throws(() => restoreProfile("qqbot-000000000000000000000000"), /not found or invalid/);
});
