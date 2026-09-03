import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveStateDir } from "../storage/state-dir.js";

export type QqBotProfile = {
  version: 1;
  profileId: string;
  appId: string;
  appSecret: string;
};

type ProfileIndex = { version: 1; profiles: string[] };

const APP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROFILE_ID = /^qqbot-[a-f0-9]{24}$/;

export function profileIdForAppId(appId: string): string {
  const normalized = validateAppId(appId);
  return `qqbot-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24)}`;
}

export function validateAppId(value: string): string {
  const appId = value.trim();
  if (!APP_ID.test(appId)) throw new Error("Invalid QQ Bot AppID");
  return appId;
}

export function validateAppSecret(value: string): string {
  const secret = value.trim();
  if (!secret || secret.length > 512 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("Invalid QQ Bot AppSecret");
  }
  return secret;
}

function profilesDir(): string {
  return path.join(resolveStateDir(), "profiles");
}

export function resolveProfilePath(profileId: string): string {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid QQ Bot profile ID");
  return path.join(profilesDir(), `${profileId}.json`);
}

export function resolveProfileIndexPath(): string {
  return path.join(profilesDir(), "index.json");
}

function atomicWriteJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function parseIndex(value: unknown): ProfileIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid QQ Bot profile index");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.profiles)
    || !record.profiles.every((id) => typeof id === "string" && PROFILE_ID.test(id))
    || new Set(record.profiles).size !== record.profiles.length) {
    throw new Error("Invalid QQ Bot profile index");
  }
  return { version: 1, profiles: [...record.profiles] as string[] };
}

export function listProfileIds(): string[] {
  const file = resolveProfileIndexPath();
  if (!fs.existsSync(file)) return [];
  try {
    return parseIndex(JSON.parse(fs.readFileSync(file, "utf8"))).profiles;
  } catch (error) {
    throw new Error("Unable to read QQ Bot profile index", { cause: error });
  }
}

function parseProfile(value: unknown, expectedId: string): QqBotProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid QQ Bot profile");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "appId,appSecret,profileId,version" || record.version !== 1
    || record.profileId !== expectedId || typeof record.appId !== "string" || typeof record.appSecret !== "string") {
    throw new Error("Invalid QQ Bot profile");
  }
  const appId = validateAppId(record.appId);
  const appSecret = validateAppSecret(record.appSecret);
  if (profileIdForAppId(appId) !== expectedId) throw new Error("QQ Bot profile ID does not match AppID");
  return { version: 1, profileId: expectedId, appId, appSecret };
}

export function loadProfile(profileId: string): QqBotProfile {
  const file = resolveProfilePath(profileId);
  try {
    const profile = parseProfile(JSON.parse(fs.readFileSync(file, "utf8")), profileId);
    if (!listProfileIds().includes(profileId)) throw new Error("Profile is absent from index");
    return profile;
  } catch (error) {
    throw new Error(`QQ Bot profile not found or invalid: ${profileId}`, { cause: error });
  }
}

/** Persist credentials for add mode. AppSecret must never be logged by callers. */
export function saveProfile(appIdValue: string, appSecretValue: string): QqBotProfile {
  const appId = validateAppId(appIdValue);
  const appSecret = validateAppSecret(appSecretValue);
  const profileId = profileIdForAppId(appId);
  const profile: QqBotProfile = { version: 1, profileId, appId, appSecret };
  atomicWriteJson(resolveProfilePath(profileId), profile);
  const ids = listProfileIds();
  if (!ids.includes(profileId)) atomicWriteJson(resolveProfileIndexPath(), { version: 1, profiles: [...ids, profileId] });
  return profile;
}

/** Restore mode is validation-only and deliberately performs no writes. */
export function restoreProfile(profileId: string): QqBotProfile {
  return loadProfile(profileId);
}

export const createProfile = saveProfile;
