import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { PRODUCTION_KEY_ID, PRODUCTION_PUBLIC_KEY_FILE, createSigner, createVerifier, decodeSigningKey, signatureProfile } from "../src/signing.js";

const productionPrivateKey = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("production signing profile is explicit and never testOnly", () => {
  assert.deepEqual(signatureProfile({ production: true }), { keyId: PRODUCTION_KEY_ID, testOnly: false, publicKeyFile: PRODUCTION_PUBLIC_KEY_FILE });
  assert.equal(PRODUCTION_KEY_ID, "echoworker-prod-2026");
  assert.equal(fs.readFileSync(PRODUCTION_PUBLIC_KEY_FILE, "utf8").includes("PRIVATE"), false);
});

test("signing secret accepts PEM and base64 PEM", () => {
  for (const encoded of [productionPrivateKey, Buffer.from(productionPrivateKey).toString("base64")]) assert.equal(decodeSigningKey(encoded).asymmetricKeyType, "ed25519");
  assert.throws(() => decodeSigningKey("not-a-key"), /PEM private key/);
});

test("production signer reads only CHANNEL_HUB_SIGNING_KEY", () => {
  const previous = process.env.CHANNEL_HUB_SIGNING_KEY;
  try {
    process.env.CHANNEL_HUB_SIGNING_KEY = productionPrivateKey;
    const signature = createSigner({ production: true })(Buffer.from("release"));
    const publicKey = crypto.createPublicKey(decodeSigningKey());
    assert.equal(crypto.verify(null, Buffer.from("release"), publicKey, Buffer.from(signature, "base64")), true);
  } finally { if (previous === undefined) delete process.env.CHANNEL_HUB_SIGNING_KEY; else process.env.CHANNEL_HUB_SIGNING_KEY = previous; }
});
