// This is the only module allowed to depend on Tencent's SDK. The rest of the
// platform layer targets the deliberately small QQClient interface.
import {
  FileKVStore,
  QQBot,
  concurrencyGuard,
  contentSanitizer,
  errorHandler,
  mentionGate,
  messageFilter,
  rateLimiter,
  kvSessionPersistence,
  type MiddlewareContext,
  type QQBotInboundMessage,
} from "@tencent-connect/qqbot-nodejs";
import type { QQClient, QQInboundMessage, QQMiddleware, QQSendResult, QQTarget } from "./client.js";

export interface SDKClientOptions {
  appId: string;
  appSecret: string;
  accountId: string;
  dataDir: string;
}

export function createSDKClient(options: SDKClientOptions): QQClient {
  const bot = new QQBot({
    appId: options.appId,
    appSecret: options.appSecret,
    accountId: options.accountId,
    transport: "websocket",
    tokenPrefetch: "sync",
    sessionPersistence: kvSessionPersistence({
      store: new FileKVStore({ dir: options.dataDir, fileName: "wss-session.json" }),
      accountId: options.accountId,
    }),
  });

  bot.use(errorHandler());
  bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5 * 60_000 } }));
  bot.use(mentionGate({ requireMentionInGroup: true }));
  bot.use(contentSanitizer({ stripBotMention: true, parseFaceTags: true }));
  bot.use(rateLimiter());
  bot.use(concurrencyGuard({ strategy: "queue", maxQueue: 50 }));

  return {
    use(middleware: QQMiddleware): void {
      bot.use((context, next) => middleware(context as unknown as Parameters<QQMiddleware>[0], next));
    },
    on(event: "message" | "ready" | "resumed" | "error", listener: ((...args: never[]) => unknown)): void {
      if (event === "message") {
        bot.on("message", async (context: MiddlewareContext, message: QQBotInboundMessage) => {
          await (listener as unknown as (c: unknown, m: QQInboundMessage) => void | Promise<void>)(context, message as unknown as QQInboundMessage);
        });
      } else if (event === "error") {
        bot.on("error", listener as unknown as (error: Error) => void);
      } else {
        bot.on(event, listener as unknown as (data: unknown) => void);
      }
    },
    start: (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      let ready = false;
      const onReady = () => {
        if (ready) return;
        ready = true;
        bot.off("ready", onReady);
        bot.off("resumed", onReady);
        resolve();
      };
      bot.on("ready", onReady);
      bot.on("resumed", onReady);
      void bot.start(signal).then(() => {
        if (!ready) reject(new Error("QQ Bot stopped before becoming ready"));
      }, (error: unknown) => {
        if (!ready) reject(error instanceof Error ? error : new Error(String(error)));
      });
    }),
    stop: async () => { bot.stop(); },
    sendText: (target: QQTarget, text: string) => bot.send({
      target,
      content: text,
      extra: target.msgSeq === undefined ? undefined : { msg_seq: target.msgSeq },
    }) as Promise<QQSendResult>,
    async sendImage(target: QQTarget, source: { url?: string; localPath?: string; fileData?: string }, text?: string): Promise<QQSendResult> {
      const upload = await bot.uploadMedia({ target, fileType: 1, ...source, srvSendMsg: false });
      return bot.send({
        target,
        content: text,
        media: { file_info: upload.file_info },
        extra: target.msgSeq === undefined ? undefined : { msg_seq: target.msgSeq },
      });
    },
  };
}
