import fs from "node:fs";
import path from "node:path";
import { TARGET, TEST_KEY_ID, makeCatalog, sha256Bytes, stableJson, sign, verifySignature, validateCatalog, taxonomyDocument } from "./lib.js";

const objectRef = (bytes, name, baseUrl) => ({ sha256: sha256Bytes(bytes), url: `${baseUrl}/objects/sha256/${sha256Bytes(bytes)}/${name}` });
const writeSigned = (file, bytes, signer = sign) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); fs.writeFileSync(`${file}.sig`, `${signer(bytes)}\n`); };
export function buildRegistry({ channels, artifacts, output, prior, now = new Date(), baseUrl = "https://echoworker.github.io/EchoChannelHub/v1", signer = sign, testOnly = true }) {
  const generatedAt = now.toISOString(), expiresAt = new Date(now.getTime() + 30 * 86400000).toISOString(), sequence = (prior?.snapshot?.sequence ?? 0) + 1;
  const documents = {
    "catalog.json": makeCatalog(channels, artifacts, { sequence, generatedAt, expiresAt }),
    "categories.json": taxonomyDocument("categories"),
    "tags.json": taxonomyDocument("tags")
  };
  const refs = {};
  for (const [name, value] of Object.entries(documents)) {
    const bytes = Buffer.from(stableJson(value)), ref = { ...objectRef(bytes, name, baseUrl), size: bytes.length }; refs[name.slice(0, -5)] = ref;
    writeSigned(path.join(output, "objects", "sha256", ref.sha256, name), bytes, signer);
  }
  const oldCatalog = prior?.catalog;
  const changedChannels = channels.filter(c => JSON.stringify(oldCatalog?.channels?.find(x => x.id === c.manifest.id)) !== JSON.stringify(documents["catalog.json"].channels.find(x => x.id === c.manifest.id))).map(c => c.manifest.id);
  const removedChannels = (oldCatalog?.channels ?? []).filter(c => !channels.some(x => x.manifest.id === c.id)).map(c => c.id);
  const snapshot = { schemaVersion: 1, sequence, generatedAt, expiresAt, keyId: TEST_KEY_ID, testOnly, blobs: refs, changedSet: { base: prior?.hash ?? null, channels: [...changedChannels, ...removedChannels].sort(), taxonomy: prior ? ["categories", "tags"].filter(k => prior.snapshot.blobs[k]?.sha256 !== refs[k].sha256) : ["categories", "tags"] } };
  const snapshotBytes = Buffer.from(stableJson(snapshot)), snapshotHash = sha256Bytes(snapshotBytes), snapshotName = "snapshot.json";
  writeSigned(path.join(output, "snapshots", "sha256", snapshotHash, snapshotName), snapshotBytes, signer);
  const latest = { schemaVersion: 1, keyId: TEST_KEY_ID, testOnly, snapshot: { sha256: snapshotHash, size: snapshotBytes.length, url: `${baseUrl}/snapshots/sha256/${snapshotHash}/${snapshotName}` } };
  writeSigned(path.join(output, "latest.json"), Buffer.from(stableJson(latest)), signer);
  return { latest, snapshot, catalog: documents["catalog.json"], hash: snapshotHash };
}
export function loadRegistry(dir) {
  const latestFile = path.join(dir, "latest.json"), latestBytes = fs.readFileSync(latestFile), latest = JSON.parse(latestBytes);
  const snapshotFile = path.join(dir, "snapshots", "sha256", latest.snapshot.sha256, "snapshot.json"), snapshotBytes = fs.readFileSync(snapshotFile), snapshot = JSON.parse(snapshotBytes), objects = {};
  for (const [kind, ref] of Object.entries(snapshot.blobs)) objects[kind] = JSON.parse(fs.readFileSync(path.join(dir, "objects", "sha256", ref.sha256, `${kind}.json`)));
  return { latest, latestBytes, snapshot, snapshotBytes, objects, hash: latest.snapshot.sha256 };
}
export async function validatePublishedClosure(latestUrl, fetcher = fetch, verifier = verifySignature) {
  const errors = [];
  const get = async (url) => { const response = await fetcher(url, { cache: "no-store" }); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return Buffer.from(await response.arrayBuffer()); };
  try {
    const latestBytes = await get(latestUrl), latest = JSON.parse(latestBytes);
    if (latest.keyId !== TEST_KEY_ID) errors.push("latest: unknown keyId");
    if (!verifier(latestBytes, (await get(`${latestUrl}.sig`)).toString().trim())) errors.push("latest: invalid signature");
    const snapshotBytes = await get(latest.snapshot.url), snapshot = JSON.parse(snapshotBytes);
    if (snapshot.keyId !== TEST_KEY_ID) errors.push("snapshot: unknown keyId");
    if (latest.snapshot.size !== snapshotBytes.length || latest.snapshot.sha256 !== sha256Bytes(snapshotBytes)) errors.push("snapshot: size/hash mismatch");
    if (!verifier(snapshotBytes, (await get(`${latest.snapshot.url}.sig`)).toString().trim())) errors.push("snapshot: invalid signature");
    const objects = {};
    for (const [kind, ref] of Object.entries(snapshot.blobs ?? {})) {
      const bytes = await get(ref.url); objects[kind] = JSON.parse(bytes);
      if (ref.size !== bytes.length || ref.sha256 !== sha256Bytes(bytes)) errors.push(`${kind}: size/hash mismatch`);
      if (!verifier(bytes, (await get(`${ref.url}.sig`)).toString().trim())) errors.push(`${kind}: invalid signature`);
    }
    for (const channel of objects.catalog?.channels ?? []) for (const release of channel.releases ?? []) for (const artifact of Object.values(release.artifacts ?? {})) {
      const bytes = await get(artifact.url);
      if (artifact.size !== bytes.length || artifact.sha256 !== sha256Bytes(bytes)) errors.push(`${channel.id}@${release.version}: release artifact size/hash mismatch`);
      if (!verifier(bytes, artifact.signature)) errors.push(`${channel.id}@${release.version}: invalid artifact signature`);
    }
  } catch (error) { errors.push(error.message); }
  return errors;
}

