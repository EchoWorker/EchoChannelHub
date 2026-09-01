import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TARGET = "windows-x64";
export const PUBLISHER = "EchoWorker";
export const TEST_KEY_ID = "echoworker-test-2026";
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
export const slash = value => value.split(path.sep).join("/");
export const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;
export const sha256Bytes = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export const sha256 = file => sha256Bytes(fs.readFileSync(file));
export const sign = (bytes, privateKeyFile = path.join(root, "test", "keys", "TEST_ONLY_ed25519_private.pem")) =>
  crypto.sign(null, bytes, fs.readFileSync(privateKeyFile)).toString("base64");
export const verifySignature = (bytes, signature, publicKeyFile = path.join(root, "test", "keys", "TEST_ONLY_ed25519_public.pem")) =>
  crypto.verify(null, bytes, fs.readFileSync(publicKeyFile), Buffer.from(signature, "base64"));

const safeRelative = value => typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
export function validateManifest(value, location = "manifest") {
  const errors = [];
  const allowed = new Set(["schemaVersion", "publisher", "id", "version", "target", "entrypoint", "protocols"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${location}: must be an object`];
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}: unknown property ${key}`);
  if (value.schemaVersion !== 1) errors.push(`${location}.schemaVersion: must equal 1`);
  if (typeof value.publisher !== "string" || !value.publisher) errors.push(`${location}.publisher: non-empty string required`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id ?? "")) errors.push(`${location}.id: invalid kebab-case id`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version ?? "")) errors.push(`${location}.version: invalid SemVer`);
  if (value.target !== TARGET) errors.push(`${location}.target: must equal ${TARGET}`);
  if (!safeRelative(value.entrypoint)) errors.push(`${location}.entrypoint: safe relative path required`);
  if (!value.protocols || value.protocols.setup !== 1 || value.protocols.start !== 1 || Object.keys(value.protocols ?? {}).some(k => !["setup", "start"].includes(k))) errors.push(`${location}.protocols: setup and start must equal 1`);
  return errors;
}

export function loadChannels(base = root) {
  const dir = path.join(base, "channels");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const channelDir = path.join(dir, e.name);
    return { dir: channelDir, directoryName: e.name, manifestFile: path.join(channelDir, "channel.json"), manifest: readJson(path.join(channelDir, "channel.json")) };
  }).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export function artifactManifest(channel) {
  return { schemaVersion: 1, publisher: channel.publisher, id: channel.id, version: channel.version, target: TARGET, entrypoint: "payload/echo-wechat.cmd", protocols: { setup: 1, start: 1 } };
}

export function validateRepository(base = root) {
  const errors = [];
  let channels = [];
  try { channels = loadChannels(base); } catch (error) { return [String(error.message ?? error)]; }
  const ids = new Set();
  for (const channel of channels) {
    const m = channel.manifest;
    const allowed = new Set(["$schema", "schemaVersion", "publisher", "id", "name", "version", "summary", "license", "runtime", "entrypoint", "target", "capabilities", "provenance"]);
    for (const key of Object.keys(m)) if (!allowed.has(key)) errors.push(`${channel.manifestFile}: unknown property ${key}`);
    if (m.schemaVersion !== 1 || m.publisher !== PUBLISHER || m.target !== TARGET || m.runtime !== "node") errors.push(`${m.id ?? channel.directoryName}: invalid schemaVersion, publisher, target, or runtime`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.id ?? "") || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version ?? "")) errors.push(`${channel.directoryName}: invalid id or version`);
    for (const key of ["name", "summary", "license", "entrypoint", "provenance"]) if (typeof m[key] !== "string" || !m[key]) errors.push(`${m.id ?? channel.directoryName}.${key}: non-empty string required`);
    if (m.id !== channel.directoryName || ids.has(m.id)) errors.push(`${channel.manifestFile}: id mismatch or duplicate`);
    ids.add(m.id);
    for (const file of [m.provenance, "package.json", "package-lock.json"]) if (!fs.existsSync(path.join(channel.dir, file))) errors.push(`${m.id}: missing ${file}`);
    try { if (readJson(path.join(channel.dir, "package.json")).version !== m.version) errors.push(`${m.id}: package and manifest versions differ`); } catch {}
    errors.push(...validateManifest(artifactManifest(m), `${m.id}.artifactManifest`));
  }
  return errors;
}

export function makeCatalog(channels, artifacts, { sequence = 1, generatedAt = "2026-01-01T00:00:00Z", expiresAt = "2036-01-01T00:00:00Z" } = {}) {
  return { schemaVersion: 1, sequence, generatedAt, expiresAt, channels: channels.map(c => ({ publisher: c.manifest.publisher, id: c.manifest.id, name: c.manifest.name, summary: c.manifest.summary, releases: [{ version: c.manifest.version, status: "active", artifacts: { [TARGET]: artifacts[c.manifest.id] } }] })) };
}
export function validateCatalog(value, location = "catalog") {
  const errors = [];
  const exact = (o, keys, at) => { if (!o || typeof o !== "object" || Array.isArray(o)) { errors.push(`${at}: object required`); return false; } for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${at}: unknown property ${k}`); for (const k of keys) if (!(k in o)) errors.push(`${at}: missing ${k}`); return true; };
  if (!exact(value, ["schemaVersion", "sequence", "generatedAt", "expiresAt", "channels"], location)) return errors;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.channels)) errors.push(`${location}: invalid metadata`);
  if (!Number.isFinite(Date.parse(value.generatedAt)) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.parse(value.generatedAt)) errors.push(`${location}: invalid dates`);
  for (const [i, c] of (value.channels ?? []).entries()) {
    if (!exact(c, ["publisher", "id", "name", "summary", "releases"], `${location}.channels[${i}]`)) continue;
    if (!c.publisher || !c.id || !c.name || typeof c.summary !== "string" || !Array.isArray(c.releases)) errors.push(`${location}.channels[${i}]: invalid channel`);
    for (const [j, r] of (c.releases ?? []).entries()) {
      if (!exact(r, ["version", "status", "artifacts"], `${location}.channels[${i}].releases[${j}]`)) continue;
      if (!["active", "yanked", "revoked"].includes(r.status) || !r.artifacts || Object.keys(r.artifacts).some(k => k !== TARGET)) errors.push(`${location}: invalid release`);
      for (const [target, a] of Object.entries(r.artifacts ?? {})) {
        if (!exact(a, ["url", "size", "sha256", "signature", "keyId"], `${location}.${target}`)) continue;
        if (target !== TARGET || !/^https:\/\//.test(a.url) || !Number.isSafeInteger(a.size) || a.size < 0 || !/^[a-f0-9]{64}$/.test(a.sha256) || typeof a.signature !== "string" || a.keyId !== TEST_KEY_ID) errors.push(`${location}.${target}: invalid artifact`);
      }
    }
  }
  return errors;
}

export function walkFiles(dir) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) output.push(...walkFiles(file)); else if (entry.isFile()) output.push(file);
  }
  return output;
}
