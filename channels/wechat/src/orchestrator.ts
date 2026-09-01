/**
 * orchestrator.ts — glue between WeChat (protocol layer) and EchoAI (gateway).
 *
 * Responsibilities (mirrors the proven Python echobot_wechat.plugin):
 *   - long-poll getUpdates for inbound WeChat messages
 *   - turn each inbound message into a gateway turn (chat.completions / enqueue)
 *   - on the agent's reply, send it back to the originating WeChat user
 *   - resolve a per-conversation session_key (channel:session is one-to-many)
 *   - persist the getUpdates cursor + the per-user context_token (needed to reply)
 *
 * Media (inbound attachments + outbound files) is added in W5.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getUpdates,
  sendMessage,
  notifyStart,
  notifyStop,
  WeixinSendError,
} from "./protocol/api/api.js";
import type { WeixinMessage, MessageItem } from "./protocol/api/types.js";
import { weixinMessageToMsgContext, isMediaItem, type WeixinMsgContext } from "./protocol/messaging/inbound.js";
import { downloadMediaFromItem } from "./protocol/media/media-download.js";
import { sendWeixinMediaFile } from "./protocol/messaging/send-media.js";
import {
  getSyncBufFilePath,
  loadGetUpdatesBuf,
  saveGetUpdatesBuf,
} from "./protocol/storage/sync-buf.js";
import { resolveStateDir } from "./protocol/storage/state-dir.js";
import { logger } from "./protocol/util/logger.js";
import { GatewayClient, type GatewayReply } from "./gateway-client.js";
import { OutboundQueue } from "./outbound-queue.js";

export type OrchestratorOptions = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  gateway: GatewayClient;
  /**
   * EchoAI session_key for this bot. A WeChat bot account only receives
   * messages from one fixed peer, so the channel uses a single session_key
   * for the whole process lifetime (default: `wechat:<accountId>`).
   */
  sessionKey: string;
  /** EchoAI model id; per-turn override on chat.completions. */
  defaultModel?: string;
  /** Absolute workspace path; per-turn override on chat.completions. */
  defaultWorkspace?: string;
};

const DEFAULT_LONG_POLL_TIMEOUT_MS = 30_000;
const ERROR_BACKOFF_MS = 5_000;
const MAX_CONCURRENT_INBOUND = 4;
const MAX_PENDING_INBOUND = 100;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MEDIA_TMP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MEDIA_TMP_MAX_BYTES = 512 * 1024 * 1024;

/** Friendly notice sent to the user when a turn ends in error (raw cause stays in the log). */
const ERROR_NOTICE = "（处理出错了，请稍后再试）";

export class Orchestrator {
  private readonly accountId: string;
  private readonly baseUrl: string;
  private readonly cdnBaseUrl: string;
  private readonly token: string;
  private readonly gateway: GatewayClient;
  private readonly sessionKey: string;
  private readonly mediaTmpDir: string;

  private readonly syncBufPath: string;
  private getUpdatesBuf: string;

  /** Serializes + paces + retries every outbound send (rate-limit safe). */
  private readonly outbound: OutboundQueue;

  /** Most recent peer who messaged us (to_user for replies). */
  private lastFromUser = "";
  /** WeChat user id → latest context_token (required by sendMessage). */
  private readonly userContextToken = new Map<string, string>();

  private running = false;
  private readonly pollAbort = new AbortController();
  private activeInbound = 0;
  private readonly pendingInbound: WeixinMessage[] = [];

