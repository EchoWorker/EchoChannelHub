import WebSocket, { type RawData } from "ws";

export type GatewayReply = {
  sessionKey: string;
  turnId?: string;
  text: string;
  media?: string[];
  isError?: boolean;
};

export type SubmitOptions = {
  model?: string;
  workspace?: string;
  attachments?: string[];
};

export type SubmitResult = { sessionKey: string; turnId: string; started: boolean };

export type EchoAIGatewayOptions = {
  url: string;
  token?: string;
  pluginName: string;
  workspace?: string;
  model?: string;
  onReply: (reply: GatewayReply) => void | Promise<void>;
  websocketFactory?: (url: string) => WebSocket;
  rpcTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnBuffer = { sessionKey: string; turnId: string; text: string; ended: boolean };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const turnKey = (sessionKey: string, turnId: string) => `${sessionKey}\u0000${turnId}`;

/** EchoAI's JSON-RPC transport and turn aggregator for the QQ channel. */
export class EchoAIGatewayClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly turns = new Map<string, TurnBuffer>();
  private readonly activeTurns = new Map<string, string>();
  private readonly endedTurns = new Set<string>();
  private readonly submitTails = new Map<string, Promise<unknown>>();
  private closing = false;
  private connected = false;
  private reconnectAttempt = 0;
  private runPromise: Promise<void> | null = null;
  private firstConnection: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly options: EchoAIGatewayOptions) {}

  /** Starts the reconnect loop and resolves after the first successful plugin.connect. */
  start(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (!this.runPromise) this.runPromise = this.run();
    return new Promise<void>((resolve, reject) => {
      this.firstConnection = { resolve, reject };
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    this.rejectPending(new Error("gateway client closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    await this.runPromise?.catch(() => undefined);
  }

  isConnected(): boolean {
    return this.connected;
  }

  submit(sessionKey: string, content: string, options: SubmitOptions = {}): Promise<SubmitResult> {
    if (!sessionKey.trim()) return Promise.reject(new Error("sessionKey is required"));
    // Serialize the check/start operation per session. Different QQ conversations remain parallel.
    const previous = this.submitTails.get(sessionKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.submitLocked(sessionKey, content, options));
    this.submitTails.set(sessionKey, operation);
    void operation.finally(() => {
      if (this.submitTails.get(sessionKey) === operation) this.submitTails.delete(sessionKey);
    }).catch(() => undefined);
    return operation;
  }

  async listModels(): Promise<{ models: Array<{ id: string }>; default_model: string }> {
    const value = (await this.rpc("model.list", {})) as { models?: Array<{ id?: unknown }>; default_model?: unknown };
    return {
      models: (value?.models ?? []).map((m) => ({ id: String(m.id ?? "") })).filter((m) => m.id),
      default_model: typeof value?.default_model === "string" ? value.default_model : "",
    };
  }

  private async submitLocked(sessionKey: string, content: string, options: SubmitOptions): Promise<SubmitResult> {
    this.requireConnected();
    const active = this.activeTurns.get(sessionKey);

    // EchoAI atomically starts a turn or turns this same call into steering. The
    // channel must not predict that state with a separate method/check.
    const params: Record<string, unknown> = {
      session_key: sessionKey,
      content,
      modes: ["headless"],
    };
    const model = options.model ?? this.options.model;
    const workspace = options.workspace ?? this.options.workspace;
    if (model) params.model = model;
    if (workspace) params.workspace = workspace;
    if (options.attachments?.length) params.attachments = options.attachments;

    const result = (await this.rpc("chat.completions", params)) as { session_key?: unknown; turn_id?: unknown; steered?: unknown };
    const resolvedSession = typeof result?.session_key === "string" && result.session_key ? result.session_key : sessionKey;
    const turnId = typeof result?.turn_id === "string" ? result.turn_id : "";
    if (result?.steered === true) {
      if (!turnId && !active) throw new Error("gateway: steered response returned no active turn_id");
      return { sessionKey: resolvedSession, turnId: turnId || active!, started: false };
    }
    if (!turnId) throw new Error("gateway: chat.completions returned no turn_id");
    const key = turnKey(resolvedSession, turnId);
    const buffer = this.turns.get(key);
    if (!buffer?.ended && !this.endedTurns.delete(key)) this.activeTurns.set(resolvedSession, turnId);
    return { sessionKey: resolvedSession, turnId, started: true };
  }

  private async run(): Promise<void> {
    while (!this.closing) {
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
      } catch (error) {
        if (this.firstConnection && !this.connected) {
          // Keep retrying, but callers should receive the initial connection failure.
          this.firstConnection.reject(error instanceof Error ? error : new Error(String(error)));
          this.firstConnection = null;
        }
      }
      if (this.closing) break;
      const base = this.options.reconnectBaseMs ?? 500;
      const cap = this.options.reconnectCapMs ?? 30_000;
      await delay(Math.min(cap, base * 2 ** this.reconnectAttempt++));
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.options.websocketFactory?.(this.options.url) ?? new WebSocket(this.options.url);
      this.socket = socket;
      let opened = false;
      let settled = false;
      socket.once("open", () => {
        opened = true;
        void this.handshake().then(() => {
          this.connected = true;
          this.firstConnection?.resolve();
          this.firstConnection = null;
        }).catch((error) => {
          if (!settled) reject(error instanceof Error ? error : new Error(String(error)));
          socket.close();
        });
      });
      socket.on("message", (data: RawData) => this.onMessage(data.toString()));
      socket.once("error", (error: Error) => {
        if (!opened && !settled) { settled = true; reject(error); }
      });
      socket.once("close", () => {
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        this.rejectPending(new Error("gateway connection closed"));
        this.activeTurns.clear();
        this.turns.clear();
        if (!settled) { settled = true; resolve(); }
      });
    });
  }

  private async handshake(): Promise<void> {
    if (this.options.token) await this.rpc("auth", { token: this.options.token });
    await this.rpc("plugin.connect", {
      plugin_name: this.options.pluginName,
      plugin_type: "channel",
      disable_questions: true,
      ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
    });
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const rpcError = message.error as { message?: unknown };
        pending.reject(new Error(typeof rpcError.message === "string" ? rpcError.message : "gateway RPC error"));
      } else pending.resolve(message.result);
      return;
    }
    const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
    if (message.method === "chat.event") this.onChatEvent(params);
    if (message.method === "plugin.message") void this.onPluginMessage(params);
  }

  private onChatEvent(params: Record<string, unknown>): void {
    const sessionKey = typeof params.session_key === "string" ? params.session_key : "";
    const turnId = typeof params.turn_id === "string" ? params.turn_id : "";
    if (!sessionKey || !turnId) return;
    const key = turnKey(sessionKey, turnId);
    let buffer = this.turns.get(key);
    if (!buffer) {
      buffer = { sessionKey, turnId, text: "", ended: false };
      this.turns.set(key, buffer);
    }
    // Main-agent only. A sub-agent's end event must not terminate the parent aggregation either.
    if (params.subagent_task_id) return;
    const type = params.type;
    const event = params.event;
    if ((type === "token" || type === "text") && event === "append" && typeof params.content === "string") {
      buffer.text += params.content;
    } else if (type === "turn" && event === "end") {
      buffer.ended = true;
      this.endedTurns.add(key);
      // Bound memory for the rare event-before-response race marker.
      if (this.endedTurns.size > 1_000) this.endedTurns.delete(this.endedTurns.values().next().value!);
      if (this.activeTurns.get(sessionKey) === turnId) this.activeTurns.delete(sessionKey);
      this.turns.delete(key);
      const status = typeof params.status === "string" ? params.status : "done";
      if (buffer.text || status === "error") {
        void Promise.resolve(this.options.onReply({
          sessionKey,
          turnId,
          text: buffer.text,
          ...(status === "error" ? { isError: true } : {}),
        })).catch(() => undefined);
      }
    }
  }

  private async onPluginMessage(params: Record<string, unknown>): Promise<void> {
    const sessionKey = typeof params.session_key === "string" ? params.session_key : "";
    const text = typeof params.content === "string" ? params.content : typeof params.text === "string" ? params.text : "";
    const media = Array.isArray(params.media) ? params.media.filter((v): v is string => typeof v === "string" && !!v.trim()) : [];
    if (sessionKey && (text || media.length)) await this.options.onReply({ sessionKey, text, ...(media.length ? { media } : {}) });
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`gateway: not connected (cannot ${method})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway: rpc ${method} timed out`));
      }, this.options.rpcTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error?: Error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("gateway: not connected");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export { EchoAIGatewayClient as GatewayClient };
