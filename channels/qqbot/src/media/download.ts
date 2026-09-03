import { lookup as dnsLookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { basename, dirname } from "node:path";
import { isPrivateAddress } from "./network-policy.js";

export interface DownloadOptions {
  maxBytes?: number;
  maxRedirects?: number;
  concurrency?: number;
  fetch?: typeof fetch;
  lookup?: typeof dnsLookup;
}

class Semaphore {
  active = 0;
  waiters: Array<() => void> = [];
  constructor(readonly limit: number) { if (limit <= 0) throw new Error("concurrency must be positive"); }
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => { this.active--; this.waiters.shift()?.(); };
  }
}

const semaphores = new Map<number, Semaphore>();

async function validateURL(url: URL, lookup: typeof dnsLookup): Promise<void> {
  if (url.protocol !== "https:") throw new Error("Only HTTPS media URLs are allowed");
  if (url.username || url.password) throw new Error("Media URL credentials are forbidden");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`Media host resolves to a private or invalid address: ${url.hostname}`);
  }
}

export async function assertSafeRemoteURL(value: string, options: Pick<DownloadOptions, "lookup"> = {}): Promise<URL> {
  const url = new URL(value);
  await validateURL(url, options.lookup ?? dnsLookup);
  return url;
}

export async function downloadMedia(url: string, destination: string, options: DownloadOptions = {}): Promise<{ bytes: number; finalURL: string }> {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const fetcher = options.fetch ?? fetch;
  const lookup = options.lookup ?? dnsLookup;
  const concurrency = options.concurrency ?? 3;
  const semaphore = semaphores.get(concurrency) ?? new Semaphore(concurrency);
  semaphores.set(concurrency, semaphore);
  const release = await semaphore.acquire();
  try {
    let current = new URL(url);
    let response: Response | undefined;
    for (let redirects = 0; ; redirects++) {
      await validateURL(current, lookup);
      response = await fetcher(current, { redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects >= maxRedirects) throw new Error("Too many media redirects");
      const location = response.headers.get("location");
      if (!location) throw new Error("Media redirect has no Location header");
      current = new URL(location, current);
    }
    if (!response.ok) throw new Error(`Media download failed: HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) throw new Error("Media exceeds size limit");
    if (!response.body) throw new Error("Media response has no body");
    await mkdir(dirname(destination), { recursive: true });
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error("Media exceeds streaming size limit") : undefined, chunk);
    }});
    try { await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(destination, { flags: "wx", mode: 0o600 })); }
    catch (error) { await rm(destination, { force: true }); throw error; }
    return { bytes, finalURL: current.href };
  } finally { release(); }
}

export function safeDownloadName(url: string): string {
  return `${crypto.randomUUID()}-${basename(new URL(url).pathname).replace(/[^a-zA-Z0-9._-]/g, "_") || "media"}`;
}