  constructor(opts: OrchestratorOptions) {
    this.accountId = opts.accountId;
    this.baseUrl = opts.baseUrl;
    this.cdnBaseUrl = opts.cdnBaseUrl;
    this.token = opts.token;
    this.gateway = opts.gateway;
    this.sessionKey = opts.sessionKey;

    // Per-turn overrides flow to the gateway through this shared bag.
    this.gateway.submitOpts = {
      model: opts.defaultModel,
      workspace: opts.defaultWorkspace,
    };

    this.mediaTmpDir = path.join(resolveStateDir(), "media-tmp");
    fs.mkdirSync(this.mediaTmpDir, { recursive: true });
    this.pruneMediaTmp();

    this.syncBufPath = getSyncBufFilePath(this.accountId);
    this.getUpdatesBuf = loadGetUpdatesBuf(this.syncBufPath) ?? "";

    // All outbound sends funnel through here: serialized, paced, and retried
    // with backoff on rate-limit (ret=-2) instead of being dropped. WeChat caps
    // a session at ~30 msgs/min; we pace at 2.2s (~27/min) to stay under it,
    // with backoff as a safety net for bursts that still hit the limit.
    this.outbound = new OutboundQueue({
      minIntervalMs: 2_200,
      maxPending: 100,
      isRetryable: (err) => err instanceof WeixinSendError && err.rateLimited,
      onError: (msg) => logger.error(`orchestrator: ${msg}`),
      onDrop: (msg) => logger.error(`orchestrator: ${msg}`),
    });
  }

  async start(): Promise<void> {
    this.running = true;
    try {
      await notifyStart({ baseUrl: this.baseUrl, token: this.token });
    } catch (e) {
      logger.warn(`orchestrator: notifyStart failed (continuing): ${String(e)}`);
    }
    logger.info(`orchestrator: started for account=${this.accountId}`);
    await this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort.abort();
    this.outbound.stop();
    try {
      await notifyStop({ baseUrl: this.baseUrl, token: this.token });
    } catch {
      // best-effort
    }
  }

  // ── inbound long-poll loop ───────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    let timeout = DEFAULT_LONG_POLL_TIMEOUT_MS;

