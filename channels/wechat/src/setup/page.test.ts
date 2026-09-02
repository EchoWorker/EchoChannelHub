import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderSetupPage } from "./page.js";

test("setup page inline script is valid JavaScript", () => {
  const html = renderSetupPage();
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});
