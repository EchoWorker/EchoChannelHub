/**
 * gateway-lock.test.ts — readGatewayLock() fallback parsing.
 *
 * Run: node --test dist/gateway-lock.test.js   (after build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readGatewayLock, gatewayLockPath } from "./gateway-lock.js";

/** Run fn with ECHOAI_CONFIG_DIR pointed at a fresh temp dir; always restores env. */
function withTempConfigDir(fn: (dir: string) => void): void {
  const prev = process.env.ECHOAI_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-wechat-lock-"));
  process.env.ECHOAI_CONFIG_DIR = dir;
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.ECHOAI_CONFIG_DIR;
    else process.env.ECHOAI_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("readGatewayLock: parses a well-formed lock file", () => {
  withTempConfigDir((dir) => {
    fs.writeFileSync(
      path.join(dir, "gateway.lock"),
      JSON.stringify({ pid: 123, token: "tok-abc", url: "ws://127.0.0.1:64004" }),
    );
    const conn = readGatewayLock();
    assert.deepEqual(conn, { url: "ws://127.0.0.1:64004", token: "tok-abc" });
  });
});

test("readGatewayLock: returns undefined when the file is missing", () => {
  withTempConfigDir(() => {
    assert.equal(readGatewayLock(), undefined);
  });
});

test("readGatewayLock: returns undefined on malformed JSON", () => {
  withTempConfigDir((dir) => {
    fs.writeFileSync(path.join(dir, "gateway.lock"), "{not json");
    assert.equal(readGatewayLock(), undefined);
  });
});

test("readGatewayLock: returns undefined when url is absent", () => {
  withTempConfigDir((dir) => {
    fs.writeFileSync(path.join(dir, "gateway.lock"), JSON.stringify({ token: "tok-only" }));
    assert.equal(readGatewayLock(), undefined);
  });
});

test("readGatewayLock: token defaults to empty string when absent but url present", () => {
  withTempConfigDir((dir) => {
    fs.writeFileSync(path.join(dir, "gateway.lock"), JSON.stringify({ url: "ws://127.0.0.1:1" }));
    const conn = readGatewayLock();
    assert.deepEqual(conn, { url: "ws://127.0.0.1:1", token: "" });
  });
});

test("gatewayLockPath: honors ECHOAI_CONFIG_DIR", () => {
  withTempConfigDir((dir) => {
    assert.equal(gatewayLockPath(), path.join(dir, "gateway.lock"));
  });
});