    while (this.running) {
      let resp;
      try {
        resp = await getUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          get_updates_buf: this.getUpdatesBuf,
          timeoutMs: timeout,
          abortSignal: this.pollAbort.signal,
        });
      } catch (e) {
        if (!this.running) break;
        logger.warn(`orchestrator: getUpdates error: ${String(e)}`);
        await delay(ERROR_BACKOFF_MS);
        continue;
      }

      if (resp.ret !== undefined && resp.ret !== 0) {
        logger.error(`orchestrator: getUpdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
        await delay(ERROR_BACKOFF_MS);
        continue;
      }

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeout = resp.longpolling_timeout_ms;
      }

      // Persist the cursor as soon as it advances.
      if (resp.get_updates_buf && resp.get_updates_buf !== this.getUpdatesBuf) {
        this.getUpdatesBuf = resp.get_updates_buf;
        try {
          saveGetUpdatesBuf(this.syncBufPath, this.getUpdatesBuf);
        } catch (e) {
          logger.warn(`orchestrator: failed to persist sync buf: ${String(e)}`);
        }
      }

      for (const msg of resp.msgs ?? []) {
        this.enqueueInbound(msg);
      }
    }
  }

  // ── inbound → gateway ─────────────────────────────────────────────────────

  /** Bound inbound work so a burst cannot create unbounded media downloads/turns. */
  private enqueueInbound(msg: WeixinMessage): void {
    if (!this.running) return;
    if (this.activeInbound >= MAX_CONCURRENT_INBOUND) {
      if (this.pendingInbound.length >= MAX_PENDING_INBOUND) {
        logger.error(`orchestrator: inbound dropped because ${MAX_PENDING_INBOUND} messages are already pending`);
        return;
      }
      this.pendingInbound.push(msg);
      return;
    }
    this.activeInbound += 1;
    void this.handleInbound(msg)
      .catch((e) => logger.error(`orchestrator: handleInbound failed: ${String(e)}`))
      .finally(() => {
        this.activeInbound -= 1;
        const next = this.pendingInbound.shift();
        if (next) this.enqueueInbound(next);
      });
  }

  private pruneMediaTmp(): void {
    try {
      const now = Date.now();
      const entries = fs.readdirSync(this.mediaTmpDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const filePath = path.join(this.mediaTmpDir, entry.name);
          return { filePath, stat: fs.statSync(filePath) };
        })
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      let total = entries.reduce((sum, entry) => sum + entry.stat.size, 0);
      for (const entry of entries) {
        if (now - entry.stat.mtimeMs > MEDIA_TMP_TTL_MS || total > MEDIA_TMP_MAX_BYTES) {
          fs.unlinkSync(entry.filePath);
          total -= entry.stat.size;
        }
      }
    } catch (e) {
      logger.warn(`orchestrator: failed to prune media temp directory: ${String(e)}`);
    }
  }

  private async saveInboundMedia(
    buffer: Buffer,
    contentType?: string,
    _subdir?: string,
    maxBytes = MAX_MEDIA_BYTES,
    originalFilename?: string,
  ): Promise<{ path: string }> {
    if (buffer.length > maxBytes) {
      throw new Error(`inbound media exceeds ${maxBytes} byte limit (${buffer.length} bytes)`);
    }
    this.pruneMediaTmp();
    const ext = extFor(contentType, originalFilename);
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const dest = path.join(this.mediaTmpDir, name);
    await fs.promises.writeFile(dest, buffer);
    return { path: dest };
  }

  private async handleInbound(msg: WeixinMessage): Promise<void> {
    const fromUser = (msg.from_user_id ?? "").trim();
    if (!fromUser) return;

    const ctx: WeixinMsgContext = weixinMessageToMsgContext(msg, this.accountId);

    // Remember the context_token — required to send replies back to this user.
    const contextToken = (msg.context_token ?? ctx.context_token ?? "").trim();
    if (contextToken) {
      this.userContextToken.set(fromUser, contextToken);
    }

    // Download any media items → local temp files → pass as attachments.
    const attachments = await this.downloadInboundMedia(msg);

    const text = (ctx.Body ?? "").trim();
    if (!text && attachments.length === 0) {
      logger.info(`orchestrator: inbound from=${fromUser} had no usable content`);
      return;
    }

    // WeChat bot accounts only ever talk to one fixed peer (1:1), so the
    // session_key is a process-lifetime constant. We just remember the latest
    // from_user so replies routed back via onGatewayReply hit the right inbox.
    this.lastFromUser = fromUser;

    // When media-only, give the agent a hint so it knows a file arrived.
    const content = text || (attachments.length ? `[${attachments.length} media file(s)]` : "");

    logger.info(
      `orchestrator: inbound from=${fromUser} session=${this.sessionKey} text=${truncate(text, 80)} media=${attachments.length}`,
    );

    try {
      await this.gateway.submit(this.sessionKey, content, attachments.map((p) => ({ path: p })));
    } catch (e) {
      logger.error(`orchestrator: gateway.submit failed: ${String(e)}`);
      this.enqueueText(fromUser, "（暂时无法处理你的消息，请稍后再试）");
    }
  }

  /** Download every media item in a message to local temp files. */
  private async downloadInboundMedia(msg: WeixinMessage): Promise<string[]> {
    const items = (msg.item_list ?? []).filter((it): it is MessageItem => isMediaItem(it));
    if (items.length === 0) return [];

    const paths: string[] = [];
    for (const item of items) {
      try {
        const media = await downloadMediaFromItem(item, {
          cdnBaseUrl: this.cdnBaseUrl,
          saveMedia: (buffer, contentType, subdir, maxBytes, originalFilename) =>
            this.saveInboundMedia(buffer, contentType, subdir, maxBytes, originalFilename),
          log: (m) => logger.debug(`media: ${m}`),
          errLog: (m) => logger.warn(`media: ${m}`),
          label: "inbound",
        });
        const p =
          media.decryptedPicPath ??
          media.decryptedFilePath ??
          media.decryptedVideoPath ??
          media.decryptedVoicePath;
        if (p) paths.push(p);
      } catch (e) {
        logger.warn(`orchestrator: media download failed: ${String(e)}`);
      }
    }
    return paths;
  }

  // ── gateway reply → WeChat ────────────────────────────────────────────────

  /** Wire this as the GatewayClient onReply handler. */
  onGatewayReply = async (reply: GatewayReply): Promise<void> => {
    // sessionKey is process-constant; the only routing fact we need is who to
    // send back to, which is whoever last messaged us.
    if (reply.sessionKey !== this.sessionKey) {
      logger.warn(
        `orchestrator: reply for unexpected session=${reply.sessionKey} (expected ${this.sessionKey}), dropping`,
      );
      return;
    }
    const toUser = this.lastFromUser;
    if (!toUser) {
      logger.warn(`orchestrator: reply arrived but no peer has messaged yet, dropping`);
      return;
    }
    // Terminal error notice for the turn — friendly text, raw cause already logged.
    if (reply.isError) {
      this.enqueueText(toUser, ERROR_NOTICE);
      return;
    }
    const media = reply.media ?? [];
    if (media.length > 0) {
      // Deliver text and media as independent queued sends. We deliberately do
      // NOT pass the text as a media caption: sendWeixinMediaFile issues TWO
      // CGI calls (caption text item, then media item), so retrying the media
      // as one unit (on rate-limit) would re-send the caption — duplicating
      // what is often the whole answer. Decoupling keeps each send atomic.
      if (reply.text) this.enqueueText(toUser, reply.text);
      for (const filePath of media) {
        this.enqueueMedia(toUser, filePath);
      }
      return;
    }
    if (reply.text) {
      this.enqueueText(toUser, reply.text);
    }
  };

  /** Queue a text send (serialized + paced + rate-limit-retried). */
  private enqueueText(toUser: string, text: string): void {
    this.outbound.enqueue(() => this.doSendText(toUser, text), `text→${toUser}`);
  }

  /** Queue a media send (serialized + paced + rate-limit-retried). */
  private enqueueMedia(toUser: string, filePath: string): void {
    this.outbound.enqueue(() => this.doSendMedia(toUser, filePath), `media→${toUser}`);
  }

  /**
   * Perform a media send. Throws on rate-limit so the queue backs off + retries;
   * other failures are logged loudly and dropped (the queue treats them as
   * non-retryable). Text is delivered as a separate queued send (see
   * onGatewayReply), so there is no caption to fall back to here.
   */
  private async doSendMedia(toUser: string, filePath: string): Promise<void> {
    const contextToken = this.userContextToken.get(toUser) ?? "";
    await sendWeixinMediaFile({
      filePath,
      to: toUser,
      text: "",
      opts: { baseUrl: this.baseUrl, token: this.token, contextToken },
      cdnBaseUrl: this.cdnBaseUrl,
    });
    logger.info(`orchestrator: sent media → ${toUser} file=${path.basename(filePath)}`);
  }

  /**
   * Perform a text send. Throws on failure (incl. rate-limit) so the queue can
   * retry; the queue logs loudly when it ultimately gives up — no silent drop.
   */
  private async doSendText(toUser: string, text: string): Promise<void> {
    const contextToken = this.userContextToken.get(toUser) ?? "";
    await sendMessage({
      baseUrl: this.baseUrl,
      token: this.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: toUser,
          client_id: generateClientId(),
          message_type: 2, // BOT
          message_state: 2, // FINISH
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
      },
    });
    logger.info(`orchestrator: sent reply → ${toUser} (${text.length} chars)`);
  }
}

function generateClientId(): string {
  return randomUUID().replace(/-/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Pick a file extension from content-type or original filename. */
function extFor(contentType?: string, originalFilename?: string): string {
  if (originalFilename) {
    const e = path.extname(originalFilename);
    if (e) return e;
  }
  switch (contentType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "video/mp4":
      return ".mp4";
    case "audio/wav":
      return ".wav";
    case "audio/silk":
      return ".silk";
    default:
      return ".bin";
  }
}
