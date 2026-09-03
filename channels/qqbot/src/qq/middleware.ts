import { EventDedupe } from "../storage/event-dedupe.js";
import type { QQClient, QQInboundMessage, QQMiddleware } from "./client.js";
import { runSerial } from "./peer-serial.js";
import { sanitizeQQText } from "./sanitize.js";

export interface PipelineOptions {
  dedupe: EventDedupe;
  onMessage: (message: QQInboundMessage) => Promise<void>;
  rateLimit?: { windowMs: number; max: number };
  onError?: (error: Error) => void;
}

function eventKey(message: QQInboundMessage): string { return message.eventId || message.messageId; }
function peerKey(message: QQInboundMessage): string { return `${message.replyTarget.scope}:${message.replyTarget.targetId}`; }

export function installInboundPipeline(client: QQClient, options: PipelineOptions): readonly string[] {
  const order: string[] = [];
  const use = (name: string, middleware: QQMiddleware): void => { order.push(name); client.use(middleware); };

  use("error", async (_ctx, next) => {
    try { await next(); } catch (error) { options.onError?.(error instanceof Error ? error : new Error(String(error))); }
  });

  use("dedupe", async (ctx, next) => {
    const key = eventKey(ctx.message);
    if (!options.dedupe.reserve(key)) return ctx.stop("duplicate");
    try { await next(); await options.dedupe.commit(key); }
    catch (error) { options.dedupe.rollback(key); throw error; }
  });

  use("mention-gate", async (ctx, next) => {
    if (ctx.message.replyTarget.scope === "group") {
      const mentioned = ctx.message.mentions?.some((item) => item.id === "bot" || item.user_openid === "bot")
        || /<@!?bot>/.test(ctx.message.content);
      if (!mentioned) return ctx.stop("group message did not mention bot");
    }
    await next();
  });

  use("sanitize", async (ctx, next) => {
    ctx.message.content = sanitizeQQText(ctx.message.content.replace(/<@!?bot>/g, ""));
    if (!ctx.message.content) return ctx.stop("empty message");
    await next();
  });

  const buckets = new Map<string, number[]>();
  use("rate-limit", async (ctx, next) => {
    const config = options.rateLimit ?? { windowMs: 60_000, max: 20 };
    const now = Date.now();
    const recent = (buckets.get(peerKey(ctx.message)) ?? []).filter((time) => now - time < config.windowMs);
    if (recent.length >= config.max) return ctx.stop("rate limited");
    recent.push(now); buckets.set(peerKey(ctx.message), recent);
    await next();
  });

  use("peer-serial", (ctx, next) => runSerial(peerKey(ctx.message), next));
  client.on("message", async (_context, message) => { await options.onMessage(message); });
  return order;
}
