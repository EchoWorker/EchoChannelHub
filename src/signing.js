import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TEST_KEY_ID = "echoworker-test-2026";
export const PRODUCTION_KEY_ID = "echoworker-prod-2026";
export const PRODUCTION_PUBLIC_KEY_FILE = path.join(root, "keys", `${PRODUCTION_KEY_ID}.pem`);
export const TEST_PUBLIC_KEY_FILE = path.join(root, "test", "fixtures", "keys", "TEST_ONLY_ed25519_public.pem");
const TEST_PRIVATE_KEY_FILE = path.join(root, "test", "fixtures", "keys", "TEST_ONLY_ed25519_private.pem");

export const signatureProfile = ({ production = false } = {}) => production
  ? { keyId: PRODUCTION_KEY_ID, testOnly: false, publicKeyFile: PRODUCTION_PUBLIC_KEY_FILE }
  : { keyId: TEST_KEY_ID, testOnly: true, publicKeyFile: TEST_PUBLIC_KEY_FILE };

export function decodeSigningKey(value = process.env.CHANNEL_HUB_SIGNING_KEY) {
  if (!value) throw new Error("CHANNEL_HUB_SIGNING_KEY is required for production signing");
  const trimmed = value.trim();
  const pem = trimmed.includes("-----BEGIN") ? trimmed.replace(/\\n/g, "\n") : Buffer.from(trimmed, "base64").toString("utf8").trim();
  if (!pem.includes("-----BEGIN") || !pem.includes("PRIVATE KEY-----")) throw new Error("CHANNEL_HUB_SIGNING_KEY must be a PEM private key or base64-encoded PEM");
  return crypto.createPrivateKey(pem);
}

export function createSigner({ production = false } = {}) {
  const key = production ? decodeSigningKey() : fs.readFileSync(TEST_PRIVATE_KEY_FILE);
  return bytes => crypto.sign(null, bytes, key).toString("base64");
}

export const createVerifier = publicKeyFile => (bytes, signature) => crypto.verify(null, bytes, fs.readFileSync(publicKeyFile), Buffer.from(signature, "base64"));
export const testSigner = createSigner();
export const testVerifier = createVerifier(TEST_PUBLIC_KEY_FILE);
