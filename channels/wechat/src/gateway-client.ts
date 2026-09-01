/**
 * gateway-client.ts — EchoAI gateway protocol layer.
 *
 * Talks to the EchoAI gateway over JSON-RPC/WebSocket:
 *   - auth + plugin.connect{plugin_type:"channel"}
 *   - chat.completions to submit an inbound message. The server atomically
 *     routes it: it starts a turn when the session is idle, or degrades the
 *     message to a steering injection into the running turn (returning
 *     `steered:true`) when a turn is already in flight. Being headless, the
 *     channel ignores `steered` and never predicts turn state locally.
 *   - consumes the chat.event stream, accumulates assistant text per session,
 *     and emits a single reply when the turn ends
 *   - handles plugin.message (agent-initiated sends)
 *
 * Wire format verified against EchoAI:
 *   - every chat.event notification carries flattened {..., turn_id, session_key}
 *     (dispatch.rs injects them)
 *   - token/append → delta in `content`; carries `subagent_task_id` when from a
 *     subagent (we skip those — internal chatter shouldn't reach the platform)
 *   - turn/end → {type:"turn", event:"end", turn_id, status}
 *
 * Mirrors the reference EchoAI/channels/echo-channel/echo-channel.mjs.
 */

import { WebSocket } from "ws";

import { logger } from "./protocol/util/logger.js";

export type OutboundAttachment = {
  /** absolute local file path to send */
  path: string;
};

/** A reply ready to deliver to the platform (WeChat). */
export type GatewayReply = {
  sessionKey: string;
  text: string;
  /** Absolute local file paths to deliver as media (from agent send_message). */
  media?: string[];
  /**
   * When set, this reply is a terminal error notice for the turn — the
   * orchestrator should surface a friendly message instead of (or after) any
   * accumulated text. The raw cause is logged, not sent to the user.
   */
  isError?: boolean;
};

