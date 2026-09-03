import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { QQGatewayOrchestrator, type EventDedupe, type QQClient, type QQMediaBridge, type ReplyBudget } from "../bridge/orchestrator.js";
import { loadProfile } from "../profile/store.js";
import { createRuntimeQQClient } from "../qq/runtime-client.js";
import { EventDedupe as PersistentEventDedupe } from "../storage/event-dedupe.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { MediaBridge } from "../media/index.js";
import { EchoAIGatewayClient } from "../gateway/echoai-client.js";

export type QQProfile = {
  profileId: string;
  accountId?: string;
  appId: string;
  appSecret: string;
  dataDir?: string;
};

export type StartOptions = {
  profile?: string;
  model?: string;
  workspace?: string;
};

type RuntimeParts = {
  profile: QQProfile;
  qq: QQClient;
  dedupe: EventDedupe;
  replyBudget: ReplyBudget;
  media?: QQMediaBridge;
};

type StartDependencies = {
  loadRuntime: (profileId?: string) => Promise<RuntimeParts>;
  createGateway?: (options: ConstructorParameters<typeof EchoAIGatewayClient>[0]) => EchoAIGatewayClient;
};

type GatewayLock = { url?: string; token?: string };

function configDir(): string {
  return process.env.ECHOAI_CONFIG_DIR?.trim() || path.join(os.homedir(), ".echoai");
}

function gatewayLock(): GatewayLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir(), "gateway.lock"), "utf8")) as Record<string, unknown>;
    const port = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
    const url = typeof parsed.url === "string" ? parsed.url
      : Number.isFinite(port) && port > 0 ? `ws://127.0.0.1:${port}` : undefined;
    return { url, token: typeof parsed.token === "string" ? parsed.token : undefined };
  } catch { return null; }
}

async function defaultLoadRuntime(profileId?: string): Promise<RuntimeParts> {
  if (!profileId) throw new Error("QQ start requires a profile ID");
  const profile = loadProfile(profileId);
  const runtimeDir = path.join(resolveStateDir(), "runtime", profile.profileId);
  const qq = await createRuntimeQQClient(profile, path.join(runtimeDir, "qq"));
  const persistentDedupe = new PersistentEventDedupe({ file: path.join(runtimeDir, "events.json") });
  await persistentDedupe.load();
  const dedupe: EventDedupe = {
    claim: (eventId) => persistentDedupe.reserve(eventId),
    commit: (eventId) => persistentDedupe.commit(eventId),
    rollback: (eventId) => persistentDedupe.rollback(eventId),
  };
  const replyBudget: ReplyBudget = {
    reserve: (context) => qq.budget.reserve(`${context.scope}:${context.targetId}:${context.msgId}`, context.msgId),
    commit: (allocation) => qq.budget.commit(allocation as import("../qq/reply-budget.js").ReplyReservation),
    rollback: (allocation) => qq.budget.rollback(allocation as import("../qq/reply-budget.js").ReplyReservation),
  };
  const media = new MediaBridge(profile.profileId, [process.cwd()]);
  await media.initialize();
  return { profile, qq, dedupe, replyBudget, media };
}

/** ChannelSupervisor entry point: load one profile and own both gateway lifecycles. */
export async function runStart(options: StartOptions = {}, dependencies: StartDependencies = { loadRuntime: defaultLoadRuntime }): Promise<void> {
  const lock = gatewayLock();
  const url = process.env.ECHOAI_GATEWAY_URL?.trim() || lock?.url;
  const token = process.env.ECHOAI_GATEWAY_TOKEN?.trim() || lock?.token || "";
  const pluginName = process.env.ECHOAI_PLUGIN_NAME?.trim() || "channel.qqbot";
  if (!url) throw new Error(`QQ channel cannot find EchoAI gateway (set ECHOAI_GATEWAY_URL or create ${path.join(configDir(), "gateway.lock")})`);

  const workspace = options.workspace?.trim() || process.env.ECHOAI_WORKSPACE?.trim();
  if (workspace && (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory())) {
    throw new Error(`workspace must be an existing absolute directory: ${workspace}`);
  }
  const runtime = await dependencies.loadRuntime(options.profile?.trim() || process.env.ECHOAI_PROFILE_ID?.trim());
  if (!runtime.profile.profileId || !runtime.profile.appId || !runtime.profile.appSecret) throw new Error("QQ profile is incomplete");

  let orchestrator: QQGatewayOrchestrator;
  const makeGateway = dependencies.createGateway ?? ((opts) => new EchoAIGatewayClient(opts));
  const gateway = makeGateway({
    url,
    token,
    pluginName,
    workspace,
    model: options.model?.trim(),
    onReply: (reply) => orchestrator.onGatewayReply(reply),
  });
  orchestrator = new QQGatewayOrchestrator({
    profileId: runtime.profile.profileId,
    accountId: runtime.profile.accountId || runtime.profile.appId,
    qq: runtime.qq,
    gateway,
    dedupe: runtime.dedupe,
    replyBudget: runtime.replyBudget,
    media: runtime.media,
    model: options.model?.trim(),
    workspace,
    onError: (error) => process.stderr.write(`qqbot: ${error.message}\n`),
  });

  await gateway.start();
  let stopping: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      process.stdout.write(`qqbot: ${signal}, shutting down\n`);
      await orchestrator.stop().catch(() => undefined);
      await gateway.close();
    })();
    return stopping;
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  process.stdout.write(`qqbot: profile=${runtime.profile.profileId} gateway=${url}\n`);
  try {
    await orchestrator.start();
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
