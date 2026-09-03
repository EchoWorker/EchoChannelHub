import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyFiltered } from "../src/hubctl.js";

test("copyFiltered copies a dist root while excluding nested tests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-copy-"));
  const source = path.join(root, "dist");
  const destination = path.join(root, "payload", "app", "dist");
  fs.mkdirSync(path.join(source, "tests"), { recursive: true });
  fs.mkdirSync(path.join(source, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(source, "cli.js"), "entrypoint");
  fs.writeFileSync(path.join(source, "runtime", "helper.js"), "helper");
  fs.writeFileSync(path.join(source, "tests", "cli.test.js"), "test");
  copyFiltered(source, destination);
  assert.equal(fs.readFileSync(path.join(destination, "cli.js"), "utf8"), "entrypoint");
  assert.equal(fs.readFileSync(path.join(destination, "runtime", "helper.js"), "utf8"), "helper");
  assert.equal(fs.existsSync(path.join(destination, "tests")), false);
  fs.rmSync(root, { recursive: true, force: true });
});
