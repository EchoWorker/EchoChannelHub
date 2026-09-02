import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { taxonomy, taxonomyDocument, validateLocalized, validateSemantics } from "./taxonomy.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TARGET = "windows-x64";
export const PUBLISHER = "EchoWorker";
export const TEST_KEY_ID = "echoworker-test-2026";
export const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
export const slash = value => value.split(path.sep).join("/");
export const stableJson = value => `${JSON.stringify(value, null, 2)}\n`;
export const sha256Bytes = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export const sha256 = file => sha256Bytes(fs.readFileSync(file));
export const sign = (bytes, privateKeyFile = path.join(root, "test", "keys", "TEST_ONLY_ed25519_private.pem")) => crypto.sign(null, bytes, fs.readFileSync(privateKeyFile)).toString("base64");
export const verifySignature = (bytes, signature, publicKeyFile = path.join(root, "test", "keys", "TEST_ONLY_ed25519_public.pem")) => crypto.verify(null, bytes, fs.readFileSync(publicKeyFile), Buffer.from(signature, "base64"));
const safeRelative = value => typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const placeholders = value => [...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
const setupKeys = ["args", "add", "restore", "startArgs", "env"];

export function validateSetup(value, location = "setup") {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${location}: must be an object`];
  for (const key of Object.keys(value)) if (!setupKeys.includes(key)) errors.push(`${location}: unknown property ${key}`);
  for (const key of ["args", "add", "startArgs", "env"]) if (!(key in value)) errors.push(`${location}: missing ${key}`);
  const checkArgs = (args, at, allowed) => {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || !arg || /[\u0000-\u001f\u007f-\u009f]/u.test(arg))) { errors.push(`${at}: non-empty control-free string array required`); return; }
    for (const arg of args) {
      const tokens = placeholders(arg);
      for (const token of tokens) if (!allowed.has(token)) errors.push(`${at}: unsupported placeholder {${token}}`);
      if ((arg.includes("{") || arg.includes("}")) && (tokens.length !== 1 || arg !== `{${tokens[0]}}`)) errors.push(`${at}: placeholders must occupy a complete argument`);
    }
  };
  checkArgs(value.args, `${location}.args`, new Set(["sessionId"]));
  for (const mode of ["add", "restore"]) {
    const spec = value[mode]; if (mode === "restore" && spec === undefined) continue;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) { errors.push(`${location}.${mode}: object required`); continue; }
    for (const key of Object.keys(spec)) if (key !== "args") errors.push(`${location}.${mode}: unknown property ${key}`);
    if (!("args" in spec)) errors.push(`${location}.${mode}: missing args`);
    checkArgs(spec.args, `${location}.${mode}.args`, new Set(mode === "restore" ? ["profileId"] : []));
  }
  checkArgs(value.startArgs, `${location}.startArgs`, new Set(["profileId"]));
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env) || Object.entries(value.env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(v))) errors.push(`${location}.env: valid control-free string map required`);
  return errors;
}

export function validateManifest(value, location = "manifest") {
  const errors = [], allowed = new Set(["schemaVersion", "publisher", "id", "version", "target", "entrypoint", "protocols", "setup"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${location}: must be an object`];
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}: unknown property ${key}`);
  if (value.schemaVersion !== 2) errors.push(`${location}.schemaVersion: must equal 2`);
  if (typeof value.publisher !== "string" || !value.publisher) errors.push(`${location}.publisher: non-empty string required`);
  if (!idPattern.test(value.id ?? "")) errors.push(`${location}.id: invalid kebab-case id`);
  if (!semver.test(value.version ?? "")) errors.push(`${location}.version: invalid SemVer`);
  if (value.target !== TARGET) errors.push(`${location}.target: must equal ${TARGET}`);
  if (!safeRelative(value.entrypoint)) errors.push(`${location}.entrypoint: safe relative path required`);
  if (!value.protocols || value.protocols.setup !== 2 || value.protocols.start !== 1 || Object.keys(value.protocols ?? {}).some(k => !["setup", "start"].includes(k))) errors.push(`${location}.protocols: setup must equal 2 and start must equal 1`);
  errors.push(...validateSetup(value.setup, `${location}.setup`));
  return errors;
}
export function loadChannels(base = root) {
  const dir = path.join(base, "channels");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const channelDir = path.join(dir, e.name), manifestFile = path.join(channelDir, "channel.json");
    return { dir: channelDir, directoryName: e.name, manifestFile, manifest: readJson(manifestFile) };
  }).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}
export const artifactManifest = channel => ({ schemaVersion: 2, publisher: channel.publisher, id: channel.id, version: channel.version, target: TARGET, entrypoint: `payload/echo-${channel.id}.cmd`, protocols: { setup: 2, start: 1 }, setup: structuredClone(channel.setup) });

export function validateRepository(base = root) {
  const errors = []; let channels = [];
  try { channels = loadChannels(base); } catch (error) { return [String(error.message ?? error)]; }
  const ids = new Set();
  for (const channel of channels) {
    const m = channel.manifest, at = m.id ?? channel.directoryName;
    const allowed = new Set(["$schema", "schemaVersion", "publisher", "id", "name", "version", "summary", "description", "aliases", "categoryIds", "tagIds", "license", "runtime", "runtimeLabel", "entrypoint", "target", "capabilities", "highlights", "publisherTrust", "setupMethod", "setup", "provenance"]);
    for (const key of Object.keys(m)) if (!allowed.has(key)) errors.push(`${channel.manifestFile}: unknown property ${key}`);
    if (m.schemaVersion !== 2 || m.publisher !== PUBLISHER || m.target !== TARGET || m.runtime !== "node") errors.push(`${at}: invalid schemaVersion, publisher, target, or runtime`);
    if (!idPattern.test(m.id ?? "") || !semver.test(m.version ?? "")) errors.push(`${channel.directoryName}: invalid id or version`);
    for (const key of ["license", "entrypoint", "provenance"]) if (typeof m[key] !== "string" || !m[key]) errors.push(`${at}.${key}: non-empty string required`);
    validateSemantics(m, at, errors);
    errors.push(...validateSetup(m.setup, `${at}.setup`));
    if (m.id !== channel.directoryName || ids.has(m.id)) errors.push(`${channel.manifestFile}: id mismatch or duplicate`); ids.add(m.id);
    for (const file of [m.provenance, "package.json", "package-lock.json"]) if (!fs.existsSync(path.join(channel.dir, file))) errors.push(`${at}: missing ${file}`);
    try { if (readJson(path.join(channel.dir, "package.json")).version !== m.version) errors.push(`${at}: package and manifest versions differ`); } catch {}
    errors.push(...validateManifest(artifactManifest(m), `${at}.artifactManifest`));
  }
  return errors;
}

export function channelSemantic(m) { return { publisher: m.publisher, id: m.id, name: m.name, summary: m.summary, description: m.description, aliases: m.aliases, categoryIds: m.categoryIds, tagIds: m.tagIds, capabilities: m.capabilities, highlights: m.highlights, publisherTrust: m.publisherTrust, setupMethod: m.setupMethod, runtime: m.runtimeLabel }; }
export function makeCatalog(channels, artifacts, { sequence = 1, generatedAt = "2026-01-01T00:00:00Z", expiresAt = "2036-01-01T00:00:00Z" } = {}) {
  return { schemaVersion: 1, sequence, generatedAt, expiresAt, channels: channels.map(c => ({ ...channelSemantic(c.manifest), releases: [{ version: c.manifest.version, status: "active", engines: { echowork: ">=0.1.0" }, artifacts: { [TARGET]: artifacts[c.manifest.id] } }] })) };
}
const exact = (o, keys, at, errors) => { if (!o || typeof o !== "object" || Array.isArray(o)) { errors.push(`${at}: object required`); return false; } for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${at}: unknown property ${k}`); for (const k of keys) if (!(k in o)) errors.push(`${at}: missing ${k}`); return true; };
export function validateCatalog(value, location = "catalog") {
  const errors = [];
  if (!exact(value, ["schemaVersion", "sequence", "generatedAt", "expiresAt", "channels"], location, errors)) return errors;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.channels)) errors.push(`${location}: invalid metadata`);
  if (!Number.isFinite(Date.parse(value.generatedAt)) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.parse(value.generatedAt)) errors.push(`${location}: invalid dates`);
  for (const [i, c] of (value.channels ?? []).entries()) {
    const at = `${location}.channels[${i}]`;
    if (!exact(c, ["publisher", "id", "name", "summary", "description", "aliases", "categoryIds", "tagIds", "capabilities", "highlights", "publisherTrust", "setupMethod", "runtime", "releases"], at, errors)) continue;
    validateSemantics(c, at, errors);
    if (!c.publisher || !c.id || !Array.isArray(c.releases)) errors.push(`${at}: invalid channel`);
    for (const [j, r] of (c.releases ?? []).entries()) {
      if (!exact(r, ["version", "status", "engines", "artifacts"], `${at}.releases[${j}]`, errors)) continue;
      if (!semver.test(r.version ?? "") || !["active", "yanked", "revoked"].includes(r.status) || !r.artifacts || Object.keys(r.artifacts).some(k => k !== TARGET)) errors.push(`${at}: invalid release`);
      for (const [target, a] of Object.entries(r.artifacts ?? {})) { if (!exact(a, ["url", "size", "sha256", "signature", "keyId"], `${at}.${target}`, errors)) continue; if (target !== TARGET || !/^https:\/\//.test(a.url) || !Number.isSafeInteger(a.size) || a.size < 0 || !/^[a-f0-9]{64}$/.test(a.sha256) || typeof a.signature !== "string" || typeof a.keyId !== "string") errors.push(`${at}.${target}: invalid artifact`); }
    }
  }
  return errors;
}
export { taxonomy, taxonomyDocument };
export function walkFiles(dir) { const output = []; for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) { const file = path.join(dir, entry.name); if (entry.isDirectory()) output.push(...walkFiles(file)); else if (entry.isFile()) output.push(file); } return output; }
