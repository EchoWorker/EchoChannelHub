export type QQScope = "c2c" | "group";

export interface QQTarget {
  scope: QQScope;
  targetId: string;
  msgId?: string;
  msgSeq?: number;
}

export interface QQInboundMessage {
  messageId: string;
  eventId?: string;
  content: string;
  replyTarget: QQTarget;
  author?: { id?: string; user_openid?: string };
  mentions?: Array<{ id?: string; user_openid?: string }>;
  [key: string]: unknown;
}

export interface QQMiddlewareContext {
  message: QQInboundMessage;
  state: Record<string, unknown>;
  stop(reason?: string): void;
  readonly stopped: boolean;
}

export type QQMiddleware = (
  context: QQMiddlewareContext,
  next: () => Promise<void>,
) => void | Promise<void>;

export interface QQSendResult {
  id?: string;
  timestamp?: number | string;
}

export interface QQClient {
  use(middleware: QQMiddleware): void;
  on(event: "message", listener: (context: QQMiddlewareContext, message: QQInboundMessage) => void | Promise<void>): void;
  on(event: "ready" | "resumed", listener: (data?: unknown) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  sendText(target: QQTarget, text: string): Promise<QQSendResult>;
  sendImage(target: QQTarget, source: { url?: string; localPath?: string; fileData?: string }, text?: string): Promise<QQSendResult>;
}
