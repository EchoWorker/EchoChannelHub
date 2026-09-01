import os from "node:os";
import path from "node:path";

/**
 * Resolve the state directory for the WeChat channel.
 *
 * All persistent files (account tokens, getUpdates sync cursor, peer registry)
 * live under here. Repointed from OpenClaw's `~/.openclaw` to EchoAI's
 * `~/.echoai/channels/wechat` so the channel integrates with the EchoAI layout.
 *
 * Override with `ECHO_WECHAT_STATE_DIR` (e.g. to isolate multiple accounts).
 */
export function resolveStateDir(): string {
  return (
    process.env.ECHO_WECHAT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".echoai", "channels", "wechat")
  );
}
