#!/usr/bin/env node
import { createRequire } from "node:module";
import { runSetup, type SetupMode } from "./setup/setup.js";
import { runStart, type StartOptions } from "./commands/start.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function value(args: string[], flag: string): string | undefined {
  const indexes = args.flatMap((arg, index) => arg === flag ? [index] : []);
  if (indexes.length > 1) fail(`duplicate flag: ${flag}`);
  if (!indexes.length) return undefined;
  const result = args[indexes[0] + 1];
  if (!result || result.startsWith("--")) fail(`${flag} requires a value`);
  return result;
}

function assertFlags(args: string[], valued: string[], switches: string[] = []): void {
  const allowed = new Set([...valued, ...switches]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--") || !allowed.has(arg)) fail(`unknown argument: ${arg}`);
    if (valued.includes(arg)) index++;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  if (command === "version") {
    assertFlags(args, [], ["--json"]);
    if (args.filter((arg) => arg === "--json").length > 1) fail("duplicate flag: --json");
    const result = { publisher: "EchoWorker", id: "qqbot", version: pkg.version, protocols: { setup: 2, start: 1 } };
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(result)}\n` : `${pkg.version}\n`);
    return;
  }
  if (command === "setup") {
    assertFlags(args, ["--session-id", "--mode", "--account"], ["--echowork-json"]);
    if (!args.includes("--echowork-json")) fail("setup requires --echowork-json");
    const sessionId = value(args, "--session-id");
    const mode = value(args, "--mode") as SetupMode | undefined;
    const account = value(args, "--account");
    if (!sessionId || (mode !== "add" && mode !== "restore")) fail("setup requires session-id and mode add|restore");
    if ((mode === "add" && account) || (mode === "restore" && !account)) fail("invalid setup account arguments");
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    process.once("SIGTERM", () => abort.abort());
    await runSetup({ sessionId, mode, account, signal: abort.signal });
    return;
  }
  if (command === "start") {
    assertFlags(args, ["--account", "--model", "--workspace"]);
    const options: StartOptions = { profile: value(args, "--account"), model: value(args, "--model"), workspace: value(args, "--workspace") };
    if (!options.profile) fail("start requires --account <profileId>");
    await runStart(options);
    return;
  }
  process.stdout.write("Usage: echo-qqbot <version|setup|start>\n");
  if (command) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`echo-qqbot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