export function validateRegistry(dir, verifier = verifySignature) {
  const errors = []; let loaded;
  try { loaded = loadRegistry(dir); } catch (e) { return [`registry: ${e.message}`]; }
  const check = (bytes, sigFile, hash, at) => { if (sha256Bytes(bytes) !== hash) errors.push(`${at}: content hash mismatch`); try { if (!verifier(bytes, fs.readFileSync(sigFile, "utf8").trim())) errors.push(`${at}: invalid signature`); } catch (e) { errors.push(`${at}: ${e.message}`); } };
  if (loaded.latest.schemaVersion !== 1 || loaded.latest.testOnly !== true || loaded.latest.keyId !== TEST_KEY_ID) errors.push("latest: invalid TEST ONLY signing key");
  check(loaded.latestBytes, path.join(dir, "latest.json.sig"), sha256Bytes(loaded.latestBytes), "latest");
  if (loaded.latest.snapshot.size !== loaded.snapshotBytes.length) errors.push("snapshot: size mismatch");
  check(loaded.snapshotBytes, path.join(dir, "snapshots", "sha256", loaded.hash, "snapshot.json.sig"), loaded.hash, "snapshot");
  if (loaded.snapshot.testOnly !== true || loaded.snapshot.schemaVersion !== 1 || loaded.snapshot.keyId !== TEST_KEY_ID) errors.push("snapshot: invalid TEST ONLY signing key");
  for (const [kind, ref] of Object.entries(loaded.snapshot.blobs ?? {})) {
    const file = path.join(dir, "objects", "sha256", ref.sha256, `${kind}.json`); let bytes;
    try { bytes = fs.readFileSync(file); if (ref.size !== bytes.length) errors.push(`${kind}: size mismatch`); check(bytes, `${file}.sig`, ref.sha256, kind); } catch (e) { errors.push(`${kind}: ${e.message}`); }
  }
  errors.push(...validateCatalog(loaded.objects.catalog));
  return errors;
}
