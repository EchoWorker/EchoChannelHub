import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactManifest, channelSemantic, loadChannels, root, validateManifest, validateRepository, validateSetup } from "../src/lib.js";
import { buildRegistry } from "../src/registry.js";

const channels = loadChannels(root);
const wechat = channels.find((channel) => channel.manifest.id === "wechat");
if (!wechat) throw new Error("wechat fixture channel is missing");
test("generated root manifests exactly match EchoWork model", () => {
  for (const channel of channels) {
    const value = artifactManifest(channel.manifest);
    assert.deepEqual(validateManifest(value), []);
    assert.deepEqual(Object.keys(value), ["schemaVersion", "publisher", "id", "version", "target", "entrypoint", "entrypointArgs", "protocols", "setup"]);
    assert.equal(value.schemaVersion, 3);
    assert.equal(value.entrypoint, "payload/runtime/node.exe");
    assert.deepEqual(value.entrypointArgs, ["payload/app/dist/cli.js"]);
    assert.deepEqual(value.setup, channel.manifest.setup);
    assert.notEqual(value.setup, channel.manifest.setup);
  }
});
test("source setup validates but remains artifact-only", () => {
  const setup = wechat.manifest.setup;
  assert.deepEqual(validateSetup(setup), []);
  assert.deepEqual(setup.add.args, ["--mode", "add"]);
  assert.deepEqual(setup.restore.args, ["--mode", "restore", "--account", "{profileId}"]);
  assert.deepEqual(setup.startArgs, ["start", "--account", "{profileId}"]);
  assert.deepEqual(validateManifest({ ...artifactManifest(wechat.manifest), entrypointArgs: [] }), []);
  assert.match(validateManifest({ ...artifactManifest(wechat.manifest), entrypointArgs: [""] })[0], /entrypointArgs/);
  assert.match(validateManifest({ ...artifactManifest(wechat.manifest), schemaVersion: 2 })[0], /must equal 3/);
  assert.equal("setup" in channelSemantic(wechat.manifest), false);
  assert.match(validateSetup({ ...setup, add: { args: ["{profileId}"] } })[0], /unsupported placeholder/);
});

test("repository bilingual semantic metadata validates", () => {
  assert.deepEqual(validateRepository(root), []);
  for (const { manifest: m } of channels) assert.ok(m.summary.en && m.summary["zh-CN"] && m.description.en && m.description["zh-CN"]);
});
test("incremental changed-set reports only semantic changes", () => {
  const artifacts = Object.fromEntries(channels.map((channel) => [channel.manifest.id, { url:`https://example.test/${channel.manifest.id}`, size:1, sha256:"0".repeat(64), signature:"x", keyId:"test" }]));
  const oneDir=fs.mkdtempSync(path.join(os.tmpdir(),"reg-one-"));
  const one=buildRegistry({channels,artifacts,output:oneDir,now:new Date("2026-01-01T00:00:00Z")});
  const twoDir=fs.mkdtempSync(path.join(os.tmpdir(),"reg-two-"));
  const two=buildRegistry({channels,artifacts,output:twoDir,prior:{snapshot:one.snapshot,catalog:one.catalog,hash:one.hash},now:new Date("2026-01-02T00:00:00Z")});
  assert.deepEqual(two.snapshot.changedSet.channels, []);
  assert.deepEqual(two.snapshot.changedSet.taxonomy, []);
  assert.equal(two.snapshot.changedSet.base, one.hash);
  fs.rmSync(oneDir,{recursive:true,force:true}); fs.rmSync(twoDir,{recursive:true,force:true});
});
