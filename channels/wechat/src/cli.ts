#!/usr/bin/env node
/**
 * echo-wechat — WeChat channel for EchoAI.
 *
 * Subcommands:
 *   login   Interactive QR login (run in a terminal). Saves the bot token.
 *   start   Connect to the EchoAI gateway and run. Spawned headless by EchoAI.
 *
 * `start` accepts the following flags (all optional):
 *   --session-key <key>     EchoAI session_key for this bot (default: wechat:<accountId>)
 *   --model <id>            EchoAI model id; validated against gateway model.list at startup
 *   --workspace <abs-path>  absolute workspace path for the agent's cwd
 *
 * Run with no subcommand → prints help.
 */

import { createRequire } from "node:module";
import { runLogin } from "./commands/login.js";
import { runSetup } from "./commands/setup.js";
import { runStart, type StartOptions } from "./commands/start.js";
const packageJson = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

function printHelp(): void {
  process.stdout.write(
    [
      "echo-wechat — WeChat channel for EchoAI",
      "",
      "Usage:",
      "  echo-wechat version [--json]                   Print channel version metadata.",
      "  echo-wechat setup --echowork-json --session-id <id>  Run the EchoWork loopback setup protocol.",
      "  echo-wechat login                              Interactive QR login (scan in a terminal); saves the bot token.",
      "  echo-wechat start [flags]                      Connect to the EchoAI gateway and run (spawned by EchoAI).",
      "",
      "`start` flags (all optional):",
      "  --account <id>          exact setup profile/account id (required with multiple accounts)",
      "  --session-key <key>      EchoAI session_key for this bot (default: wechat:<accountId>)",
      "  --model <id>             EchoAI model id; validated against gateway model.list at startup",
      "  --workspace <abs-path>   absolute workspace path for the agent's cwd",
      "",
      "Env (read by `start`, injected by EchoAI):",
      "  ECHOAI_GATEWAY_URL    gateway WebSocket url",
      "  ECHOAI_GATEWAY_TOKEN  gateway auth token",
      "  ECHOAI_PLUGIN_NAME    plugin name to register with",
      "",
      "Optional env:",
      "  ECHO_WECHAT_STATE_DIR   override state dir (default ~/.echoai/channels/wechat)",
      "",
    ].join("\n"),
  );
}

/** Parse `start` flags out of argv. Bails with stderr+exit on unknown / missing-value flags. */
function parseStartArgs(argv: string[]): StartOptions {
  const opts: StartOptions = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v == null || v.startsWith("--")) {
        process.stderr.write(`echo-wechat start: flag ${arg} requires a value\n`);
        process.exit(2);
      }
      i += 2;
      return v;
    };
    switch (arg) {
      case "--account":
        opts.account = next();
        break;
      case "--session-key":
        opts.sessionKey = next();
        break;
      case "--model":
        opts.model = next();
        break;
      case "--workspace":
        opts.workspace = next();
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        process.stderr.write(`echo-wechat start: unknown flag: ${arg}\n\n`);
        printHelp();
        process.exit(2);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "version": {
      const args = process.argv.slice(3);
      if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
        process.stderr.write("echo-wechat version: only --json is supported\n");
        process.exitCode = 2;
        return;
      }
      if (args[0] === "--json") process.stdout.write(`${JSON.stringify({ publisher: "EchoWorker", id: "wechat", version: packageJson.version, protocols: { setup: 1, start: 1 } })}\n`);
      else process.stdout.write(`${packageJson.version}\n`);
      break;
    }
    case "setup": {
      const args = process.argv.slice(3);
      const jsonIndex = args.indexOf("--echowork-json");
      const sessionIndex = args.indexOf("--session-id");
      if (jsonIndex < 0 || sessionIndex < 0 || !args[sessionIndex + 1] || args.some((a, i) => a.startsWith("--") && a !== "--echowork-json" && a !== "--session-id" && i !== sessionIndex + 1)) {
        process.stderr.write("echo-wechat setup: requires --echowork-json --session-id <id>\n");
        process.exitCode = 2;
        return;
      }
      await runSetup({ echoworkJson: true, sessionId: args[sessionIndex + 1] });
      break;
    }
    case "login":
      await runLogin();
      break;
    case "start": {
      const opts = parseStartArgs(process.argv.slice(3));
      await runStart(opts);
      break;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n`);
      printHelp();
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
