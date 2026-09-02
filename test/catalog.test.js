import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { root, validateCatalog } from "../src/lib.js";
import { loadRegistry, validateRegistry } from "../src/registry.js";

const dir = path.join(root, "registry", "v1");
test("content-addressed registry and all signatures validate", () => assert.deepEqual(validateRegistry(dir), []));
test("latest resolves immutable semantic catalog and taxonomies", () => {
  const value = loadRegistry(dir);
  assert.equal(value.latest.testOnly, true);
  assert.equal(value.latest.keyId, "echoworker-test-2026");
  assert.equal(value.snapshot.testOnly, true);
  assert.equal(value.snapshot.keyId, "echoworker-test-2026");
  assert.equal(value.latest.snapshot.size, value.snapshotBytes.length);
  assert.match(value.latest.snapshot.url, /snapshots\/sha256\/[a-f0-9]{64}\/snapshot\.json$/);
  assert.deepEqual(validateCatalog(value.objects.catalog), []);
  assert.equal(value.objects.catalog.channels[0].description["zh-CN"].includes("微信"), true);
  assert.equal("setup" in value.objects.catalog.channels[0], false);
  assert.equal("setup" in value.objects.catalog.channels[0].releases[0], false);
  assert.equal(value.objects.categories.categories[0].id, "messaging");
  assert.equal(value.objects.tags.tags[0].id, "direct-message");
  for (const [kind, ref] of Object.entries(value.snapshot.blobs)) {
    const file = path.join(dir, "objects", "sha256", ref.sha256, `${kind}.json`);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.statSync(file).size, ref.size);
  }
});
