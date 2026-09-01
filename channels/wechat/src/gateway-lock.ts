import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Gateway connection info as published by EchoAI's ServerPlugin in its lock
 * file (`<global_config_dir>/gateway.lock`).
 */
export type GatewayConn = {
  url: string;
  token: string;
};

/**
 * Resolve EchoAI's global config dir, mirroring EchoAI's own resolution order
 * (see EchoAI `src/paths.rs::global_config_dir`):
 *   1. `$ECHOAI_CONFIG_DIR` (escape hatch — used verbatim)
 *   2. `~/.echoai/`
 *
 * Note: EchoAI debug builds use `~/.echoai.dev/`, but a manually launched
 * channel normally targets a release EchoAI. Point at a dev instance with
 * `ECHOAI_CONFIG_DIR=~/.echoai.dev` if needed.
 */
export function globalConfigDir(): string {
  const custom = process.env.ECHOAI_CONFIG_DIR?.trim();
  if (custom) return custom;
  return path.join(os.homedir(), ".echoai");
}

/** Path to EchoAI's gateway lock file. */
export function gatewayLockPath(): string {
  return path.join(globalConfigDir(), "gateway.lock");
}

/**
 * Read gateway url/token from EchoAI's lock file. Returns undefined if the file
 * is missing or malformed (e.g. EchoAI isn't running). Used as a fallback when
 * the gateway env vars aren't injected — i.e. when running `echo-wechat start`
 * by hand instead of via EchoAI's ChannelSupervisor.
 */
export function readGatewayLock(): GatewayConn | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(gatewayLockPath(), "utf8");
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as { url?: unknown; token?: unknown };
    const url = typeof v.url === "string" ? v.url.trim() : "";
    const token = typeof v.token === "string" ? v.token.trim() : "";
    if (!url) return undefined;
    return { url, token };
  } catch {
    return undefined;
  }
}
