/**
 * `echo-wechat login` — interactive QR login.
 *
 * Fetches a login QR, prints it to the terminal, polls until the user scans &
 * confirms on their phone, then persists the bot token under the channel state
 * dir so `start` can use it later.
 *
 * This must run in a real terminal (it prints a QR and may prompt for a verify
 * code). It does NOT talk to the EchoAI gateway.
 */

import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  displayQRCode,
  DEFAULT_ILINK_BOT_TYPE,
} from "../protocol/auth/login-qr.js";
import { DEFAULT_BASE_URL } from "../protocol/auth/accounts.js";
import { persistWeixinLogin } from "../protocol/auth/persist-login.js";
import { resolveStateDir } from "../protocol/storage/state-dir.js";
import { writeQrHtml } from "./qr-html.js";

export async function runLogin(): Promise<void> {
  const out = process.stdout;

  out.write("echo-wechat login\n\n");
  out.write("⚠ This uses the iLink automation protocol — use a secondary WeChat account.\n");
  out.write("  Automation may get an account restricted.\n\n");

  // 1. Fetch + display the QR code.
  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl: DEFAULT_BASE_URL,
    botType: DEFAULT_ILINK_BOT_TYPE,
    force: true,
  });

  if (!startResult.qrcodeUrl) {
    out.write(`❌ Failed to start login: ${startResult.message}\n`);
    process.exitCode = 1;
    return;
  }

  out.write(`${startResult.message}\n\n`);

  // Write + open the QR as an HTML page FIRST — this is the reliable path and
  // doesn't depend on terminal rendering (which can stall in non-TTY contexts).
  try {
    const qrFile = await writeQrHtml(startResult.qrcodeUrl, "用小号微信扫一扫登录");
    out.write(`📱 QR opened in your browser (and saved to):\n   ${qrFile}\n\n`);
  } catch (e) {
    out.write(`(could not write QR html: ${String(e)})\n`);
  }
  out.write(`Or open this link's QR on another device:\n   ${startResult.qrcodeUrl}\n\n`);

  // Also try the ASCII QR for terminal users (best-effort; never blocks login).
  try {
    await Promise.race([
      displayQRCode(startResult.qrcodeUrl),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // ignore — the HTML/link above is the primary path
  }
  out.write("\nWaiting for scan & confirmation on your phone (up to 8 minutes)...\n");

  // 2. Poll until confirmed / expired / timeout. (Handles verify-code &
  //    QR-refresh internally; prompts on stdin when needed.)
  const result = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    apiBaseUrl: DEFAULT_BASE_URL,
    botType: DEFAULT_ILINK_BOT_TYPE,
    timeoutMs: 8 * 60_000,
    verbose: true,
  });

  if (result.alreadyConnected) {
    out.write("\n✅ This WeChat account is already linked. Existing token kept.\n");
    return;
  }

  if (!result.connected || !result.botToken || !result.accountId) {
    out.write(`\n❌ Login failed: ${result.message}\n`);
    process.exitCode = 1;
    return;
  }

  // 3. Persist credentials before reporting success.
  const accountId = persistWeixinLogin(result);

  out.write("\n✅ Login confirmed! Token saved.\n");
  out.write(`   account: ${accountId}\n`);
  out.write(`   state dir: ${resolveStateDir()}\n\n`);
  out.write("Next: register this channel in EchoWork's 📡 Channels panel,\n");
  out.write("      command=node  args=[\"<abs>/dist/cli.js\", \"start\"]\n");
}
