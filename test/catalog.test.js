import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJson, root, validateCatalog } from "../src/lib.js";
import { loadRegistry, validateRegistry } from "../src/registry.js";

const dir = path.join(root, "registry", "v1");
test("content-addressed registry and all signatures validate", () => assert.deepEqual(validateRegistry(dir), []));
test("latest resolves immutable semantic catalog and taxonomies", () => {
  const value = loadRegistry(dir);
  assert.equal(value.latest.testOnly, true);
  assert.equal(value.snapshot.testOnly, true);
  assert.match(value.latest.snapshot.url, /snapshots\/sha256\/[a-f0-9]{64}\/snapshot\.json$/);
  assert.deepEqual(validateCatalog(value.objects.catalog), []);
  assert.equal(value.objects.catalog.channels[0].description["zh-CN"].includes("微信"), true);
  assert.equal(value.objects.categories.kind, "categories");
  assert.equal(value.objects.tags.kind, "tags");
  for (const [kind, ref] of Object.entries(value.snapshot.objects)) assert.equal(fs.existsSync(path.join(dir, "objects", "sha256", ref.sha256, `${kind}.json`)), true);
});
