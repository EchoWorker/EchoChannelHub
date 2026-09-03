import type { QQClient, QQSendResult, QQTarget } from "./client.js";
import type { ReplyBudget, ReplyReservation } from "./reply-budget.js";
import { sanitizeQQText } from "./sanitize.js";
import { validateTarget } from "./target.js";

export interface PassiveSendOptions { scene: string; msgId: string }

export class QQOutbound {
  constructor(private readonly client: QQClient, private readonly budget: ReplyBudget) {}

  async sendText(target: QQTarget, text: string, passive?: PassiveSendOptions): Promise<QQSendResult> {
    const clean = sanitizeQQText(text);
    if (!clean) throw new Error("Refusing to send empty QQ text");
    return this.withBudget(target, passive, (resolved) => this.client.sendText(resolved, clean));
  }

  async sendImage(
    target: QQTarget,
    source: { url?: string; localPath?: string; fileData?: string },
    text?: string,
    passive?: PassiveSendOptions,
  ): Promise<QQSendResult> {
    const fields = [source.url, source.localPath, source.fileData].filter(Boolean);
    if (fields.length !== 1) throw new Error("QQ image requires exactly one source");
    return this.withBudget(target, passive, (resolved) => this.client.sendImage(resolved, source, text && sanitizeQQText(text)));
  }

  private async withBudget(
    target: QQTarget,
    passive: PassiveSendOptions | undefined,
    send: (target: QQTarget & { msgSeq?: number }) => Promise<QQSendResult>,
  ): Promise<QQSendResult> {
    validateTarget(target);
    let reservation: ReplyReservation | undefined;
    try {
      if (passive) reservation = this.budget.reserve(passive.scene, passive.msgId);
      const resolved = passive
        ? { ...target, msgId: passive.msgId, msgSeq: reservation!.msgSeq }
        : { ...target, msgId: undefined };
      const result = await send(resolved);
      if (reservation) this.budget.commit(reservation);
      return result;
    } catch (error) {
      if (reservation) this.budget.rollback(reservation);
      throw error;
    }
  }
}
