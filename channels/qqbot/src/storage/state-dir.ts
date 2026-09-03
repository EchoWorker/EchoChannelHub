import os from "node:os";
import path from "node:path";

/** Root for QQ Bot credentials and runtime state. */
export function resolveStateDir(): string {
  return process.env.ECHO_QQBOT_STATE_DIR?.trim()
    || path.join(os.homedir(), ".echoai", "channels", "qqbot");
}
