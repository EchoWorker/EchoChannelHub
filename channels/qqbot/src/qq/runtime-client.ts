import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { QQClient as BridgeClient, QQInboundMessage as BridgeInbound, QQReplyContext } from "../bridge/orchestrator.js";
import type { QqBotProfile } from "../profile/store.js";
import { createSDKClient } from "./sdk-client.js";
import type { QQClient as PlatformClient, QQInboundMessage as PlatformInbound, QQTarget } from "./client.js";
import { QQOutbound } from "./outbound.js";
import { ReplyBudget, type ReplyReservation } from "./reply-budget.js";

export type RuntimeQQClient = BridgeClient & { budget: ReplyBudget };

/** Adapt the Tencent SDK facade to the host-neutral bridge contract. */
export async function createRuntimeQQClient(profile: QqBotProfile, dataDir: string): Promise<RuntimeQQClient> {
  await mkdir(dataDir, { recursive: true });
  const sdk: PlatformClient = createSDKClient({ appId: profile.appId, appSecret: profile.appSecret, accountId: profile.profileId, dataDir });
  const budget = new ReplyBudget();
  const outbound = new QQOutbound(sdk, budget);
  let abort: AbortController | undefined;

  const target = (context: QQReplyContext): QQTarget => ({ scope: context.scope, targetId: context.targetId });
  const passive = (allocation: unknown) => {
    const item = allocation as ReplyReservation | undefined;
    return item ? { scene: item.scene, msgId: item.msgId } : undefined;
  };

  return {
    budget,
    async start(handler: (message: BridgeInbound) => void | Promise<void>): Promise<void> {
      sdk.on("message", async (_context, message: PlatformInbound) => {
        const scope = message.replyTarget.scope;
        if (scope !== "c2c" && scope !== "group") return;
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        await handler({
          eventId: message.eventId || message.messageId,
          msgId: message.messageId,
          scope,
          targetId: message.replyTarget.targetId,
          text: message.content,
          receivedAt: typeof message.timestamp === "string" ? Date.parse(message.timestamp) : Date.now(),
          media: attachments,
        });
      });
      abort = new AbortController();
      await sdk.start(abort.signal);
    },
    async stop(): Promise<void> { abort?.abort(); await sdk.stop(); },
    async sendText(context, text, allocation): Promise<void> {
      // The orchestrator owns reservation lifecycle, so pass its exact sequence directly.
      const reservation = allocation as ReplyReservation | undefined;
      await sdk.sendText({ ...target(context), ...(reservation ? { msgId: reservation.msgId, msgSeq: reservation.msgSeq } : {}) }, text);
    },
    async sendMedia(context, media, allocation): Promise<void> {
      const reservation = allocation as ReplyReservation | undefined;
      const source = /^https:\/\//i.test(media) ? { url: media } : { localPath: path.resolve(media) };
      await sdk.sendImage({ ...target(context), ...(reservation ? { msgId: reservation.msgId, msgSeq: reservation.msgSeq } : {}) }, source);
    },
  };
}
