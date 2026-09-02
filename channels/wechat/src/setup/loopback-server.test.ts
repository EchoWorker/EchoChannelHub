import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startSetupServer } from "./loopback-server.js";

function rawRequest(url: URL, options: { method?: string; host?: string; contentType?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers.Host = options.host;
    if (options.contentType !== undefined) headers["Content-Type"] = options.contentType;
    const req = http.request({ hostname: "127.0.0.1", port: url.port, path: url.pathname, method: options.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test("setup server binds exact loopback capability, protects host, and redacts status", async () => {
  const server = await startSetupServer({
    snapshot: () => ({ status: "wait", message: "waiting", qrUrl: "secret-qr-url", qrVersion: 1 }),
    submitCode: () => {},
    cancel: () => {},
  });
  try {
    const url = new URL(server.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(Number(url.port) >= 1024);
    assert.match(url.pathname, /^\/setup\/[A-Za-z0-9_-]{43}$/);

    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal((await fetch(`${url.origin}/setup/wrong`)).status, 404);

    assert.equal((await rawRequest(url, { host: "localhost" })).status, 400);
    assert.equal((await rawRequest(url, { host: `localhost:${url.port}` })).status, 400);
    assert.equal((await rawRequest(url, { host: `127.0.0.1:${url.port}.example.com` })).status, 400);
    assert.equal((await rawRequest(url, { host: `127.0.0.1:${url.port}` })).status, 200);

    const status = await fetch(`${server.url}/status`);
    assert.deepEqual(await status.json(), { status: "wait", message: "waiting", qrVersion: 1 });
    assert.doesNotMatch(await (await fetch(`${server.url}/status`)).text(), /secret-qr-url/);
  } finally {
    await server.close();
  }
});

test("verify and cancel enforce method, exact content type, and exact body", async () => {
  let cancelled = false;
  const codes: string[] = [];
  const server = await startSetupServer({
    snapshot: () => ({ status: "wait", message: "waiting", qrVersion: 1 }),
    submitCode: (code) => codes.push(code),
    cancel: () => { cancelled = true; },
  });
  try {
    const verify = `${server.url}/verify`;
    const cancel = `${server.url}/cancel`;
    assert.equal((await fetch(verify)).status, 405);
    assert.equal((await fetch(cancel)).status, 405);
    assert.equal((await fetch(verify, { method: "PUT" })).status, 405);
    assert.equal((await fetch(cancel, { method: "DELETE" })).status, 405);

    for (const contentType of [undefined, "text/plain", "application/json; charset=utf-8", "Application/JSON"]) {
      const headers = contentType ? { "content-type": contentType } : undefined;
      assert.equal((await fetch(verify, { method: "POST", headers, body: "{}" })).status, 415);
      assert.equal((await fetch(cancel, { method: "POST", headers, body: "{}" })).status, 415);
    }

    for (const body of ["", "null", "[]", "{", "{}", '{"code":1234}', '{"code":""}', '{"code":"1234567890123"}', '{"code":"12ab"}', '{"code":"1234","extra":true}']) {
      assert.equal((await fetch(verify, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 400, body);
    }
    assert.deepEqual(codes, []);
    assert.equal((await fetch(verify, { method: "POST", headers: { "content-type": "application/json" }, body: '{"code":"1234"}' })).status, 204);
    assert.deepEqual(codes, ["1234"]);

    for (const body of ["", "null", "[]", "{", '{"extra":true}']) {
      assert.equal((await fetch(cancel, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 400, body);
    }
    assert.equal(cancelled, false);
    assert.equal((await fetch(cancel, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 204);
    assert.equal(cancelled, true);
  } finally {
    await server.close();
  }
});
