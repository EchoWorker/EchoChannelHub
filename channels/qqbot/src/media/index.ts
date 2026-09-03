import path from "node:path";
import { mkdir } from "node:fs/promises";
import { resolveStateDir } from "../storage/state-dir.js";
import { assertSafeRemoteURL, downloadMedia, safeDownloadName } from "./download.js";
import { cleanupMediaCache } from "./cleanup.js";
import { resolveAllowedLocalFile } from "./local-file.js";
import type { QQInboundMessage, QQMediaBridge, QQReplyContext } from "../bridge/orchestrator.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|bmp)$/i;

export class MediaBridge implements QQMediaBridge {
  private readonly directory: string;
  constructor(private readonly profileId: string, private readonly allowedRoots: string[] = []) {
    this.directory = path.join(resolveStateDir(), "runtime", profileId, "media");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await cleanupMediaCache(this.directory, { ttlMs: 7 * 24 * 60 * 60_000, maxBytes: 512 * 1024 * 1024 });
  }

  async inbound(items: unknown[], _message: QQInboundMessage): Promise<string[]> {
    await this.initialize();
    const output: string[] = [];
    for (const item of items.slice(0, 8)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : "";
      const type = typeof record.content_type === "string" ? record.content_type.toLowerCase() : "";
      if (!url || (type && !IMAGE_TYPES.has(type))) continue;
      const destination = path.join(this.directory, safeDownloadName(url));
      await downloadMedia(url, destination, { maxBytes: 20 * 1024 * 1024, concurrency: 3 });
      output.push(destination);
    }
    return output;
  }

  async outbound(source: string, _context: QQReplyContext): Promise<string> {
    if (/^https:\/\//i.test(source)) {
      const remote = await assertSafeRemoteURL(source);
      if (!IMAGE_EXT.test(remote.pathname)) throw new Error("QQ v0.1 only sends image media");
      return remote.href;
    }
    const roots = [this.directory, ...this.allowedRoots];
    const file = await resolveAllowedLocalFile(path.resolve(source), roots);
    if (!IMAGE_EXT.test(file)) throw new Error("QQ v0.1 only sends image files");
    return file;
  }
}

export { MediaBridge as QQMediaBridge };
export default MediaBridge;
