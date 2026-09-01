import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

/**
 * Resolve the framework credentials directory.
 * Path: $ECHO_WECHAT_OAUTH_DIR || <stateDir>/credentials
 */
function resolveCredentialsDir(): string {
  const override = process.env.ECHO_WECHAT_OAUTH_DIR?.trim();
  if (override) return override;
  return path.join(resolveStateDir(), "credentials");
}

/**
 * Sanitize a channel/account key for safe use in filenames (mirrors core safeChannelKey).
 */
function safeKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) throw new Error("invalid key for allowFrom path");
  const safe = trimmed.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") throw new Error("invalid key for allowFrom path");
  return safe;
}

/**
 * Resolve the framework allowFrom file path for a given account.
 * Mirrors: `resolveAllowFromPath(channel, env, accountId)` from core.
 * Path: `<credDir>/openclaw-weixin-<accountId>-allowFrom.json`
 */
export function resolveFrameworkAllowFromPath(accountId: string): string {
  const base = safeKey("openclaw-weixin");
  const safeAccount = safeKey(accountId);
  return path.join(resolveCredentialsDir(), `${base}-${safeAccount}-allowFrom.json`);
}

type AllowFromFileContent = {
  version: number;
  allowFrom: string[];
};

/**
 * Read the framework allowFrom list for an account (user IDs authorized via pairing).
 * Returns an empty array when the file is missing or unreadable.
 */
export function readFrameworkAllowFromList(accountId: string): string[] {
  const filePath = resolveFrameworkAllowFromPath(accountId);
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as AllowFromFileContent;
    if (Array.isArray(parsed.allowFrom)) {
      return parsed.allowFrom.filter((id): id is string => typeof id === "string" && id.trim() !== "");
    }
  } catch {
    // best-effort
  }
  return [];
}

/** File lock options (kept for signature compatibility; single-process channel). */
const LOCK_OPTIONS = {
  retries: { retries: 3, factor: 2, minTimeout: 100, maxTimeout: 2000 },
  stale: 10_000,
};

/**
 * Register a user ID in the channel allowFrom store.
 *
 * The channel runs as a single process, so a plain read-modify-write is safe
 * here (the original used a cross-process file lock for the multi-plugin
 * openclaw runtime, which doesn't apply to a standalone EchoAI channel).
 */
export async function registerUserInFrameworkStore(params: {
  accountId: string;
  userId: string;
}): Promise<{ changed: boolean }> {
  const { accountId, userId } = params;
  void LOCK_OPTIONS;
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) return { changed: false };

  const filePath = resolveFrameworkAllowFromPath(accountId);

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let content: AllowFromFileContent = { version: 1, allowFrom: [] };
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as AllowFromFileContent;
    if (Array.isArray(parsed.allowFrom)) {
      content = parsed;
    }
  } catch {
    // If read/parse fails (incl. missing file), start fresh.
  }

  if (content.allowFrom.includes(trimmedUserId)) {
    return { changed: false };
  }

  content.allowFrom.push(trimmedUserId);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
  logger.info(
    `registerUserInFrameworkStore: added userId=${trimmedUserId} accountId=${accountId} path=${filePath}`,
  );
  return { changed: true };
}
