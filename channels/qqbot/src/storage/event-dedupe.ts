import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface PersistedState { committed: Array<[string, number]> }

export interface EventDedupeOptions {
  file: string;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class EventDedupe {
  private readonly committed = new Map<string, number>();
  private readonly reserved = new Set<string>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private writeChain = Promise.resolve();

  constructor(private readonly options: EventDedupeOptions) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
    if (this.ttlMs <= 0 || this.maxEntries <= 0) throw new Error("dedupe limits must be positive");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.file, "utf8")) as PersistedState;
      for (const [key, expiresAt] of parsed.committed ?? []) {
        if (typeof key === "string" && expiresAt > this.now()) this.committed.set(key, expiresAt);
      }
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  reserve(key: string): boolean {
    if (!key) throw new Error("dedupe key is required");
    this.prune();
    if (this.reserved.has(key) || this.committed.has(key)) return false;
    this.reserved.add(key);
    return true;
  }

  async commit(key: string): Promise<void> {
    if (!this.reserved.delete(key)) throw new Error(`dedupe reservation not found: ${key}`);
    this.committed.delete(key);
    this.committed.set(key, this.now() + this.ttlMs);
    this.prune();
    await this.persist();
  }

  rollback(key: string): void { this.reserved.delete(key); }
  has(key: string): boolean { this.prune(); return this.reserved.has(key) || this.committed.has(key); }
  get size(): number { this.prune(); return this.committed.size + this.reserved.size; }
  flush(): Promise<void> { return this.writeChain; }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.committed) if (expiresAt <= now) this.committed.delete(key);
    while (this.committed.size > this.maxEntries) this.committed.delete(this.committed.keys().next().value!);
  }

  private persist(): Promise<void> {
    const body = JSON.stringify({ committed: [...this.committed] } satisfies PersistedState);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.file), { recursive: true });
      const temporary = `${this.options.file}.${process.pid}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.options.file);
    });
    return this.writeChain;
  }
}
