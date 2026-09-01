import test from "node:test";
import assert from "node:assert/strict";
import { artifactManifest, loadChannels, root, validateManifest, validateRepository } from "../src/lib.js";

test("generated root manifest exactly matches EchoWork model", () => {
  const value = artifactManifest(loadChannels(root)[0].manifest);
  assert.deepEqual(validateManifest(value), []);
  assert.deepEqual(Object.keys(value), ["schemaVersion", "publisher", "id", "version", "target", "entrypoint", "protocols"]);
});
test("manifest rejects legacy fields and target spelling", () => assert.ok(validateManifest({ schemaVersion: 1, id: "x", platforms: ["win32-x64"] }).length > 0));
test("repository validates", () => assert.deepEqual(validateRepository(root), []));
