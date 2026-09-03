import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, access, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPrivateAddress } from "../media/network-policy.js";
import { downloadMedia } from "../media/download.js";
import { resolveAllowedLocalFile } from "../media/local-file.js";
import { cleanupMediaCache } from "../media/cleanup.js";

test("rejects IPv4 and IPv6 private ranges", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "192.168.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("download requires HTTPS, validates each redirect, and streams size limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qq-media-"));
  const lookup = (async (host: string) => [{ address: host === "private.test" ? "10.0.0.1" : "8.8.8.8", family: 4 }]) as never;
  try {
    await assert.rejects(downloadMedia("http://public.test/a", join(dir, "a"), { lookup }), /HTTPS/);
    const redirectFetch = (async () => new Response(null, { status: 302, headers: { location: "https://private.test/x" } })) as typeof fetch;
    await assert.rejects(downloadMedia("https://public.test/a", join(dir, "b"), { lookup, fetch: redirectFetch }), /private/);
    const bodyFetch = (async () => new Response(new Uint8Array(10), { status: 200 })) as typeof fetch;
    await assert.rejects(downloadMedia("https://public.test/a", join(dir, "c"), { lookup, fetch: bodyFetch, maxBytes: 5 }), /streaming size/);
    await assert.rejects(access(join(dir, "c")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("realpath enforcement prevents symlink escape", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qq-roots-")); const root = join(dir, "root"); const outside = join(dir, "outside");
  try {
    await mkdir(root); await mkdir(outside); const file = join(outside, "secret"); await writeFile(file, "x");
    const link = join(root, "link");
    try { await symlink(file, link, "file"); } catch { t.skip("symlink creation unavailable"); return; }
    await assert.rejects(resolveAllowedLocalFile(link, [root]), /escapes/);
    const allowed = join(root, "ok"); await writeFile(allowed, "x"); assert.match(await resolveAllowedLocalFile(allowed, [root]), /[\\/]root[\\/]ok$/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cache cleanup applies TTL then oldest-first capacity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qq-clean-"));
  try {
    const old = join(dir, "old"); const a = join(dir, "a"); const b = join(dir, "b");
    const now = Date.now();
    await writeFile(old, "old"); await writeFile(a, "aaaa"); await writeFile(b, "bbbb");
    await utimes(old, new Date(now - 100), new Date(now - 100));
    await utimes(a, new Date(now - 10), new Date(now - 10));
    await utimes(b, new Date(now - 5), new Date(now - 5));
    await cleanupMediaCache(dir, { ttlMs: 20, maxBytes: 4, now });
    await assert.rejects(access(old)); await assert.rejects(access(a)); await access(b);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
