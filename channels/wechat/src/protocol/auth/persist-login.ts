import {
  clearStaleAccountsForUserId,
  normalizeAccountId,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "./accounts.js";
import type { WeixinQrWaitResult } from "./login-qr.js";

/** Persist a confirmed login before exposing its non-secret profile id. */
export function persistWeixinLogin(result: WeixinQrWaitResult): string {
  if (!result.connected || !result.botToken || !result.accountId) {
    throw new Error("cannot persist an incomplete WeChat login");
  }
  const accountId = normalizeAccountId(result.accountId);
  saveWeixinAccount(accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  });
  registerWeixinAccountId(accountId);
  if (result.userId) {
    clearStaleAccountsForUserId(accountId, result.userId);
    registerWeixinAccountId(accountId);
  }
  return accountId;
}
