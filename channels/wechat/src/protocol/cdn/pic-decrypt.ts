import { decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl, ENABLE_CDN_URL_FALLBACK } from "./cdn-url.js";
import { logger } from "../util/logger.js";

const CDN_FETCH_TIMEOUT_MS = 60_000;
const CDN_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 + 1024;

/** Read a response body with an enforced byte cap instead of unbounded arrayBuffer(). */
async function readResponseBuffer(res: Response, label: string): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CDN_MAX_DOWNLOAD_BYTES) {
    throw new Error(`${label}: CDN content-length ${declared} exceeds ${CDN_MAX_DOWNLOAD_BYTES} byte limit`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CDN_MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`${label}: CDN response exceeds ${CDN_MAX_DOWNLOAD_BYTES} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/**
 * Download raw bytes from the CDN (no decryption).
 */
async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CDN_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const cause =
      (err as NodeJS.ErrnoException).cause ?? (err as NodeJS.ErrnoException).code ?? "(no cause)";
    logger.error(
      `${label}: fetch network error url=${url} err=${String(err)} cause=${String(cause)}`,
    );
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  logger.debug(`${label}: response status=${res.status} ok=${res.ok}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    const msg = `${label}: CDN download ${res.status} ${res.statusText} body=${body}`;
    logger.error(msg);
    throw new Error(msg);
  }
  return readResponseBuffer(res, label);
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)          → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    // hex-encoded key: base64 → hex string → raw bytes
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  const msg = `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes (base64="${aesKeyBase64}")`;
  logger.error(msg);
  throw new Error(msg);
}

/**
 * Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
 * aesKeyBase64: CDNMedia.aes_key JSON field (see parseAesKey for supported formats).
 */
export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  let url: string;
  if (fullUrl) {
    url = fullUrl;
  } else if (ENABLE_CDN_URL_FALLBACK) {
    url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  } else {
    throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
  }
  logger.debug(`${label}: fetching url=${url}`);
  const encrypted = await fetchCdnBytes(url, label);
  logger.debug(`${label}: downloaded ${encrypted.byteLength} bytes, decrypting`);
  const decrypted = decryptAesEcb(encrypted, key);
  logger.debug(`${label}: decrypted ${decrypted.length} bytes`);
  return decrypted;
}

/**
 * Download plain (unencrypted) bytes from the CDN. Returns the raw Buffer.
 */
export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  let url: string;
  if (fullUrl) {
    url = fullUrl;
  } else if (ENABLE_CDN_URL_FALLBACK) {
    url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  } else {
    throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
  }
  logger.debug(`${label}: fetching url=${url}`);
  return fetchCdnBytes(url, label);
}