export type GatewayClientOptions = {
  url: string;
  token?: string;
  pluginName: string;
  /** Called when an assistant turn completes with accumulated text. */
  onReply: (reply: GatewayReply) => void | Promise<void>;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const RPC_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/**
 * How long submit() waits for a mid-reconnect socket to come back before
 * surfacing a failure. Covers transient drops / gateway restarts so the user
 * doesn't see an error for a blip; a genuine outage still fails after this.
 */
const SUBMIT_CONNECT_WAIT_MS = 8_000;

/**
 * Soft cap (chars) for coalescing consecutive text segments into one WeChat
 * message. EchoAI splits text into many small Step::Text segments (one per
 * message_id, e.g. progress notes between tool calls); delivering each as its
 * own WeChat message floods the per-session rate limit (~30/min) and loses
 * messages. We instead merge adjacent segments until adding the next would
 * exceed this cap, collapsing a ~23-segment turn into a handful of messages.
 * A single segment larger than the cap is still delivered on its own.
 */
const SEGMENT_MERGE_SOFT_LIMIT = 1_200;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /**
   * session_key → current in-flight text segment. Mirrors EchoAI's
   * steps.rs folding: tokens with the same message_id append to one segment;
   * a new message_id (a new Step::Text in EchoAI, i.e. text resumed after a
   * tool call) starts a fresh segment. Each completed segment is delivered to
   * WeChat as its own message.
   */
  private readonly segments = new Map<string, { msgId: string; text: string }>();
  private connected = false;
  private closing = false;
  private reconnectAttempts = 0;

  constructor(private readonly opts: GatewayClientOptions) {}

  /** Connect, auth, and register as a channel. Auto-reconnects until close(). */
  async start(): Promise<void> {
    await this.connectLoop();
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }

  // ── inbound → agent ─────────────────────────────────────────────────────

  /** Optional per-call overrides on chat.completions. */
  public submitOpts: {
    /** EchoAI model id; persisted to session if non-empty. */
    model?: string;
    /** Absolute workspace path; sets agent cwd. */
    workspace?: string;
  } = {};

  /**
   * Submit an inbound platform message. Always sends chat.completions; the
   * server atomically decides whether to start a new turn or degrade this
   * message into a steering injection on the running turn (it guarantees at
   * most one turn per session). The channel keeps no local turn state, so
   * there is no check-then-act race across a reconnect.
   */
  async submit(sessionKey: string, content: string, attachments?: OutboundAttachment[]): Promise<void> {
    // The socket may be mid-reconnect (gateway restart, transient drop). Wait
    // briefly for it to come back before giving up — the error notice the
    // orchestrator shows is meant for genuine failures, not a 1s blip.
    if (!this.connected) {
      try {
        await this.waitConnected(SUBMIT_CONNECT_WAIT_MS);
      } catch {
        throw new Error(`gateway: not connected (cannot chat.completions for ${sessionKey})`);
      }
    }

    this.segments.delete(sessionKey);
    try {
      // modes=['headless']: this channel has no UI to answer tool-approval /
      // plan-review prompts, so let EchoCode auto-approve them via HeadlessMode
      // (synthetic_auto_answer). EchoAI also force-adds headless when there's no
      // question coordinator, but we set it explicitly for clarity.
      const params: Record<string, unknown> = {
        session_key: sessionKey,
        content,
        modes: ["headless"],
      };
      if (this.submitOpts.model) params.model = this.submitOpts.model;
      if (this.submitOpts.workspace) params.workspace = this.submitOpts.workspace;
      if (attachments && attachments.length > 0) {
        params.attachments = attachments.map((a) => a.path);
      }
      await this.rpc("chat.completions", params);
    } catch (e) {
      this.segments.delete(sessionKey);
      throw e;
    }
  }

  /** List EchoAI's available models + default. Used for --model validation at startup. */
  async listModels(): Promise<{ models: Array<{ id: string }>; default_model: string }> {
    const result = (await this.rpc("model.list", {})) as
      | { models?: Array<{ id?: string }>; default_model?: string }
      | undefined;
    const models = (result?.models ?? [])
      .map((m) => ({ id: String(m.id ?? "") }))
      .filter((m) => m.id !== "");
    return { models, default_model: result?.default_model ?? "" };
  }

  /** Resolve when plugin.connect has succeeded. Used to gate startup-time RPCs. */
  async waitConnected(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected) {
      if (this.closing) throw new Error("gateway: client closed before connection");
      if (Date.now() > deadline) throw new Error(`gateway: not connected after ${timeoutMs}ms`);
      await delay(50);
    }
  }

  // ── connection lifecycle ────────────────────────────────────────────────

  private async connectLoop(): Promise<void> {
    while (!this.closing) {
      try {
        await this.connectOnce();
        this.reconnectAttempts = 0;
        // connectOnce resolves only when the socket closes.
      } catch (e) {
        logger.warn(`gateway: connection error: ${String(e)}`);
      }
      if (this.closing) break;

      const backoff = Math.min(
        RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
        RECONNECT_CAP_MS,
      );
      this.reconnectAttempts++;
      logger.info(`gateway: reconnecting in ${backoff}ms (attempt ${this.reconnectAttempts})`);
      await delay(backoff);
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      let opened = false;

      ws.on("open", () => {
        opened = true;
        void this.onOpen().catch((e) => {
          logger.error(`gateway: handshake failed: ${String(e)}`);
          ws.close();
        });
      });

      ws.on("message", (data) => this.onMessage(data.toString()));

      ws.on("close", () => {
        this.connected = false;
        // Reject all pending RPCs so callers don't hang.
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("gateway connection closed"));
        }
        this.pending.clear();
        // Drop in-flight turn accumulation (server will restart turns).
        this.segments.clear();
        logger.info("gateway: connection closed");
        resolve();
      });

      ws.on("error", (err) => {
        logger.warn(`gateway: ws error: ${String(err)}`);
        if (!opened) reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async onOpen(): Promise<void> {
    if (this.opts.token) {
      await this.rpc("auth", { token: this.opts.token });
    }
    // Note: headless is set per-turn on chat.completions (the only place it
    // actually drives synthetic_auto_answer in EchoAI's agent_loop). The
    // headless flag on plugin.connect doesn't influence chat path — so we
    // omit it here to avoid implying it does.
    await this.rpc("plugin.connect", {
      plugin_name: this.opts.pluginName,
      plugin_type: "channel",
      disable_questions: true,
    });
    this.connected = true;
    logger.info(`gateway: connected & registered as "${this.opts.pluginName}"`);
  }

  // ── message dispatch ────────────────────────────────────────────────────

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    // RPC response?
    const id = msg.id as number | undefined;
    if (id != null && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = msg.error as { message?: string };
        p.reject(new Error(err.message ?? JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Server notification
    const method = msg.method as string | undefined;
    const params = (msg.params as Record<string, unknown>) ?? {};
    if (method === "chat.event") {
      this.onChatEvent(params);
    } else if (method === "plugin.message") {
      // Platform delivery must never be an unobserved rejection: onReply can
      // reach network I/O and a rejected Promise otherwise terminates Node
      // under strict unhandled-rejection policies.
      void this.onPluginMessage(params).catch((e) =>
        logger.error(`gateway: plugin.message delivery failed: ${String(e)}`),
      );
    }
  }

  private onChatEvent(params: Record<string, unknown>): void {
    const type = params.type as string | undefined;
    const event = params.event as string | undefined;
    const sessionKey = params.session_key as string | undefined;
    if (!sessionKey) return;

    // Skip subagent internal chatter — only the main agent's output goes out.
    if (params.subagent_task_id) return;

    if (type === "token" && event === "append") {
      // EchoAI emits many small Step::Text segments (one per message_id, e.g.
      // short progress notes between tool calls). Delivering each as its own
      // WeChat message floods the rate limit. We coalesce: same message_id
      // appends to the current buffer; a *new* message_id merges into the same
      // buffer (joined by a blank line) as long as the buffer is still under
      // SEGMENT_MERGE_SOFT_LIMIT. Once the buffer reaches the cap, the next new
      // message_id flushes it (one WeChat message) and starts a fresh buffer.
      // Net effect: a ~23-segment turn collapses to a handful of messages,
      // while a single oversized segment still goes out on its own.
      const msgId = (params.message_id as string | undefined) ?? "";
      const delta = (params.content as string | undefined) ?? "";
      const seg = this.segments.get(sessionKey);
      if (!seg) {
        this.segments.set(sessionKey, { msgId, text: delta });
      } else if (seg.msgId === msgId) {
        seg.text += delta;
      } else if (seg.text.length + delta.length > SEGMENT_MERGE_SOFT_LIMIT) {
        // Merging the new segment would exceed the soft cap → deliver the
        // current buffer as its own message and start a fresh one. (A single
        // segment that is itself larger than the cap still goes out whole,
        // preserving code blocks / tables.)
        this.flushSegment(sessionKey);
        this.segments.set(sessionKey, { msgId, text: delta });
      } else {
        // Small enough to merge into the current buffer (paragraph boundary).
        seg.msgId = msgId;
        seg.text += (seg.text ? "\n\n" : "") + delta;
      }
    } else if (type === "error" && event === "raise") {
      // Record the cause; the friendly notice is emitted at turn/end. Flush any
      // text accumulated before the error so it isn't lost.
      const message = (params.message as string | undefined) ?? "unknown error";
      logger.warn(`gateway: turn error for ${sessionKey}: ${message}`);
      this.flushSegment(sessionKey);
    } else if (type === "turn" && event === "end") {
      const status = (params.status as string | undefined) ?? "done";
      // Flush whatever text remains for this turn. We deliver accumulated text
      // for every terminal status (done / cancelled / error): partial output
      // is more useful to the user than silence.
      this.flushSegment(sessionKey);

      // error / fatal → append a friendly notice (raw cause stays in the log).
      if (status === "error") {
        void Promise.resolve(
          this.opts.onReply({ sessionKey, text: "", isError: true }),
        ).catch((e) => logger.error(`gateway: onReply (error notice) failed: ${String(e)}`));
      }

      this.segments.delete(sessionKey);
    }
  }

  /**
   * Deliver the session's current text segment to the platform (one WeChat
   * message) and clear it. No-op when the segment is empty / whitespace-only.
   * Note: we intentionally do NOT trim — leading/trailing whitespace can be
   * meaningful (code blocks, ASCII tables) — but skip delivery if the whole
   * segment is blank.
   */
  private flushSegment(sessionKey: string): void {
    const seg = this.segments.get(sessionKey);
    if (!seg) return;
    this.segments.delete(sessionKey);
    if (seg.text.trim() === "") return; // nothing meaningful to send
    void Promise.resolve(this.opts.onReply({ sessionKey, text: seg.text })).catch((e) =>
      logger.error(`gateway: onReply failed: ${String(e)}`),
    );
  }

  /** Agent-initiated send (send_message tool) — deliver directly, with media. */
  private async onPluginMessage(params: Record<string, unknown>): Promise<void> {
    const sessionKey = (params.session_key as string | undefined) ?? "";
    const content = (params.content as string | undefined) ?? (params.text as string | undefined) ?? "";
    const mediaRaw = params.media as unknown;
    const media = Array.isArray(mediaRaw)
      ? mediaRaw.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [];
    if (!sessionKey) return;
    if (!content && media.length === 0) return;
    await this.opts.onReply({ sessionKey, text: content, media: media.length ? media : undefined });
  }

  // ── JSON-RPC ────────────────────────────────────────────────────────────

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`gateway: not connected (cannot ${method})`));
    }
    const id = this.nextId++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`gateway: rpc ${method} timed out`));
        }
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
