import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";
import { resolveFrameworkAllowFromPath } from "./pairing.js";
import { logger } from "../util/logger.js";

/**
 * Account store for the EchoAI WeChat channel.
 *
 * Vendored & adapted from `@tencent-weixin/openclaw-weixin` (MIT). The on-disk
 * credential / index format is kept verbatim; the OpenClaw config glue
 * (openclaw.json route tags, channel reload, OpenClawConfig) is replaced with
 * env-based config and standalone helpers, since this runs as its own process.
 */

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ---------------------------------------------------------------------------
// Account ID normalization (was openclaw/plugin-sdk/account-id)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw WeChat account id into a filesystem-safe id.
 * e.g. "b0f5860fdecb@im.bot" -> "b0f5860fdecb-im-bot".
 * Mirrors openclaw's normalizeAccountId for the suffixes WeChat uses.
 */
export function normalizeAccountId(raw: string): string {
  return raw
    .trim()
    .replace(/@/g, "-")
    .replace(/\./g, "-")
    .replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * Pattern-based reverse of normalizeAccountId for known weixin ID suffixes.
 * Used only as a compatibility fallback when loading accounts / sync bufs stored
 * under the old raw ID.
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "accounts-index");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}

/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

function atomicWriteJson(filePath: string, value: unknown, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode });
    fs.renameSync(temp, filePath);
    if (mode !== undefined) {
      try { fs.chmodSync(filePath, mode); } catch { /* best-effort */ }
    }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
}

/** Add accountId to the persistent index (no-op if already present). */
export function registerWeixinAccountId(accountId: string): void {
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(accountId)) return;

  const updated = [...existing, accountId];
  atomicWriteJson(resolveAccountIndexPath(), updated, 0o600);
}

/** Remove accountId from the persistent index. */
export function unregisterWeixinAccountId(accountId: string): void {
  const existing = listIndexedWeixinAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    atomicWriteJson(resolveAccountIndexPath(), updated, 0o600);
  }
}

/**
 * Remove stale accounts that share the same userId as the newly-bound account.
 * Called after a successful QR login to ensure only the latest account remains
 * for a given WeChat user, preventing ambiguous contextToken matches.
 */
export function clearStaleAccountsForUserId(
  currentAccountId: string,
  userId: string,
  onClearContextTokens?: (accountId: string) => void,
): void {
  if (!userId) return;
  const allIds = listIndexedWeixinAccountIds();
  for (const id of allIds) {
    if (id === currentAccountId) continue;
    const data = loadWeixinAccount(id);
    if (data?.userId?.trim() === userId) {
      logger.info(`clearStaleAccountsForUserId: removing stale account=${id} (same userId=${userId})`);
      onClearContextTokens?.(id);
      clearWeixinAccount(id);
      unregisterWeixinAccountId(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

/** Unified per-account data: token + baseUrl in one file. */
export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID, with a normalized→raw compatibility fallback. */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;

  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readAccountFile(resolveAccountPath(rawId));
    if (compat) return compat;
  }
  return null;
}

/**
 * Persist account data after QR login (merges into existing file).
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  atomicWriteJson(filePath, data, 0o600);
}

/** Remove all files associated with an account. */
export function clearWeixinAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  const accountFiles = [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
  ];
  for (const file of accountFiles) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // ignore if not found
    }
  }
  try {
    fs.unlinkSync(path.join(resolveStateDir(), "openclaw-weixin", "accounts", `${accountId}.sync.json`));
  } catch {
    // ignore if not found
  }
  try {
    fs.unlinkSync(resolveFrameworkAllowFromPath(accountId));
  } catch {
    // ignore if not found
  }
}

// ---------------------------------------------------------------------------
// Config (was openclaw.json glue) — now env-based
// ---------------------------------------------------------------------------

/**
 * Optional SKRouteTag, read from `ECHO_WECHAT_ROUTE_TAG`. Most self-hosted
 * setups don't need this; it was an openclaw multi-tenant routing hint.
 */
export function loadConfigRouteTag(_accountId?: string): string | undefined {
  const tag = process.env.ECHO_WECHAT_ROUTE_TAG?.trim();
  return tag || undefined;
}

/**
 * Optional bot_agent string, read from `ECHO_WECHAT_BOT_AGENT`. Falls through to
 * the api layer's "OpenClaw" default when unset.
 */
export function loadConfigBotAgent(): string | undefined {
  const value = process.env.ECHO_WECHAT_BOT_AGENT?.trim();
  return value || undefined;
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  enabled: boolean;
  /** true when a token has been obtained via QR login. */
  configured: boolean;
  name?: string;
};

/** List accountIds from the index file (written at QR login). */
export function listWeixinAccountIds(): string[] {
  return listIndexedWeixinAccountIds();
}

/** Resolve a weixin account by ID from stored credentials. */
export function resolveWeixinAccount(accountId?: string | null): ResolvedWeixinAccount {
  const raw = accountId?.trim();
  if (!raw) {
    throw new Error("weixin: accountId is required (no default account)");
  }
  const id = normalizeAccountId(raw);

  const accountData = loadWeixinAccount(id);
  const token = accountData?.token?.trim() || undefined;
  const stateBaseUrl = accountData?.baseUrl?.trim() || "";

  return {
    accountId: id,
    baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    token,
    enabled: true,
    configured: Boolean(token),
  };
}
