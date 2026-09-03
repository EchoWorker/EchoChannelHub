import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

function post(url: URL, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: "127.0.0.1", port: url.port, path: url.pathname, method: "POST", headers: { Host: url.host, "Content-Type": "application/json", "Content-Length": String(bytes.length) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject); req.end(bytes);
  });
}

test("CLI setup add and restore emit protocol frames without leaking the secret", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "qq-cli-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const env = { ...process.env, ECHO_QQBOT_STATE_DIR: state };
  const child = spawn(process.execPath, [path.resolve("dist/cli.js"), "setup", "--echowork-json", "--session-id", "test", "--mode", "add"], { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", submitted = false;
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const line = stdout.split("\n").find((entry) => entry.includes("channel_setup.ready"));
    if (line && !submitted) {
      submitted = true;
      const ready = JSON.parse(line) as { url: string };
      void post(new URL(ready.url), { appId: "123456", appSecret: "process-secret" }).then((status) => assert.equal(status, 204));
    }
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(code, 0); assert.equal(stderr, ""); assert.doesNotMatch(stdout, /process-secret/);
  const frames = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(frames[0].type, "echowork.channel_setup.ready"); assert.equal(frames[1].type, "echowork.channel_setup.complete");
  const profileId = String(frames[1].profile_id);
  const restore = spawn(process.execPath, [path.resolve("dist/cli.js"), "setup", "--echowork-json", "--session-id", "restore", "--mode", "restore", "--account", profileId], { cwd: path.resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  let restored = ""; restore.stdout.on("data", (chunk) => { restored += chunk; });
  assert.equal(await new Promise<number | null>((resolve) => restore.once("exit", resolve)), 0);
  assert.equal((JSON.parse(restored) as {profile_id:string}).profile_id, profileId);
  assert.doesNotMatch(restored, /process-secret/);
});

test("CLI rejects duplicate and unknown flags", async () => {
  for (const args of [["version", "--json", "--json"], ["start", "--account", "x", "--wat"]]) {
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), ...args], { cwd: path.resolve("."), stdio: "ignore" });
    assert.equal(await new Promise<number | null>((resolve) => child.once("exit", resolve)), 2);
  }
});
