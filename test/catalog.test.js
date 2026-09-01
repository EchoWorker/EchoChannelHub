import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TARGET, TEST_KEY_ID, readJson, root, sha256, validateCatalog, verifySignature } from "../src/lib.js";

const file = path.join(root, "registry", "v1", "catalog.json");
test("catalog strictly matches EchoWork channel_manager model", () => {
  const value = readJson(file);
  assert.deepEqual(validateCatalog(value), []);
  assert.deepEqual(Object.keys(value), ["schemaVersion", "sequence", "generatedAt", "expiresAt", "channels"]);
  const artifact = value.channels[0].releases[0].artifacts[TARGET];
  assert.deepEqual(Object.keys(artifact), ["url", "size", "sha256", "signature", "keyId"]);
  assert.equal(value.channels[0].publisher, "EchoWorker");
  assert.equal(value.channels[0].releases[0].status, "active");
  assert.equal(artifact.keyId, TEST_KEY_ID);
  const local = path.join(root, "artifacts", "wechat-0.1.4-windows-x64.echochannel");
  assert.equal(artifact.sha256, sha256(local));
  assert.equal(artifact.size, fs.statSync(local).size);
  assert.equal(verifySignature(fs.readFileSync(local), artifact.signature), true);
});
test("catalog has a valid TEST ONLY Ed25519 signature", () => assert.equal(verifySignature(fs.readFileSync(file), fs.readFileSync(`${file}.sig`, "utf8").trim()), true));
