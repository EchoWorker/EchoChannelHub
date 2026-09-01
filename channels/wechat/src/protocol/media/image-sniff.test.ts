import { test } from "node:test";
import assert from "node:assert/strict";

import { sniffImageMime } from "./image-sniff.js";

const pad = (head: number[]): Buffer =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(16)]);

test("sniffImageMime: JPEG", () => {
  assert.equal(sniffImageMime(pad([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
});

test("sniffImageMime: PNG", () => {
  assert.equal(
    sniffImageMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
});

test("sniffImageMime: GIF87a / GIF89a", () => {
  assert.equal(sniffImageMime(pad([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])), "image/gif");
  assert.equal(sniffImageMime(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif");
});

test("sniffImageMime: WEBP", () => {
  const buf = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal(sniffImageMime(buf), "image/webp");
});

test("sniffImageMime: BMP", () => {
  assert.equal(sniffImageMime(pad([0x42, 0x4d])), "image/bmp");
});

test("sniffImageMime: unknown returns undefined", () => {
  assert.equal(sniffImageMime(pad([0x00, 0x01, 0x02, 0x03])), undefined);
  // RIFF without WEBP tag (e.g. a WAV) must not be mistaken for an image.
  const wav = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  ]);
  assert.equal(sniffImageMime(wav), undefined);
});

test("sniffImageMime: too-short buffer returns undefined", () => {
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8])), undefined);
});
