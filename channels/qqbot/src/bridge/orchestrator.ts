import type { EchoAIGatewayClient, GatewayReply, SubmitResult } from "../gateway/echoai-client.js";

export type QQScope = "c2c" | "group";

export type QQInboundMessage = {
  eventId: string;
  msgId: string;
  scope: QQScope;
  targetId: string;
  text?: string;
  receivedAt?: number;
  media?: unknown[];
};

export type QQReplyContext = Readonly<{
  profileId: string;
  accountId: string;
  scope: QQScope;
  targetId: string;
  msgId: string;
  eventId: string;
  receivedAt: number;
}>;

export interface QQClient {
  start(handler: (message: QQInboundMessage) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendText(context: QQReplyContext, text: string, allocation?: unknown): Promise<void>;
  sendMedia(context: QQReplyContext, media: string, allocation?: unknown): Promise<void>;
}

export interface EventDedupe {
  /** Returns true only when this event was not seen before and is now reserved. */
  claim(eventId: string): boolean | Promise<boolean>;
  /** Persist only after EchoAI has reliably accepted the inbound message. */
  commit?(eventId: string): void | Promise<void>;
  rollback?(eventId: string): void | Promise<void>;
}

export interface ReplyBudget {
  reserve(context: QQReplyContext, kind: "text" | "media"): unknown | Promise<unknown>;
  commit?(allocation: unknown): void | Promise<void>;
  release?(allocation: unknown): void | Promise<void>;
  rollback?(allocation: unknown): void | Promise<void>;
}

export interface QQMediaBridge {
  inbound?(items: unknown[], message: QQInboundMessage): Promise<string[]>;
  outbound?(source: string, context: QQReplyContext): Promise<string>;
}

export type QQOrchestratorOptions = {
  profileId: string;
  accountId: string;
  qq: QQClient;
  gateway: Pick<EchoAIGatewayClient, "submit">;
  dedupe: EventDedupe;
  replyBudget: ReplyBudget;
  media?: QQMediaBridge;
  model?: string;
  workspace?: string;
  onError?: (error: Error) => void;
};

const separator = ":";

export function qqSessionKey(profileId: string, scope: QQScope, targetId: string): string {
  if (!profileId.trim() || !targetId.trim()) throw new Error("profileId and targetId are required");
  return ["qqbot", encodeURIComponent(profileId), scope, encodeURIComponent(targetId)].join(separator);
}

/** Reversible parser used for rejecting plugin.message addressed to another profile. */
export function parseQQSessionKey(value: string): { profileId: string; scope: QQScope; targetId: string } | null {
  const parts = value.split(separator);
  if (parts.length !== 4 || parts[0] !== "qqbot" || (parts[2] !== "c2c" && parts[2] !== "group")) return null;
  try {
    return { profileId: decodeURIComponent(parts[1]), scope: parts[2], targetId: decodeURIComponent(parts[3]) };
  } catch { return null; }
}

const replyKey = (sessionKey: string, turnId: string) => `${sessionKey}\u0000${turnId}`;

/**
 * Bridges QQ and EchoAI while pinning every turn to its immutable inbound reply context.
 * It never routes through a global "last sender", so interleaved conversations cannot cross.
 */
export class QQGatewayOrchestrator {
  private readonly turnContexts = new Map<string, QQReplyContext>();
  private readonly sessionContexts = new Map<string, QQReplyContext>();
  private readonly earlyReplies = new Map<string, GatewayReply[]>();
  private started = false;

  constructor(private readonly options: QQOrchestratorOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.options.qq.start((message) => this.handleInbound(message));
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.qq.stop();
  }

  async handleInbound(message: QQInboundMessage): Promise<void> {
    try {
      if (!message.eventId || !message.msgId || !message.targetId) throw new Error("invalid QQ inbound message");
      const claimed = await this.options.dedupe.claim(message.eventId);
      if (!claimed) return;
      try {
        const attachments = this.options.media?.inbound && message.media?.length
          ? await this.options.media.inbound(message.media, message)
          : [];
        const text = message.text?.trim() || (attachments.length ? `[${attachments.length} media file(s)]` : "");
        if (!text && attachments.length === 0) {
          await this.options.dedupe.commit?.(message.eventId);
          return;
        }

        const sessionKey = qqSessionKey(this.options.profileId, message.scope, message.targetId);
        const context: QQReplyContext = Object.freeze({
          profileId: this.options.profileId,
          accountId: this.options.accountId,
          scope: message.scope,
          targetId: message.targetId,
          msgId: message.msgId,
          eventId: message.eventId,
          receivedAt: message.receivedAt ?? Date.now(),
        });
        // This immutable value is only for proactive plugin.message fallback. Existing turn binding is never replaced.
        this.sessionContexts.set(sessionKey, context);
        const result = await this.options.gateway.submit(sessionKey, text, {
          model: this.options.model,
          workspace: this.options.workspace,
          attachments,
        });
        this.bindTurn(result, context);
        await this.options.dedupe.commit?.(message.eventId);
      } catch (error) {
        await this.options.dedupe.rollback?.(message.eventId);
        throw error;
      }
    } catch (error) {
      this.report(error);
    }
  }

  async onGatewayReply(reply: GatewayReply): Promise<void> {
    const parsed = parseQQSessionKey(reply.sessionKey);
    if (!parsed || parsed.profileId !== this.options.profileId) return;
    let context: QQReplyContext | undefined;
    if (reply.turnId) context = this.turnContexts.get(replyKey(reply.sessionKey, reply.turnId));
    else context = this.sessionContexts.get(reply.sessionKey);

    // chat.event is allowed to beat the chat.completions RPC response. Hold it until bindTurn runs.
    if (!context && reply.turnId) {
      const key = replyKey(reply.sessionKey, reply.turnId);
      const waiting = this.earlyReplies.get(key) ?? [];
      waiting.push({ ...reply, media: reply.media ? [...reply.media] : undefined });
      this.earlyReplies.set(key, waiting);
      return;
    }
    if (!context) return;
    await this.deliver(context, reply);
  }

  private bindTurn(result: SubmitResult, context: QQReplyContext): void {
    const key = replyKey(result.sessionKey, result.turnId);
    // Enqueued steering belongs to the already-bound turn; never replace its original reply context.
    if (result.started && !this.turnContexts.has(key)) this.turnContexts.set(key, context);
    const waiting = this.earlyReplies.get(key);
    if (waiting && this.turnContexts.has(key)) {
      this.earlyReplies.delete(key);
      for (const reply of waiting) void this.deliver(this.turnContexts.get(key)!, reply).catch((e) => this.report(e));
    }
  }

  private async deliver(context: QQReplyContext, reply: GatewayReply): Promise<void> {
    if (reply.text) await this.withBudget(context, "text", (allocation) => this.options.qq.sendText(context, reply.text, allocation));
    for (const source of reply.media ?? []) {
      const media = this.options.media?.outbound ? await this.options.media.outbound(source, context) : source;
      await this.withBudget(context, "media", (allocation) => this.options.qq.sendMedia(context, media, allocation));
    }
  }

  private async withBudget(context: QQReplyContext, kind: "text" | "media", send: (allocation: unknown) => Promise<void>): Promise<void> {
    const allocation = await this.options.replyBudget.reserve(context, kind);
    try {
      await send(allocation);
      await this.options.replyBudget.commit?.(allocation);
    } catch (error) {
      const rollback = this.options.replyBudget.release ?? this.options.replyBudget.rollback;
      await rollback?.call(this.options.replyBudget, allocation);
      throw error;
    }
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

export { QQGatewayOrchestrator as Orchestrator };
