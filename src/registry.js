import fs from "node:fs";
import path from "node:path";
import { TARGET, makeCatalog, sha256Bytes, stableJson, sign, verifySignature, validateCatalog, taxonomyDocument } from "./lib.js";

const objectRef = (bytes, name, baseUrl) => ({ sha256: sha256Bytes(bytes), url: `${baseUrl}/objects/sha256/${sha256Bytes(bytes)}/${name}` });
const writeSigned = (file, bytes, signer = sign) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); fs.writeFileSync(`${file}.sig`, `${signer(bytes)}\n`); };
export function buildRegistry({ channels, artifacts, output, prior, now = new Date(), baseUrl = "https://echoworker.github.io/EchoChannelHub/registry/v1", signer = sign, testOnly = true }) {
  const generatedAt = now.toISOString(), expiresAt = new Date(now.getTime() + 30 * 86400000).toISOString(), sequence = (prior?.snapshot?.sequence ?? 0) + 1;
  const documents = {
    "catalog.json": makeCatalog(channels, artifacts, { sequence, generatedAt, expiresAt }),
    "categories.json": taxonomyDocument("categories"),
    "tags.json": taxonomyDocument("tags")
  };
  const refs = {};
  for (const [name, value] of Object.entries(documents)) {
    const bytes = Buffer.from(stableJson(value)), ref = objectRef(bytes, name, baseUrl); refs[name.slice(0, -5)] = ref;
    writeSigned(path.join(output, "objects", "sha256", ref.sha256, name), bytes, signer);
  }
  const oldCatalog = prior?.catalog;
  const changedChannels = channels.filter(c => JSON.stringify(oldCatalog?.channels?.find(x => x.id === c.manifest.id)) !== JSON.stringify(documents["catalog.json"].channels.find(x => x.id === c.manifest.id))).map(c => c.manifest.id);
  const removedChannels = (oldCatalog?.channels ?? []).filter(c => !channels.some(x => x.manifest.id === c.id)).map(c => c.id);
  const snapshot = { schemaVersion: 1, sequence, generatedAt, expiresAt, testOnly, objects: refs, changedSet: { base: prior?.hash ?? null, channels: [...changedChannels, ...removedChannels].sort(), taxonomy: prior ? ["categories", "tags"].filter(k => prior.snapshot.objects[k]?.sha256 !== refs[k].sha256) : ["categories", "tags"] } };
  const snapshotBytes = Buffer.from(stableJson(snapshot)), snapshotHash = sha256Bytes(snapshotBytes), snapshotName = "snapshot.json";
  writeSigned(path.join(output, "snapshots", "sha256", snapshotHash, snapshotName), snapshotBytes, signer);
  const latest = { schemaVersion: 1, testOnly, snapshot: { sha256: snapshotHash, url: `${baseUrl}/snapshots/sha256/${snapshotHash}/${snapshotName}` } };
  writeSigned(path.join(output, "latest.json"), Buffer.from(stableJson(latest)), signer);
  return { latest, snapshot, catalog: documents["catalog.json"], hash: snapshotHash };
}
export function loadRegistry(dir) {
  const latestFile = path.join(dir, "latest.json"), latestBytes = fs.readFileSync(latestFile), latest = JSON.parse(latestBytes);
  const snapshotFile = path.join(dir, "snapshots", "sha256", latest.snapshot.sha256, "snapshot.json"), snapshotBytes = fs.readFileSync(snapshotFile), snapshot = JSON.parse(snapshotBytes), objects = {};
  for (const [kind, ref] of Object.entries(snapshot.objects)) objects[kind] = JSON.parse(fs.readFileSync(path.join(dir, "objects", "sha256", ref.sha256, `${kind}.json`)));
  return { latest, latestBytes, snapshot, snapshotBytes, objects, hash: latest.snapshot.sha256 };
}
export function validateRegistry(dir, verifier = verifySignature) {
  const errors = []; let loaded;
  try { loaded = loadRegistry(dir); } catch (e) { return [`registry: ${e.message}`]; }
  const check = (bytes, sigFile, hash, at) => { if (sha256Bytes(bytes) !== hash) errors.push(`${at}: content hash mismatch`); try { if (!verifier(bytes, fs.readFileSync(sigFile, "utf8").trim())) errors.push(`${at}: invalid signature`); } catch (e) { errors.push(`${at}: ${e.message}`); } };
  if (loaded.latest.schemaVersion !== 1 || loaded.latest.testOnly !== true) errors.push("latest: must be explicitly TEST ONLY");
  check(loaded.latestBytes, path.join(dir, "latest.json.sig"), sha256Bytes(loaded.latestBytes), "latest");
  check(loaded.snapshotBytes, path.join(dir, "snapshots", "sha256", loaded.hash, "snapshot.json.sig"), loaded.hash, "snapshot");
  if (loaded.snapshot.testOnly !== true || loaded.snapshot.schemaVersion !== 1) errors.push("snapshot: must be explicitly TEST ONLY");
  for (const [kind, ref] of Object.entries(loaded.snapshot.objects ?? {})) {
    const file = path.join(dir, "objects", "sha256", ref.sha256, `${kind}.json`); let bytes;
    try { bytes = fs.readFileSync(file); check(bytes, `${file}.sig`, ref.sha256, kind); } catch (e) { errors.push(`${kind}: ${e.message}`); }
  }
  errors.push(...validateCatalog(loaded.objects.catalog));
  return errors;
}
