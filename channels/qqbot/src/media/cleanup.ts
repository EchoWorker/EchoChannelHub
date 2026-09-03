import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export async function cleanupMediaCache(directory: string, options: { ttlMs: number; maxBytes: number; now?: number }): Promise<void> {
  if (options.ttlMs <= 0 || options.maxBytes < 0) throw new Error("invalid media cache limits");
  const now = options.now ?? Date.now();
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const files = (await Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    const info = await stat(path);
    return { path, size: info.isFile() ? info.size : 0, mtimeMs: info.mtimeMs, file: info.isFile() };
  }))).filter((item) => item.file);
  for (const item of files) if (now - item.mtimeMs >= options.ttlMs) await rm(item.path, { force: true });
  const survivors = files.filter((item) => now - item.mtimeMs < options.ttlMs).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((sum, item) => sum + item.size, 0);
  for (const item of survivors) if (total > options.maxBytes) { await rm(item.path, { force: true }); total -= item.size; }
}
