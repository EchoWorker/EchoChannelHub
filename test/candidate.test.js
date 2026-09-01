import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TARGET, TEST_KEY_ID, root, sha256, verifySignature } from "../src/lib.js";

const artifact = path.join(root, "artifacts", `wechat-0.1.4-${TARGET}.echochannel`);
test("local candidate is a single signed ZIP artifact", { skip: !fs.existsSync(artifact) && "candidate is built only by preview workflow" }, () => {
  const sidecar = JSON.parse(fs.readFileSync(`${artifact}.json`, "utf8"));
  assert.equal(sidecar.target, TARGET);
  assert.equal(sidecar.keyId, TEST_KEY_ID);
  assert.equal(sidecar.testOnly, true);
  assert.equal(sidecar.sha256, sha256(artifact));
  assert.equal(sidecar.size, fs.statSync(artifact).size);
  assert.equal(verifySignature(fs.readFileSync(artifact), sidecar.signature), true);
  assert.equal(fs.readFileSync(artifact).subarray(0, 2).toString(), "PK");
});
